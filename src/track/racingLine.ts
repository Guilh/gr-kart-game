import { clamp, lerp } from '../core/math';
import type { Track } from './track';

// Racing line generator in the spirit of Rémi Coulom's K1999 (TORCS):
// every point is nudged sideways until its curvature equals the average of its
// neighbours', coarse-to-fine, inside the track limits. A physics-aware speed
// profile (forward/backward passes) turns the geometry into target speeds.

export interface RacingLine {
  offset: Float32Array; // lateral offset from centreline per sample (+ = left)
  x: Float32Array;
  z: Float32Array;
  curvature: Float32Array;
  speed: Float32Array; // target speed (m/s)
  brakeZones: number[]; // sample indices where heavy braking begins
}

function curv3(ax: number, az: number, bx: number, bz: number, cx: number, cz: number) {
  const x1 = bx - ax;
  const z1 = bz - az;
  const x2 = cx - bx;
  const z2 = cz - bz;
  const cross = x1 * z2 - z1 * x2;
  const l1 = Math.hypot(x1, z1);
  const l2 = Math.hypot(x2, z2);
  const l3 = Math.hypot(cx - ax, cz - az);
  return (2 * cross) / Math.max(1e-9, l1 * l2 * l3);
}

export function computeRacingLine(track: Track, opts: { margin?: number; mu?: number; vmax?: number } = {}): RacingLine {
  const N = track.N;
  const margin = opts.margin ?? 1.2;
  const mu = opts.mu ?? 1.2;
  const vmax = opts.vmax ?? 24.2;
  const off = new Float32Array(N);
  const X = (i: number, o = off[i]) => track.px[i] + track.nx[i] * o;
  const Z = (i: number, o = off[i]) => track.pz[i] + track.nz[i] * o;
  const lim = (i: number) => Math.max(0, track.hw[i] - margin);

  for (const step of [48, 24, 12, 6, 3, 2, 1]) {
    const idx: number[] = [];
    for (let i = 0; i < N; i += step) idx.push(i);
    const M = idx.length;
    const iters = step === 1 ? 160 : 90;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < M; k++) {
        const pp = idx[(k - 2 + M) % M];
        const p = idx[(k - 1 + M) % M];
        const i = idx[k];
        const n = idx[(k + 1) % M];
        const nn = idx[(k + 2) % M];
        const cPrev = curv3(X(pp), Z(pp), X(p), Z(p), X(i), Z(i));
        const cNext = curv3(X(i), Z(i), X(n), Z(n), X(nn), Z(nn));
        const target = (cPrev + cNext) * 0.5;
        const o0 = off[i];
        const c0 = curv3(X(p), Z(p), X(i, o0), Z(i, o0), X(n), Z(n));
        const d = 0.01;
        const c1 = curv3(X(p), Z(p), X(i, o0 + d), Z(i, o0 + d), X(n), Z(n));
        const deriv = (c1 - c0) / d;
        if (Math.abs(deriv) < 1e-9) continue;
        let o = o0 + ((target - c0) / deriv) * 0.8;
        const L = lim(i);
        o = clamp(o, -L, L);
        off[i] = o;
      }
    }
    if (step > 1) {
      // Interpolate the in-between samples along straight chords.
      for (let k = 0; k < M; k++) {
        const a = idx[k];
        const b = idx[(k + 1) % M];
        const span = (b - a + N) % N || N;
        for (let j = 1; j < span; j++) {
          const i = (a + j) % N;
          const t = j / span;
          const px = lerp(X(a), X(b), t);
          const pz = lerp(Z(a), Z(b), t);
          const o = (px - track.px[i]) * track.nx[i] + (pz - track.pz[i]) * track.nz[i];
          off[i] = clamp(o, -lim(i), lim(i));
        }
      }
    }
  }
  // Final gentle smoothing to remove sample noise.
  for (let pass = 0; pass < 4; pass++) {
    const src = off.slice();
    for (let i = 0; i < N; i++) {
      const v = (src[track.wrap(i - 2)] + src[track.wrap(i - 1)] * 2 + src[i] * 3 + src[track.wrap(i + 1)] * 2 + src[track.wrap(i + 2)]) / 9;
      off[i] = clamp(v, -lim(i), lim(i));
    }
  }

  const x = new Float32Array(N);
  const z = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = X(i);
    z[i] = Z(i);
  }

  const curvature = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = track.wrap(i - 4);
    const b = track.wrap(i + 4);
    curvature[i] = curv3(x[a], z[a], x[i], z[i], x[b], z[b]);
  }

  // Speed profile
  const g = 9.81;
  const speed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const k = Math.abs(curvature[i]);
    speed[i] = Math.min(vmax, Math.sqrt((mu * g) / Math.max(k, 1e-4)));
  }
  const segLen = (i: number, j: number) => Math.hypot(x[j] - x[i], z[j] - z[i]);
  const accel = (v: number) => Math.max(0.35, 3.0 - 0.095 * v);
  const decel = 5.0;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < N; i++) {
      const prev = track.wrap(i - 1);
      const vLim = Math.sqrt(speed[prev] ** 2 + 2 * accel(speed[prev]) * segLen(prev, i));
      if (speed[i] > vLim) speed[i] = vLim;
    }
    for (let i = N - 1; i >= 0; i--) {
      const next = track.wrap(i + 1);
      const vLim = Math.sqrt(speed[next] ** 2 + 2 * decel * segLen(i, next));
      if (speed[i] > vLim) speed[i] = vLim;
    }
  }

  // Where heavy braking begins (for brake boards)
  const brakeZones: number[] = [];
  for (let i = 0; i < N; i++) {
    const prev = track.wrap(i - 1);
    const next = track.wrap(i + 1);
    const peak = speed[prev] <= speed[i] + 1e-4 && speed[next] < speed[i] - 1e-3;
    if (!peak) continue;
    let minV = speed[i];
    for (let k = 1; k < 150; k++) {
      const v = speed[track.wrap(i + k)];
      if (v < minV) minV = v;
      else if (v > minV + 0.3) break;
    }
    if (speed[i] - minV > 4) brakeZones.push(i);
  }

  return { offset: off, x, z, curvature, speed, brakeZones };
}
