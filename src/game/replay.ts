import type { KartVisualState } from '../kart/kartModel';
import type { Racer } from './racer';
import { lerp, lerpAngle } from '../core/math';
import { storageGet, storageSet } from '../core/settings';

// Compact recording of every kart at 30 Hz for broadcast-style replays, and a
// best-lap "ghost" for time trial persisted in localStorage.

export const REPLAY_HZ = 30;
const F = 16; // floats per kart per frame

export class ReplayRecorder {
  frames: Float32Array[] = [];
  count: number;
  private acc = 0;
  duration = 0;
  constructor(count: number) {
    this.count = count;
  }

  /** Call every physics step; samples at REPLAY_HZ. */
  step(dt: number, racers: Racer[]) {
    this.acc += dt;
    if (this.acc < 1 / REPLAY_HZ) return;
    this.acc -= 1 / REPLAY_HZ;
    const f = new Float32Array(this.count * F);
    racers.forEach((r, k) => {
      const p = r.phys;
      const o = k * F;
      f[o] = p.x;
      f[o + 1] = p.y;
      f[o + 2] = p.z;
      f[o + 3] = p.heading;
      f[o + 4] = p.steer;
      f[o + 5] = p.speed;
      f[o + 6] = p.rpm;
      f[o + 7] = p.throttle;
      f[o + 8] = p.brake;
      f[o + 9] = p.latG;
      f[o + 10] = p.longG;
      f[o + 11] = p.pitch;
      f[o + 12] = p.roll;
      f[o + 13] = p.rearSliding;
      f[o + 14] = p.onGrass;
      f[o + 15] = p.onKerb + (p.limiterHit ? 10 : 0);
    });
    this.frames.push(f);
    this.duration = this.frames.length / REPLAY_HZ;
  }

  /** Samples kart k at time t (seconds). */
  sample(k: number, t: number, out: ReplaySample) {
    const n = this.frames.length;
    if (!n) return out;
    const ft = Math.max(0, Math.min(n - 1.001, t * REPLAY_HZ));
    const i = Math.floor(ft);
    const a = ft - i;
    const A = this.frames[i];
    const B = this.frames[Math.min(n - 1, i + 1)];
    const o = k * F;
    const L = (j: number) => lerp(A[o + j], B[o + j], a);
    out.x = L(0);
    out.y = L(1);
    out.z = L(2);
    out.heading = lerpAngle(A[o + 3], B[o + 3], a);
    out.v.steerAngle = L(4);
    out.v.speed = L(5);
    out.v.rpm = L(6);
    out.v.throttle = L(7);
    out.v.brake = L(8);
    out.v.latG = L(9);
    out.v.longG = L(10);
    out.v.pitch = L(11);
    out.v.roll = L(12);
    out.sliding = L(13);
    out.grass = L(14);
    const kerbRaw = A[o + 15];
    out.limiter = kerbRaw >= 10;
    out.v.onKerb = kerbRaw % 10;
    return out;
  }
}

export interface ReplaySample {
  x: number;
  y: number;
  z: number;
  heading: number;
  sliding: number;
  grass: number;
  limiter: boolean;
  v: KartVisualState;
}

export const newSample = (): ReplaySample => ({
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  sliding: 0,
  grass: 0,
  limiter: false,
  v: { steerAngle: 0, speed: 0, throttle: 0, brake: 0, latG: 0, longG: 0, pitch: 0, roll: 0, rpm: 0, onKerb: 0 },
});

// ---------------------------------------------------------------- ghost

const GHOST_HZ = 20;
const GF = 8; // t, x, y, z, heading, steer, speed, lapDist
const GHOST_KEY = 'grkart.ghost.v3';

export class GhostLap {
  data: number[] = [];
  time = Infinity;
  private acc = 0;

  record(dt: number, t: number, r: Racer, lapDist: number) {
    this.acc += dt;
    if (this.acc < 1 / GHOST_HZ) return;
    this.acc = 0;
    const p = r.phys;
    this.data.push(t, p.x, p.y, p.z, p.heading, p.steer, p.speed, lapDist);
  }

  /** Lap time at which the ghost had covered `dist` metres (for live delta). */
  timeAtDist(dist: number) {
    const n = this.data.length / GF;
    if (n < 2) return NaN;
    let lo = 0;
    let hi = n - 1;
    if (dist <= this.data[7]) return this.data[0];
    if (dist >= this.data[(n - 1) * GF + 7]) return this.data[(n - 1) * GF];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.data[mid * GF + 7] <= dist) lo = mid;
      else hi = mid;
    }
    const da = this.data[lo * GF + 7];
    const db = this.data[hi * GF + 7];
    const a = db > da ? (dist - da) / (db - da) : 0;
    return lerp(this.data[lo * GF], this.data[hi * GF], a);
  }

  reset() {
    this.data = [];
    this.acc = 0;
  }

  /** Interpolated state at lap time t. */
  sample(t: number) {
    const n = this.data.length / GF;
    if (n < 2) return null;
    // binary search on time
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.data[mid * GF] <= t) lo = mid;
      else hi = mid;
    }
    const A = lo * GF;
    const B = hi * GF;
    const ta = this.data[A];
    const tb = this.data[B];
    const a = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 0;
    const d = this.data;
    return {
      x: lerp(d[A + 1], d[B + 1], a),
      y: lerp(d[A + 2], d[B + 2], a),
      z: lerp(d[A + 3], d[B + 3], a),
      heading: lerpAngle(d[A + 4], d[B + 4], a),
      steer: lerp(d[A + 5], d[B + 5], a),
      speed: lerp(d[A + 6], d[B + 6], a),
      done: t > this.data[(n - 1) * GF],
    };
  }

  save() {
    const arr = new Float32Array(this.data);
    const bytes = new Uint8Array(arr.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    storageSet(GHOST_KEY, JSON.stringify({ time: this.time, d: btoa(bin) }));
  }

  static load(): GhostLap | null {
    const raw = storageGet(GHOST_KEY);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      const bin = atob(o.d);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const g = new GhostLap();
      g.data = Array.from(new Float32Array(bytes.buffer));
      g.time = o.time;
      return g;
    } catch {
      return null;
    }
  }
}
