// PelakaVoice audio engine: anti-bleed noise gate + voice effects (AudioWorklet), per-user volume up to 200%,
// output device selection, mic test monitor, UI sounds
const FX_MODES = { normal: 0, robot: 1, chipmunk: 2, deep: 3, radio: 4, cave: 5 };

class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.rawStream = null;
    this.processedStream = null;
    this.sourceNode = null;
    this.hpNode = null;
    this.gateNode = null;
    this.fxNode = null;
    this.destNode = null;
    this.monitorGain = null;
    this.workletReady = null;
    this.fbTimer = null;
    this.fbState = null;
    this.idleTimer = null;

    this.threshold = 0.35; // 0..1 on a -60..0 dBFS scale
    this.metering = false;
    this.monitoring = false;
    this.pushToTalkEnabled = false;
    this.isPttPressed = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.isSpeaking = false;
    this.effect = localStorage.getItem('pv_fx') || 'normal';
    this.noiseSuppression = localStorage.getItem('pv_ns') !== '0';
    this.echoCancellation = localStorage.getItem('pv_ec') !== '0';
    this.sinkId = localStorage.getItem('pv_out') || '';

    this.onVolumeChange = null;   // (level 0..1)
    this.onSpeakingChange = null; // (boolean)
    this.onDeafenChange = null;   // (boolean) used to mute stream audio too

    this.peers = new Map(); // peerId -> { audio, volume, stream, boost }
    this.ringInterval = null;
  }

  // ---------- context ----------
  getAudioContext() {
    if (!this.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx({ latencyHint: 'interactive' });
      if (this.sinkId && this.audioCtx.setSinkId) this.audioCtx.setSinkId(this.sinkId).catch(() => {});
    }
    clearTimeout(this.idleTimer);
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  // Suspend the audio thread when nothing needs it (saves CPU while idle)
  _idle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      let boosted = false;
      this.peers.forEach(p => { if (p.boost) boosted = true; });
      if (this.audioCtx && !this.rawStream && !this.ringInterval && !boosted && this.audioCtx.state === 'running') {
        this.audioCtx.suspend();
      }
    }, 1500);
  }

  // ---------- UI sounds ----------
  playTone(freqs, type = 'sine', duration = 0.1, volume = 0.14) {
    try {
      const ctx = this.getAudioContext();
      const start = ctx.currentTime + 0.01;
      freqs.forEach((freq, i) => {
        const t = start + i * duration * 0.75;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + duration);
      });
      this._idle();
    } catch (e) {}
  }

  playJoinSound() { this.playTone([480, 720], 'sine', 0.08, 0.15); }
  playLeaveSound() { this.playTone([720, 480], 'sine', 0.08, 0.12); }
  playMuteSound() { this.playTone([380, 260], 'triangle', 0.05, 0.15); }
  playUnmuteSound() { this.playTone([260, 420], 'triangle', 0.05, 0.15); }
  playMessageSound() { this.playTone([988, 1319], 'sine', 0.09, 0.08); }
  playMentionSound() { this.playTone([784, 1175, 1568], 'sine', 0.08, 0.1); }
  playPopSound() { this.playTone([660], 'triangle', 0.05, 0.06); }

  startIncomingRingtone() {
    this.stopIncomingRingtone();
    const ring = () => this.playTone([600, 900], 'sine', 0.12, 0.2);
    ring();
    this.ringInterval = setInterval(ring, 2000);
  }

  stopIncomingRingtone() {
    if (this.ringInterval) {
      clearInterval(this.ringInterval);
      this.ringInterval = null;
      this._idle();
    }
  }

  // ---------- microphone: source -> highpass -> gate -> effects -> WebRTC ----------
  _toRms(norm) { return Math.pow(10, (norm * 60 - 60) / 20); }
  _toNorm(rms) { return Math.max(0, Math.min(1, (20 * Math.log10(rms || 1e-6) + 60) / 60)); }

  async initLocalMicrophone(deviceId = null) {
    this._teardownInput();
    const audio = {
      echoCancellation: this.echoCancellation,
      noiseSuppression: this.noiseSuppression,
      autoGainControl: false,
      channelCount: 1
    };
    if (deviceId) audio.deviceId = { exact: deviceId };

    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const ctx = this.getAudioContext();
    this.rawStream = stream;
    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.hpNode = ctx.createBiquadFilter(); // removes desk rumble
    this.hpNode.type = 'highpass';
    this.hpNode.frequency.value = 80;
    this.destNode = ctx.createMediaStreamDestination();
    this.destNode.channelCount = 1;
    this.sourceNode.connect(this.hpNode);

    let tail;
    try {
      if (!this.workletReady) this.workletReady = ctx.audioWorklet.addModule('gate-worklet.js');
      await this.workletReady;
      const opts = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' };
      this.gateNode = new AudioWorkletNode(ctx, 'pelaka-gate', opts);
      this.gateNode.port.onmessage = (e) => this._onGate(e.data);
      this.fxNode = new AudioWorkletNode(ctx, 'pelaka-fx', opts);
      this.fxNode.port.postMessage({ mode: FX_MODES[this.effect] || 0 });
      this.hpNode.connect(this.gateNode);
      this.gateNode.connect(this.fxNode);
      tail = this.fxNode;
    } catch (err) {
      console.warn('[AudioEngine] AudioWorklet unavailable, using fallback gate:', err);
      this.workletReady = null;
      tail = this._fallbackGate(ctx);
    }
    tail.connect(this.destNode);
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = this.monitoring ? 1 : 0;
    tail.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination);

    this._pushGate();
    stream.getAudioTracks().forEach(t => { t.enabled = !this.isMuted; });
    this.processedStream = this.destNode.stream;
    return this.processedStream;
  }

  // Only used if the worklet cannot load
  _fallbackGate(ctx) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    this.hpNode.connect(analyser);
    this.hpNode.connect(gain);
    this.gateNode = gain;
    const buf = new Float32Array(analyser.fftSize);
    let hold = 0;
    this.fbTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const f = this.fbState || { th: 1, force: 0, meter: false };
      hold = f.force === 1 || (f.force === 0 && rms >= f.th) ? 6 : (f.force === -1 ? 0 : Math.max(0, hold - 1));
      const open = hold > 0;
      gain.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, open ? 0.008 : 0.08);
      this._onGate(f.meter ? { open, level: rms } : { open });
    }, 40);
    return gain;
  }

  _onGate(d) {
    if (d.open !== undefined && d.open !== this.isSpeaking) {
      this.isSpeaking = d.open;
      if (this.onSpeakingChange) this.onSpeakingChange(d.open);
    }
    if (d.level !== undefined && this.onVolumeChange) this.onVolumeChange(this._toNorm(d.level));
  }

  _pushGate() {
    const msg = {
      th: this._toRms(this.threshold),
      force: this.isMuted ? -1 : (this.pushToTalkEnabled ? (this.isPttPressed ? 1 : -1) : 0),
      meter: this.metering
    };
    this.fbState = msg;
    if (this.gateNode && this.gateNode.port) this.gateNode.port.postMessage(msg);
  }

  _teardownInput() {
    if (this.fbTimer) { clearInterval(this.fbTimer); this.fbTimer = null; }
    for (const node of [this.sourceNode, this.hpNode, this.gateNode, this.fxNode, this.monitorGain]) {
      if (node) { try { node.disconnect(); } catch (e) {} }
    }
    if (this.gateNode && this.gateNode.port) this.gateNode.port.onmessage = null;
    if (this.rawStream) this.rawStream.getTracks().forEach(t => t.stop());
    this.sourceNode = this.hpNode = this.gateNode = this.fxNode = this.destNode = this.monitorGain = this.rawStream = null;
  }

  hasMic() { return !!this.rawStream; }

  setGateThreshold(norm) { this.threshold = Math.max(0.02, Math.min(norm, 0.95)); this._pushGate(); }
  setMetering(on) { this.metering = !!on; this._pushGate(); }
  setPushToTalk(enabled) { this.pushToTalkEnabled = !!enabled; this._pushGate(); }
  setPttPressed(pressed) { this.isPttPressed = !!pressed; this._pushGate(); }

  setEffect(name) {
    this.effect = FX_MODES[name] !== undefined ? name : 'normal';
    localStorage.setItem('pv_fx', this.effect);
    if (this.fxNode) this.fxNode.port.postMessage({ mode: FX_MODES[this.effect] });
  }

  // Hear yourself (mic test / trying voice effects)
  setMonitor(on) {
    this.monitoring = !!on;
    if (this.monitorGain) this.monitorGain.gain.setTargetAtTime(this.monitoring ? 1 : 0, this.audioCtx.currentTime, 0.02);
  }

  setProcessing({ noiseSuppression, echoCancellation }) {
    if (noiseSuppression !== undefined) { this.noiseSuppression = !!noiseSuppression; localStorage.setItem('pv_ns', this.noiseSuppression ? '1' : '0'); }
    if (echoCancellation !== undefined) { this.echoCancellation = !!echoCancellation; localStorage.setItem('pv_ec', this.echoCancellation ? '1' : '0'); }
  }

  async setOutputDevice(id) {
    this.sinkId = id || '';
    localStorage.setItem('pv_out', this.sinkId);
    const jobs = [];
    this.peers.forEach(p => { if (p.audio && p.audio.setSinkId) jobs.push(p.audio.setSinkId(this.sinkId).catch(() => {})); });
    if (this.audioCtx && this.audioCtx.setSinkId) jobs.push(this.audioCtx.setSinkId(this.sinkId).catch(() => {}));
    await Promise.all(jobs);
  }

  setMute(muted) {
    this.isMuted = !!muted;
    if (this.rawStream) this.rawStream.getAudioTracks().forEach(t => { t.enabled = !this.isMuted; });
    this._pushGate();
    if (this.isMuted && this.isSpeaking) {
      this.isSpeaking = false;
      if (this.onSpeakingChange) this.onSpeakingChange(false);
    }
    if (this.isMuted) this.playMuteSound();
    else this.playUnmuteSound();
    return this.isMuted;
  }

  toggleMute() { return this.setMute(!this.isMuted); }

  setDeafened(deafened) {
    this.isDeafened = !!deafened;
    this.peers.forEach(p => this._applyPeer(p));
    if (this.onDeafenChange) this.onDeafenChange(this.isDeafened);
    if (this.isDeafened) this.setMute(true);
    return this.isDeafened;
  }

  toggleDeafen() { return this.setDeafened(!this.isDeafened); }

  // ---------- remote peers ----------
  // Up to 100%: plain <audio> element (keeps Chrome's echo cancellation reference).
  // Above 100%: the element stays muted (it still pulls the WebRTC track) and a Web Audio gain boosts it.
  _applyPeer(p) {
    if (!p.audio) return;
    const boost = p.volume > 1.001 && !!p.stream;
    if (boost) {
      const ctx = this.getAudioContext();
      if (!p.boost || p.boost.stream !== p.stream) {
        this._dropBoost(p);
        const src = ctx.createMediaStreamSource(p.stream);
        const gain = ctx.createGain();
        src.connect(gain);
        gain.connect(ctx.destination);
        p.boost = { src, gain, stream: p.stream };
      }
      p.boost.gain.gain.value = this.isDeafened ? 0 : Math.min(p.volume, 2);
      p.audio.muted = true;
    } else {
      this._dropBoost(p);
      p.audio.muted = this.isDeafened;
      p.audio.volume = Math.min(Math.max(p.volume, 0), 1);
    }
  }

  _dropBoost(p) {
    if (!p.boost) return;
    try { p.boost.src.disconnect(); p.boost.gain.disconnect(); } catch (e) {}
    p.boost = null;
    this._idle();
  }

  attachPeerStream(peerId, stream) {
    let peer = this.peers.get(peerId);
    if (!peer || !peer.audio) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.id = `peer-audio-${peerId}`;
      if (this.sinkId && audio.setSinkId) audio.setSinkId(this.sinkId).catch(() => {});
      document.body.appendChild(audio);
      peer = { audio, volume: peer ? peer.volume : 1.0, stream: null, boost: null };
      this.peers.set(peerId, peer);
    }
    if (peer.audio.srcObject !== stream) peer.audio.srcObject = stream;
    peer.stream = stream;
    this._applyPeer(peer);
    peer.audio.play().catch(() => {});
    return peer.audio;
  }

  setPeerVolume(peerId, volume) {
    const v = Math.max(0, Math.min(2, volume));
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.volume = v;
      this._applyPeer(peer);
    } else {
      this.peers.set(peerId, { audio: null, volume: v, stream: null, boost: null });
    }
  }

  getPeerVolume(peerId) {
    const peer = this.peers.get(peerId);
    return peer ? peer.volume : 1.0;
  }

  removePeerStream(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      this._dropBoost(peer);
      if (peer.audio) {
        peer.audio.pause();
        peer.audio.srcObject = null;
        peer.audio.remove();
      }
    }
    this.peers.delete(peerId);
  }

  cleanupAllPeerStreams() {
    Array.from(this.peers.keys()).forEach(id => this.removePeerStream(id));
  }

  stopLocalStream() {
    this._teardownInput();
    this.processedStream = null;
    if (this.isSpeaking) {
      this.isSpeaking = false;
      if (this.onSpeakingChange) this.onSpeakingChange(false);
    }
    this.cleanupAllPeerStreams();
    this._idle();
  }
}

window.AudioEngine = AudioEngine;
