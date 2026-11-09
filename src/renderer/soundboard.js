// Shared soundboard. Clips are cut to 5 or 10 s, encoded to Opus with WebCodecs (~40-80 KB each),
// stored on the server per lobby and decoded locally when someone plays them.
(function () {
  const SR = 48000;

  class Soundboard {
    constructor(engine) {
      this.engine = engine;
      this.raw = new Map();     // id -> Promise<ArrayBuffer> (small, kept for every sound in the lobby)
      this.decoded = new Map(); // id -> Promise<AudioBuffer> (LRU of 8 to keep RAM low)
      this.active = new Set();
      this.gain = null;
      const v = parseFloat(localStorage.getItem('pv_sb_vol'));
      this.volume = v >= 0 && v <= 1 ? v : 0.6;
    }

    static supported() {
      return typeof AudioEncoder === 'function' && typeof AudioDecoder === 'function';
    }

    _ctx() {
      const ctx = this.engine.getAudioContext();
      if (!this.gain || this.gain.context !== ctx) {
        this.gain = ctx.createGain();
        this.gain.gain.value = this.volume;
        this.gain.connect(ctx.destination);
      }
      return ctx;
    }

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      localStorage.setItem('pv_sb_vol', String(this.volume));
      if (this.gain) this.gain.gain.setTargetAtTime(this.volume, this.gain.context.currentTime, 0.03);
    }

    // ---------- upload side ----------
    async decodeFile(file) {
      return this.engine.getAudioContext().decodeAudioData(await file.arrayBuffer());
    }

    // Cuts [start, start + duration] to mono 48 kHz, short fades, Opus 64 kb/s
    async encode(buffer, start, duration) {
      const frames = Math.max(SR / 10, Math.round(duration * SR));
      const end = frames / SR;
      const off = new OfflineAudioContext(1, frames, SR);
      const src = off.createBufferSource();
      src.buffer = buffer;
      const fade = off.createGain();
      fade.gain.setValueAtTime(0, 0);
      fade.gain.linearRampToValueAtTime(1, 0.01);
      fade.gain.setValueAtTime(1, Math.max(0.02, end - 0.04));
      fade.gain.linearRampToValueAtTime(0, end);
      src.connect(fade);
      fade.connect(off.destination);
      src.start(0, start, duration);
      const pcm = (await off.startRendering()).getChannelData(0);

      let peak = 0;
      for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
      if (peak > 0.98) { const k = 0.98 / peak; for (let i = 0; i < pcm.length; i++) pcm[i] *= k; }

      const chunks = [];
      let desc = null, frameUs = 20000, failure = null;
      const enc = new AudioEncoder({
        output: (chunk, meta) => {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          chunks.push(b);
          if (chunks.length === 1 && chunk.duration) frameUs = chunk.duration;
          const d = meta && meta.decoderConfig && meta.decoderConfig.description;
          if (d && !desc) {
            desc = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
          }
        },
        error: (e) => { failure = e; }
      });
      enc.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 1, bitrate: 64000 });
      for (let i = 0; i < frames; i += 4800) {
        const n = Math.min(4800, frames - i);
        const ad = new AudioData({
          format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 1,
          timestamp: Math.round((i * 1e6) / SR), data: pcm.slice(i, i + n)
        });
        enc.encode(ad);
        ad.close();
      }
      await enc.flush();
      enc.close();
      if (failure) throw failure;

      // 'PVS1' | u32 frames | u32 frame µs | u16 descLen | desc | (u16 len | opus packet)*
      const descLen = desc ? desc.length : 0;
      let size = 14 + descLen;
      chunks.forEach(c => { size += 2 + c.length; });
      const out = new Uint8Array(size);
      const v = new DataView(out.buffer);
      out.set([0x50, 0x56, 0x53, 0x31], 0);
      v.setUint32(4, frames, true);
      v.setUint32(8, frameUs, true);
      v.setUint16(12, descLen, true);
      if (descLen) out.set(desc, 14);
      let p = 14 + descLen;
      for (const c of chunks) {
        v.setUint16(p, c.length, true);
        out.set(c, p + 2);
        p += 2 + c.length;
      }
      return out.buffer;
    }

    // ---------- playback side ----------
    async decode(ab) {
      const bytes = new Uint8Array(ab);
      const v = new DataView(ab);
      if (ab.byteLength < 14 || bytes[0] !== 0x50 || bytes[1] !== 0x56 || bytes[2] !== 0x53 || bytes[3] !== 0x31) {
        throw new Error('Bad sound data');
      }
      const frames = v.getUint32(4, true);
      const frameUs = v.getUint32(8, true) || 20000;
      const descLen = v.getUint16(12, true);
      const pcm = new Float32Array(frames);
      let w = 0, failure = null;
      const dec = new AudioDecoder({
        output: (ad) => {
          const n = ad.numberOfFrames;
          if (w < frames) {
            const tmp = new Float32Array(n);
            ad.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
            pcm.set(tmp.subarray(0, Math.min(n, frames - w)), w);
          }
          w += n;
          ad.close();
        },
        error: (e) => { failure = e; }
      });
      const cfg = { codec: 'opus', sampleRate: SR, numberOfChannels: 1 };
      if (descLen) cfg.description = bytes.slice(14, 14 + descLen);
      dec.configure(cfg);
      let p = 14 + descLen, ts = 0;
      while (p + 2 <= ab.byteLength) {
        const len = v.getUint16(p, true);
        p += 2;
        if (p + len > ab.byteLength) break;
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, duration: frameUs, data: bytes.subarray(p, p + len) }));
        p += len;
        ts += frameUs;
      }
      await dec.flush();
      dec.close();
      if (failure) throw failure;
      const buf = this._ctx().createBuffer(1, frames, SR);
      buf.copyToChannel(pcm, 0);
      return buf;
    }

    prefetch(id, fetcher) {
      if (!this.raw.has(id)) {
        const p = fetcher(id);
        p.catch(() => this.raw.delete(id));
        this.raw.set(id, p);
      }
      return this.raw.get(id);
    }

    _buffer(id, fetcher) {
      let p = this.decoded.get(id);
      if (p) {
        this.decoded.delete(id);
        this.decoded.set(id, p);
        return p;
      }
      p = this.prefetch(id, fetcher).then(ab => this.decode(ab));
      p.catch(() => this.decoded.delete(id));
      this.decoded.set(id, p);
      while (this.decoded.size > 8) this.decoded.delete(this.decoded.keys().next().value);
      return p;
    }

    async play(id, fetcher) {
      const buf = await this._buffer(id, fetcher);
      if (this.engine.isDeafened) return null;
      return this._start(buf, 0, buf.duration);
    }

    preview(buffer, start, duration) {
      return this._start(buffer, start, duration);
    }

    _start(buffer, offset, duration) {
      const ctx = this._ctx();
      if (this.active.size >= 4) { // max 4 overlapping sounds
        const oldest = this.active.values().next().value;
        this.active.delete(oldest);
        try { oldest.stop(); } catch (e) {}
      }
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.connect(this.gain);
      s.onended = () => {
        this.active.delete(s);
        s.disconnect();
        this.engine._idle();
      };
      this.active.add(s);
      s.start(0, offset, duration);
      return s;
    }

    stopAll() {
      this.active.forEach(s => { try { s.stop(); } catch (e) {} });
      this.active.clear();
    }

    retain(ids) {
      const keep = new Set(ids);
      for (const m of [this.raw, this.decoded]) {
        for (const id of Array.from(m.keys())) if (!keep.has(id)) m.delete(id);
      }
    }
  }

  window.Soundboard = Soundboard;
})();
