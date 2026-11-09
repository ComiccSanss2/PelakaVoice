// PelakaVoice WebRTC mesh: perfect negotiation, ICE restart, adaptive 1080p / 60 fps streams with audio.
// A stream is only sent to the people who chose to watch it (saves upload bandwidth).
(function () {
  const DEFAULT_SCREEN = { w: 1920, h: 1080, fps: 60, bitrate: 8000000, hint: 'motion' };
  const UPLINK_BUDGET = 24000000; // shared between everyone watching our screen

  // Step-down ladder applied per viewer when their ping / packet loss is high or our encoder is CPU-bound.
  // Changes go through setParameters: no renegotiation, no freeze.
  const LEVELS = [
    { br: 1, fps: 1, scale: 1 },
    { br: 0.65, fps: 1, scale: 1 },
    { br: 0.45, fps: 0.5, scale: 1 },
    { br: 0.3, fps: 0.5, scale: 1.5 },
    { br: 0.18, fps: 0.34, scale: 2 }
  ];

  // H.264 first: hardware encode/decode on almost every Windows GPU = smooth 60 fps with low CPU,
  // which matters in a mesh where the sharer encodes once per viewer.
  function codecRank(c) {
    const m = c.mimeType.toLowerCase();
    if (m === 'video/h264') return /packetization-mode=1/.test(c.sdpFmtpLine || '') ? 0 : 1;
    if (m === 'video/vp8') return 2;
    if (m === 'video/vp9') return 3;
    if (m === 'video/av1') return 4;
    return 5; // rtx / red / ulpfec keep their relative order
  }

  class WebRTCManager {
    constructor(socket, audioEngine) {
      this.socket = socket;
      this.audioEngine = audioEngine;
      this.peers = new Map(); // peerId -> peer state
      this.localAudioStream = null;
      this.localScreenStream = null;
      this.screenProfile = null;
      this.outTag = new MediaStream(); // stable stream id for our audio (older peers read event.streams[0])
      this.monitor = null;
      this.ticking = false;
      this.wantWatch = new Set(); // viewers who asked to watch before their connection existed

      this.iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ];

      this.onPeerStreamAdded = null;
      this.onPeerStreamRemoved = null;
      this.onRemoteScreenAdded = null;
      this.onRemoteScreenRemoved = null;
      this.onScreenStats = null; // (peerId, { w, h, fps, rtt })

      socket.on('webrtc_signal', (msg) => this._handleSignal(msg || {}));
    }

    setIceServers(extra) {
      if (Array.isArray(extra) && extra.length) this.iceServers = this.iceServers.slice(0, 2).concat(extra);
    }

    // Can be called at any time: live connections switch microphone without renegotiating
    setLocalStream(stream) {
      this.localAudioStream = stream;
      this.peers.forEach(p => this._syncAudio(p, false));
    }

    _send(target, type, payload) {
      this.socket.emit('webrtc_signal', { target, type, payload });
    }

    // ---------- tracks ----------
    _syncAudio(p, create) {
      const track = this.localAudioStream ? (this.localAudioStream.getAudioTracks()[0] || null) : null;
      try {
        if (!p.audioTx) {
          const found = p.pc.getTransceivers().find(t => !t.stopped && t.receiver.track && t.receiver.track.kind === 'audio');
          if (found) {
            p.audioTx = found;
            if (found.sender.setStreams) found.sender.setStreams(this.outTag);
          } else if (create) {
            p.audioTx = p.pc.addTransceiver('audio', { direction: 'sendrecv', streams: [this.outTag] });
          } else {
            return;
          }
        }
        const tx = p.audioTx;
        if (tx.direction !== 'sendrecv') tx.direction = 'sendrecv';
        if (tx.sender.track !== track) tx.sender.replaceTrack(track).catch(() => {});
      } catch (e) {
        console.warn('[WebRTC] audio sync failed:', e);
      }
    }

    // Voice must stay clear even while a 1080p60 stream saturates the link
    _prioritizeAudio(p) {
      const sender = p.audioTx && p.audioTx.sender;
      if (!sender || p.audioPrioritized) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) return;
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        p.audioPrioritized = true;
        sender.setParameters(params).catch(() => { p.audioPrioritized = false; });
      } catch (e) {}
    }

    _syncScreen(p) {
      const stream = this.localScreenStream;
      const track = stream ? stream.getVideoTracks()[0] : null;
      const audio = stream ? stream.getAudioTracks()[0] : null;
      try {
        if (track && !p.videoSender) {
          p.videoSender = p.pc.addTrack(track, stream);
          if (audio) p.streamAudioSender = p.pc.addTrack(audio, stream);
          p.level = 0;
          p.badRuns = 0;
          p.goodRuns = 0;
          this._tuneVideo(p);
        } else if (!track && p.videoSender) {
          p.pc.removeTrack(p.videoSender);
          p.videoSender = null;
          if (p.streamAudioSender) { p.pc.removeTrack(p.streamAudioSender); p.streamAudioSender = null; }
        }
      } catch (e) {
        console.warn('[WebRTC] screen sync failed:', e);
      }
    }

    // Viewer asked us to start/stop sending our stream to them
    setPeerWatching(peerId, on) {
      if (on) this.wantWatch.add(peerId);
      else this.wantWatch.delete(peerId);
      const p = this.peers.get(peerId);
      if (!p) return;
      p.watching = !!on;
      this._tuneVideo(p);
    }

    watchers() {
      let n = 0;
      this.peers.forEach(p => { if (p.watching) n++; });
      return n;
    }

    _preferCodecs(pc) {
      try {
        if (!window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
        const caps = RTCRtpReceiver.getCapabilities('video');
        if (!caps || !caps.codecs) return;
        const codecs = caps.codecs.slice().sort((a, b) => codecRank(a) - codecRank(b));
        pc.getTransceivers().forEach(t => {
          if (t.stopped || !t.setCodecPreferences) return;
          const kind = (t.sender.track && t.sender.track.kind) || (t.receiver.track && t.receiver.track.kind);
          if (kind === 'video') {
            try { t.setCodecPreferences(codecs); } catch (e) {}
          }
        });
      } catch (e) {}
    }

    _viewers() {
      let n = 0;
      this.peers.forEach(p => { if (p.videoSender && p.watching) n++; });
      return n;
    }

    _tuneVideo(p) {
      const prof = this.screenProfile;
      if (!p.videoSender || !prof) return;
      const lvl = LEVELS[p.level || 0];
      const ceiling = Math.min(prof.bitrate, Math.max(2500000, Math.round(UPLINK_BUDGET / Math.max(1, this._viewers()))));
      try {
        const params = p.videoSender.getParameters();
        if (!params.encodings || !params.encodings.length) return;
        const e = params.encodings[0];
        e.active = !!p.watching;
        e.maxBitrate = Math.round(ceiling * lvl.br);
        e.maxFramerate = Math.max(15, Math.round(prof.fps * lvl.fps));
        e.scaleResolutionDownBy = lvl.scale;
        p.videoSender.setParameters(params).catch(() => {});
      } catch (e) {}
      if (p.streamAudioSender) {
        try {
          const ap = p.streamAudioSender.getParameters();
          if (ap.encodings && ap.encodings.length && ap.encodings[0].active !== !!p.watching) {
            ap.encodings[0].active = !!p.watching;
            ap.encodings[0].maxBitrate = 128000;
            p.streamAudioSender.setParameters(ap).catch(() => {});
          }
        } catch (e) {}
      }
    }

    _tuneAllVideo() {
      this.peers.forEach(p => this._tuneVideo(p));
    }

    // ---------- connections ----------
    _peer(peerId, initiator) {
      let p = this.peers.get(peerId);
      if (p) return p;

      const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 1, bundlePolicy: 'max-bundle' });
      p = {
        pc, polite: String(this.socket.id) > String(peerId), makingOffer: false, ignoreOffer: false,
        pending: [], audioTx: null, videoSender: null, streamAudioSender: null, watching: this.wantWatch.has(peerId),
        videoReceiver: null, screenVisible: false,
        restarts: 0, timer: null, level: 0, badRuns: 0, goodRuns: 0, jbTarget: 0, audioPrioritized: false
      };
      this.peers.set(peerId, p);

      pc.onicecandidate = (e) => {
        if (e.candidate) this._send(peerId, 'candidate', e.candidate.toJSON());
      };

      pc.onnegotiationneeded = async () => {
        try {
          p.makingOffer = true;
          this._preferCodecs(pc);
          await pc.setLocalDescription();
          this._send(peerId, 'offer', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
        } catch (e) {
          console.warn('[WebRTC] offer failed:', e);
        } finally {
          p.makingOffer = false;
        }
      };

      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        if (e.track.kind === 'audio') {
          // The first audio m-line is always the voice; any other audio belongs to a stream and is
          // played by the stream's own <video> element (separate volume, never mixed with voices)
          const voiceTx = pc.getTransceivers().find(t => t.receiver.track && t.receiver.track.kind === 'audio');
          if (voiceTx && e.transceiver !== voiceTx) return;
          this.audioEngine.attachPeerStream(peerId, stream);
          if (this.onPeerStreamAdded) this.onPeerStreamAdded(peerId, stream);
          return;
        }
        // Screen share: a removed track only "mutes" on the receiving side, so follow mute/unmute
        p.videoReceiver = e.receiver;
        const show = () => {
          p.screenVisible = true;
          this._startMonitor();
          if (this.onRemoteScreenAdded) this.onRemoteScreenAdded(peerId, stream);
        };
        const hide = () => {
          p.screenVisible = false;
          if (this.onRemoteScreenRemoved) this.onRemoteScreenRemoved(peerId);
          this._maybeStopMonitor();
        };
        e.track.onunmute = show;
        e.track.onmute = hide;
        e.track.onended = hide;
        if (!e.track.muted) show();
      };

      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        clearTimeout(p.timer);
        if (s === 'connected' || s === 'completed') {
          p.restarts = 0;
          this._prioritizeAudio(p);
          this._tuneVideo(p);
        } else if (s === 'disconnected') {
          p.timer = setTimeout(() => this._restart(peerId), 3500);
        } else if (s === 'failed') {
          this._restart(peerId);
        }
      };

      if (initiator) {
        this._syncAudio(p, true); // creates the audio transceiver -> fires negotiationneeded
        this._syncScreen(p);
      }
      return p;
    }

    _restart(peerId) {
      const p = this.peers.get(peerId);
      if (!p) return;
      if (p.restarts++ >= 3) return this.closePeer(peerId);
      try { p.pc.restartIce(); } catch (e) { this.closePeer(peerId); }
    }

    callPeer(peerId) {
      this._peer(peerId, true);
    }

    async _handleSignal({ sender, type, payload }) {
      if (!sender || !payload) return;
      try {
        if (type === 'candidate') {
          const p = this.peers.get(sender);
          if (!p) return;
          if (!p.pc.remoteDescription) { p.pending.push(payload); return; }
          try { await p.pc.addIceCandidate(payload); } catch (e) { if (!p.ignoreOffer) console.warn('[WebRTC] candidate:', e); }
          return;
        }
        if (type !== 'offer' && type !== 'answer') return;

        const isOffer = type === 'offer';
        const p = isOffer ? this._peer(sender, false) : this.peers.get(sender);
        if (!p) return;
        const pc = p.pc;

        if (isOffer) {
          const collision = p.makingOffer || pc.signalingState !== 'stable';
          p.ignoreOffer = !p.polite && collision;
          if (p.ignoreOffer) return;
        } else if (pc.signalingState !== 'have-local-offer') {
          return;
        }

        await pc.setRemoteDescription(payload); // polite side rolls back automatically on collision
        if (!isOffer) this._tuneVideo(p);
        for (const c of p.pending.splice(0)) {
          try { await pc.addIceCandidate(c); } catch (e) {}
        }

        if (isOffer) {
          this._syncAudio(p, false);
          const hadVideo = !!p.videoSender;
          this._syncScreen(p);
          this._preferCodecs(pc);
          await pc.setLocalDescription();
          this._send(sender, 'answer', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
          if (!p.audioTx) this._syncAudio(p, true);
          if (!hadVideo && p.videoSender) this._tuneAllVideo();
          else this._tuneVideo(p);
        }
      } catch (err) {
        console.error('[WebRTC] signal error:', err);
      }
    }

    // ---------- screen sharing ----------
    async startScreenShare(screenStream, profile) {
      this.screenProfile = Object.assign({}, DEFAULT_SCREEN, profile || {});
      this.localScreenStream = screenStream;
      const track = screenStream.getVideoTracks()[0];
      if (track) { try { track.contentHint = this.screenProfile.hint; } catch (e) {} }
      this.peers.forEach(p => this._syncScreen(p));
      this._tuneAllVideo();
      this._startMonitor();
    }

    async stopScreenShare() {
      if (!this.localScreenStream) return;
      const stream = this.localScreenStream;
      this.localScreenStream = null;
      this.screenProfile = null;
      this.peers.forEach(p => this._syncScreen(p));
      stream.getTracks().forEach(t => t.stop());
      this._maybeStopMonitor();
    }

    // ---------- quality monitor (runs only while sharing or watching a screen) ----------
    _startMonitor() {
      if (!this.monitor) this.monitor = setInterval(() => this._monitorTick(), 2000);
    }

    _maybeStopMonitor() {
      if (!this.monitor || this.localScreenStream) return;
      for (const p of this.peers.values()) if (p.screenVisible) return;
      clearInterval(this.monitor);
      this.monitor = null;
    }

    async _monitorTick() {
      if (this.ticking) return;
      this.ticking = true;
      try {
        for (const [peerId, p] of Array.from(this.peers)) {
          try {
            if (p.videoSender && this.screenProfile) await this._adaptSender(p);
            if (p.screenVisible && p.videoReceiver) await this._adaptReceiver(peerId, p);
          } catch (e) {}
        }
      } finally {
        this.ticking = false;
      }
    }

    // Sender: step quality down fast when a viewer struggles, back up slowly when it recovers
    async _adaptSender(p) {
      const stats = await p.videoSender.getStats();
      let rtt = null, loss = null, cpu = false;
      stats.forEach(s => {
        if (s.type === 'remote-inbound-rtp' && s.kind === 'video') {
          if (s.roundTripTime != null) rtt = s.roundTripTime;
          if (s.fractionLost != null) loss = s.fractionLost;
        } else if (s.type === 'outbound-rtp' && s.kind === 'video') {
          cpu = s.qualityLimitationReason === 'cpu';
        } else if (s.type === 'candidate-pair' && s.nominated && rtt == null && s.currentRoundTripTime != null) {
          rtt = s.currentRoundTripTime;
        }
      });
      const bad = (loss != null && loss > 0.08) || (rtt != null && rtt > 0.4) || cpu;
      const good = (loss == null || loss < 0.02) && (rtt == null || rtt < 0.25) && !cpu;
      const prev = p.level || 0;
      if (bad) {
        p.goodRuns = 0;
        if (++p.badRuns >= 2 && prev < LEVELS.length - 1) { p.level = prev + 1; p.badRuns = 0; }
      } else if (good) {
        p.badRuns = 0;
        if (++p.goodRuns >= 4 && prev > 0) { p.level = prev - 1; p.goodRuns = 0; }
      } else {
        p.badRuns = 0;
        p.goodRuns = 0;
      }
      if (p.level !== prev) this._tuneVideo(p);
    }

    // Receiver: size the jitter buffer from measured jitter + ping so playback stays smooth
    async _adaptReceiver(peerId, p) {
      const r = p.videoReceiver;
      const stats = await r.getStats();
      let jitter = 0, w = 0, h = 0, fps = 0, rtt = null;
      stats.forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          jitter = s.jitter || 0;
          w = s.frameWidth || 0;
          h = s.frameHeight || 0;
          fps = s.framesPerSecond || 0;
        } else if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) {
          rtt = s.currentRoundTripTime;
        }
      });
      const rttMs = rtt != null ? rtt * 1000 : 0;
      if ('jitterBufferTarget' in r) {
        const target = Math.round(Math.min(300, Math.max(40, jitter * 1000 * 3 + rttMs * 0.3)));
        if (Math.abs(p.jbTarget - target) > 15) {
          p.jbTarget = target;
          try { r.jitterBufferTarget = target; } catch (e) {}
        }
      }
      if (this.onScreenStats) this.onScreenStats(peerId, { w, h, fps: Math.round(fps), rtt: Math.round(rttMs) });
    }

    // ---------- teardown ----------
    closePeer(peerId) {
      const p = this.peers.get(peerId);
      if (p) {
        clearTimeout(p.timer);
        const pc = p.pc;
        pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.oniceconnectionstatechange = null;
        try { pc.close(); } catch (e) {}
        this.peers.delete(peerId);
      }
      this.wantWatch.delete(peerId);
      this.audioEngine.removePeerStream(peerId);
      if (this.onPeerStreamRemoved) this.onPeerStreamRemoved(peerId);
      if (this.onRemoteScreenRemoved) this.onRemoteScreenRemoved(peerId);
      if (p && p.videoSender) this._tuneAllVideo(); // fewer viewers -> more bandwidth for the others
      this._maybeStopMonitor();
    }

    closeAll(keepLocal = false) {
      Array.from(this.peers.keys()).forEach(id => this.closePeer(id));
      if (keepLocal) return;
      if (this.localScreenStream) {
        this.localScreenStream.getTracks().forEach(t => t.stop());
        this.localScreenStream = null;
      }
      this.screenProfile = null;
      this.localAudioStream = null;
      if (this.monitor) { clearInterval(this.monitor); this.monitor = null; }
    }
  }

  window.WebRTCManager = WebRTCManager;
})();
