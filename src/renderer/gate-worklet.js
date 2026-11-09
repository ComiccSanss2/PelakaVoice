// Noise gate running on the audio thread: no main-thread polling, sample-accurate attack/release.
class PelakaGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.th = 0.011;   // RMS threshold
    this.force = 0;    // 0 = automatic, 1 = always open (push-to-talk held), -1 = closed (muted)
    this.meter = false;
    this.gain = 0;
    this.hold = 0;
    this.open = false;
    this.peak = 0;
    this.count = 0;
    this.holdBlocks = Math.round((0.22 * sampleRate) / 128);
    this.meterBlocks = Math.round(sampleRate / 128 / 15);
    this.attack = 1 - Math.exp(-1 / (0.006 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.09 * sampleRate));
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.th !== undefined) this.th = d.th;
      if (d.force !== undefined) this.force = d.force;
      if (d.meter !== undefined) this.meter = d.meter;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    if (this.force === 1 || (this.force === 0 && rms >= this.th)) this.hold = this.holdBlocks;
    else if (this.force === -1) this.hold = 0;
    else if (this.hold > 0) this.hold--;

    const open = this.hold > 0;
    const target = open ? 1 : 0;
    const k = open ? this.attack : this.release;
    let g = this.gain;
    for (let i = 0; i < input.length; i++) {
      g += (target - g) * k;
      output[i] = input[i] * g;
    }
    this.gain = g < 1e-4 ? 0 : g;

    if (open !== this.open) {
      this.open = open;
      this.port.postMessage({ open });
    }
    if (this.meter) {
      if (rms > this.peak) this.peak = rms;
      if (++this.count >= this.meterBlocks) {
        this.port.postMessage({ level: this.peak });
        this.count = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('pelaka-gate', PelakaGate);

// Voice effects on the audio thread. Mode 0 is a plain copy (no cost when effects are off).
// 1 robot · 2 chipmunk · 3 deep · 4 radio · 5 cave
class PelakaFx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 0;
    this.size = 1 << 15;
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.win = Math.round(0.045 * sampleRate); // pitch shifter window
    this.d = 0;
    this.phase = 0;
    this.lp1 = 0; this.lp2 = 0; this.hp1 = 0; this.hpx = 0; this.fbLp = 0;
    this.port.onmessage = (e) => {
      if (e.data.mode !== undefined) { this.mode = e.data.mode | 0; this.buf.fill(0); this.d = 0; }
    };
  }

  read(delay) {
    const pos = this.w - delay;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i & this.mask];
    const b = this.buf[(i + 1) & this.mask];
    return a + (b - a) * f;
  }

  pitch(x, ratio) {
    this.buf[this.w & this.mask] = x;
    const W = this.win;
    this.d += 1 - ratio;
    if (this.d < 0) this.d += W;
    else if (this.d >= W) this.d -= W;
    const d2 = (this.d + W / 2) % W;
    const g1 = Math.sin((Math.PI * this.d) / W);
    const g2 = Math.sin((Math.PI * d2) / W);
    const y = this.read(this.d + 1) * g1 * g1 + this.read(d2 + 1) * g2 * g2;
    this.w++;
    return y;
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }
    const m = this.mode;
    if (m === 0) { output.set(input); return true; }
    const sr = sampleRate;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      let y = x;
      if (m === 1) { // robot: ring modulation + short metallic comb
        this.phase += (2 * Math.PI * 55) / sr;
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
        const comb = this.buf[(this.w - Math.round(0.006 * sr)) & this.mask];
        y = x * Math.sin(this.phase) * 1.6 + comb * 0.55;
        this.buf[this.w & this.mask] = y * 0.6;
        this.w++;
      } else if (m === 2) {
        y = this.pitch(x, 1.6);
      } else if (m === 3) {
        y = this.pitch(x, 0.68) * 1.15;
      } else if (m === 4) { // radio: band-pass 400-3000 Hz + saturation
        const a = 1 - Math.exp((-2 * Math.PI * 3000) / sr);
        this.lp1 += a * (x - this.lp1);
        this.lp2 += a * (this.lp1 - this.lp2);
        const k = Math.exp((-2 * Math.PI * 400) / sr);
        this.hp1 = k * (this.hp1 + this.lp2 - this.hpx);
        this.hpx = this.lp2;
        y = Math.tanh(this.hp1 * 5) * 0.45;
      } else if (m === 5) { // cave: feedback echo with darkened repeats
        const echo = this.buf[(this.w - Math.round(0.19 * sr)) & this.mask];
        this.fbLp += 0.35 * (echo - this.fbLp);
        this.buf[this.w & this.mask] = x + this.fbLp * 0.5;
        this.w++;
        y = x * 0.8 + this.fbLp * 0.65;
      }
      output[i] = y > 1 ? 1 : y < -1 ? -1 : y;
    }
    return true;
  }
}

registerProcessor('pelaka-fx', PelakaFx);
