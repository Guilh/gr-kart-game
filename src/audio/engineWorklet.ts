// AudioWorklet source for a physically-inspired single-cylinder four-stroke.
// One combustion pulse every two crank revolutions excites a small bank of
// resonators (muffler body, exhaust pipe, intake) → soft saturation → DC block.
// Cycle-to-cycle variation, spark-cut limiter and overrun pops keep it alive.

export const ENGINE_WORKLET = /* js */ `
class Biquad {
  constructor() { this.b0 = 0; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  bandpass(fc, q, sr) {
    const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0; this.b1 = 0; this.b2 = -alpha / a0;
    this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - alpha) / a0;
  }
  lowpass(fc, q, sr) {
    const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cs = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 - cs) / 2 / a0; this.b1 = (1 - cs) / a0; this.b2 = (1 - cs) / 2 / a0;
    this.a1 = -2 * cs / a0; this.a2 = (1 - alpha) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class KartEngine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 1750, minValue: 0, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0.5, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      { name: 'limiter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.phase = Math.random();
    this.env = 0;
    this.intake = 0;
    this.seed = (Math.random() * 4294967295) >>> 0;
    this.rpm = 1750;
    this.thr = 0;
    this.muffler = new Biquad();
    this.pipe = new Biquad();
    this.air = new Biquad();
    this.lp = new Biquad();
    this.dcX = 0; this.dcY = 0;
    this.pop = 0;
    this.blockCount = 0;
    // returning true from process() keeps a processor alive even once its node is dropped,
    // so the main thread sends 'stop' when it is done with a voice
    this.alive = true;
    this.port.onmessage = () => { this.alive = false; };
  }
  rand() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  fire(limiter) {
    let amp = 0.3 + 0.7 * this.thr;
    amp *= 0.82 + 0.36 * this.rand();
    if (limiter > 0.5 && this.rand() < 0.6) amp *= 0.08;
    // overrun: unburnt fuel popping in the pipe
    if (this.thr < 0.05 && this.rpm > 3300 && this.rand() < 0.07) this.pop = 1.0 + this.rand();
    this.env += amp;
    this.intake += 0.25 + 0.75 * this.thr;
  }
  process(inputs, outputs, params) {
    if (!this.alive) return false;
    const out = outputs[0][0];
    if (!out) return true;
    const sr = sampleRate;
    const targetRpm = params.rpm[0];
    const targetThr = params.throttle[0];
    const gain = params.gain[0];
    const limiter = params.limiter[0];
    const tone = params.tone[0];
    if ((this.blockCount++ & 3) === 0) {
      this.muffler.bandpass(105 + this.rpm * 0.006, 2.2, sr);
      this.pipe.bandpass(330 + this.rpm * 0.05, 3.2, sr);
      this.air.bandpass(1500 + this.rpm * 0.12, 1.4, sr);
      this.lp.lowpass(1400 + tone * 3200, 0.8, sr);
    }
    for (let i = 0; i < out.length; i++) {
      this.rpm += (targetRpm - this.rpm) * 0.0025;
      this.thr += (targetThr - this.thr) * 0.004;
      const f = this.rpm / 120; // firing frequency
      this.phase += f / sr;
      if (this.phase >= 1) { this.phase -= 1; this.fire(limiter); }
      const tau = Math.max(0.0018, 0.13 / Math.max(f, 1));
      this.env *= Math.exp(-1 / (tau * sr));
      this.intake *= Math.exp(-1 / (0.002 * sr));
      const n = this.rand() * 2 - 1;
      const pulse = this.env * (0.75 + 0.25 * n);
      const crank = Math.sin(this.phase * 4 * Math.PI) * 0.06;
      let y = this.muffler.run(pulse) * 2.6 + this.pipe.run(pulse) * 1.5 + this.air.run(this.intake * n) * (0.1 + 0.35 * this.thr) * tone + pulse * 0.35 + crank;
      if (this.pop > 0.01) {
        y += (this.rand() * 2 - 1) * this.pop * 0.9;
        this.pop *= 0.9985;
      }
      y = this.lp.run(y);
      y = Math.tanh(y * 1.6);
      // DC blocker
      const dc = y - this.dcX + 0.995 * this.dcY;
      this.dcX = y; this.dcY = dc;
      out[i] = dc * gain;
    }
    return true;
  }
}
registerProcessor('kart-engine', KartEngine);
`;
