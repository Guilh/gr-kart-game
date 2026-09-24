import * as THREE from 'three';
import { ENGINE_WORKLET } from './engineWorklet';
import { clamp } from '../core/math';

// All audio is synthesised at runtime: engines (AudioWorklet), tyres, wind,
// kerbs, grass, impacts, crowd, start beeps and UI clicks.

export class EngineVoice {
  node: AudioWorkletNode;
  out: GainNode;
  panner: PannerNode | null;
  constructor(private ctx: AudioContext, dest: AudioNode, spatial: boolean) {
    this.node = new AudioWorkletNode(ctx, 'kart-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.node.connect(this.out);
    if (spatial) {
      this.panner = new PannerNode(ctx, {
        panningModel: 'equalpower',
        distanceModel: 'inverse',
        refDistance: 3.5,
        maxDistance: 400,
        rolloffFactor: 1.3,
      });
      this.out.connect(this.panner).connect(dest);
    } else {
      this.panner = null;
      this.out.connect(dest);
    }
  }
  private p(name: string) {
    return this.node.parameters.get(name)!;
  }
  set(rpm: number, throttle: number, limiter: boolean, gain: number, tone = 1) {
    const t = this.ctx.currentTime;
    this.p('rpm').setTargetAtTime(rpm, t, 0.02);
    this.p('throttle').setTargetAtTime(throttle, t, 0.02);
    this.p('limiter').setValueAtTime(limiter ? 1 : 0, t);
    this.p('tone').setTargetAtTime(tone, t, 0.05);
    this.out.gain.setTargetAtTime(gain, t, 0.05);
  }
  position(x: number, y: number, z: number) {
    if (!this.panner) return;
    const t = this.ctx.currentTime;
    this.panner.positionX.setTargetAtTime(x, t, 0.02);
    this.panner.positionY.setTargetAtTime(y, t, 0.02);
    this.panner.positionZ.setTargetAtTime(z, t, 0.02);
  }
  /** Hand the voice to a different kart: drop to silence and jump to the new position so it fades in there. */
  handover(x: number, y: number, z: number) {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(0, t);
    if (!this.panner) return;
    for (const [p, v] of [[this.panner.positionX, x], [this.panner.positionY, y], [this.panner.positionZ, z]] as const) {
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    }
  }
  dispose() {
    this.node.port.postMessage('stop');
    this.node.disconnect();
    this.out.disconnect();
    this.panner?.disconnect();
  }
}

interface LoopVoice {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  engines!: GainNode;
  ready = false;
  muted = false;
  volume = 0.8;
  private noise!: AudioBuffer;
  private thud!: AudioBuffer;
  private squeal!: LoopVoice;
  private wind!: LoopVoice;
  private grass!: LoopVoice;
  private crowd!: LoopVoice;
  private crowdPanner!: PannerNode;
  private kerbOsc!: OscillatorNode;
  private kerbGain!: GainNode;
  private squealOsc!: OscillatorNode;
  private squealOscGain!: GainNode;
  private initPromise: Promise<void> | null = null;
  private suspendedForBackground = false;

  /** Must be called from a user gesture. */
  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit() {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const blob = new Blob([ENGINE_WORKLET], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } catch (e) {
      console.warn('AudioWorklet unavailable', e);
      return;
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.engines = ctx.createGain();
    this.engines.gain.value = 0.9;
    this.engines.connect(this.master);

    // Shared noise buffer
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w; // a little pink-ish body
      d[i] = w * 0.6 + b * 2.2;
    }
    // Impact thud buffer
    const tl = Math.floor(ctx.sampleRate * 0.5);
    this.thud = ctx.createBuffer(1, tl, ctx.sampleRate);
    const td = this.thud.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < tl; i++) {
      const t = i / ctx.sampleRate;
      lp += (Math.random() * 2 - 1 - lp) * 0.08;
      td[i] = (lp * 2.2 * Math.exp(-t * 18) + Math.sin(2 * Math.PI * (70 - 40 * t) * t) * Math.exp(-t * 9) * 0.8) * 0.9;
    }

    this.squeal = this.loop('bandpass', 1100, 5);
    this.wind = this.loop('lowpass', 500, 0.7);
    this.grass = this.loop('lowpass', 180, 1);
    this.crowd = this.loop('bandpass', 850, 0.6, false);
    this.crowdPanner = new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 25, rolloffFactor: 1.2 });
    this.crowd.gain.disconnect();
    this.crowd.gain.connect(this.crowdPanner).connect(this.sfx);
    this.crowdPanner.positionX.value = -2;
    this.crowdPanner.positionY.value = 4;
    this.crowdPanner.positionZ.value = 101;
    this.crowd.gain.gain.value = 0.05;

    // Tonal component of tyre squeal
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = 'sawtooth';
    this.squealOsc.frequency.value = 900;
    const sqf = ctx.createBiquadFilter();
    sqf.type = 'bandpass';
    sqf.frequency.value = 1300;
    sqf.Q.value = 3;
    this.squealOscGain = ctx.createGain();
    this.squealOscGain.gain.value = 0;
    this.squealOsc.connect(sqf).connect(this.squealOscGain).connect(this.sfx);
    this.squealOsc.start();

    // Kerb rumble: low square wave with rate tied to speed
    this.kerbOsc = ctx.createOscillator();
    this.kerbOsc.type = 'square';
    this.kerbOsc.frequency.value = 20;
    const kf = ctx.createBiquadFilter();
    kf.type = 'lowpass';
    kf.frequency.value = 260;
    this.kerbGain = ctx.createGain();
    this.kerbGain.gain.value = 0;
    this.kerbOsc.connect(kf).connect(this.kerbGain).connect(this.sfx);
    this.kerbOsc.start();

    this.ready = true;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  private loop(type: BiquadFilterType, freq: number, q: number, connect = true): LoopVoice {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain);
    if (connect) gain.connect(this.sfx);
    src.start(0, Math.random() * 1.5);
    return { src, filter, gain };
  }

  createEngine(spatial: boolean) {
    if (!this.ready || !this.ctx) return null;
    return new EngineVoice(this.ctx, this.engines, spatial);
  }

  setListener(cam: THREE.Camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = new THREE.Vector3();
    const f = new THREE.Vector3();
    const u = new THREE.Vector3();
    cam.getWorldPosition(p);
    cam.getWorldDirection(f);
    u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02);
      l.forwardY.setTargetAtTime(f.y, t, 0.02);
      l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.setTargetAtTime(u.x, t, 0.02);
      l.upY.setTargetAtTime(u.y, t, 0.02);
      l.upZ.setTargetAtTime(u.z, t, 0.02);
    } else {
      (l as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(p.x, p.y, p.z);
    }
  }

  /** Per-frame surface/tyre sounds for the focused kart. */
  setDriving(o: { speed: number; slide: number; kerb: number; grass: number; locked: boolean }) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.abs(o.speed);
    const slide = clamp(o.slide, 0, 1) * clamp(v / 6, 0, 1) * (1 - o.grass);
    this.squeal.gain.gain.setTargetAtTime(slide * 0.22 + (o.locked ? 0.1 : 0), t, 0.04);
    this.squeal.filter.frequency.setTargetAtTime(900 + slide * 700, t, 0.05);
    this.squealOscGain.gain.setTargetAtTime(slide > 0.35 ? (slide - 0.35) * 0.05 : 0, t, 0.05);
    this.squealOsc.frequency.setTargetAtTime(780 + slide * 260 + Math.random() * 40, t, 0.03);
    this.wind.gain.gain.setTargetAtTime(clamp(v / 24, 0, 1) ** 2 * 0.18, t, 0.1);
    this.wind.filter.frequency.setTargetAtTime(300 + v * 45, t, 0.1);
    this.grass.gain.gain.setTargetAtTime(o.grass * clamp(v / 8, 0, 1) * 0.7, t, 0.05);
    this.kerbGain.gain.setTargetAtTime(o.kerb > 0 ? clamp(v / 10, 0, 1) * 0.16 : 0, t, 0.02);
    this.kerbOsc.frequency.setTargetAtTime(Math.max(8, v / 1.2), t, 0.02);
  }

  quietDriving() {
    this.setDriving({ speed: 0, slide: 0, kerb: 0, grass: 0, locked: false });
  }

  impact(strength: number, x?: number, y?: number, z?: number) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.thud;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const g = ctx.createGain();
    g.gain.value = clamp(strength / 8, 0.08, 1.1);
    if (x !== undefined) {
      const p = new PannerNode(ctx, { panningModel: 'equalpower', refDistance: 4, rolloffFactor: 1.2, positionX: x, positionY: y, positionZ: z });
      src.connect(g).connect(p).connect(this.sfx);
    } else src.connect(g).connect(this.sfx);
    src.start();
  }

  beep(freq: number, dur = 0.18, vol = 0.25) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.setValueAtTime(vol, t + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  click() {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(1400, t);
    o.frequency.exponentialRampToValueAtTime(700, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.08);
  }

  setCrowd(excitement: number) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.crowd.gain.gain.setTargetAtTime(0.04 + excitement * 0.5, t, 0.3);
    this.crowd.filter.frequency.setTargetAtTime(700 + excitement * 600, t, 0.3);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  /** Suspend the whole graph while the tab is hidden; resume only what we suspended. */
  setBackground(hidden: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (hidden && ctx.state === 'running') {
      this.suspendedForBackground = true;
      ctx.suspend();
    } else if (!hidden && this.suspendedForBackground) {
      this.suspendedForBackground = false;
      ctx.resume();
    }
  }

  duck(on: boolean) {
    if (!this.ready || !this.ctx) return;
    this.engines.gain.setTargetAtTime(on ? 0.25 : 0.9, this.ctx.currentTime, 0.2);
  }
}

export const audio = new AudioEngine();
