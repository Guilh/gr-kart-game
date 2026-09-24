import * as THREE from 'three';
import type { ControlPoint } from './trackData';
import { baseHeight } from './terrain';
import { smoothstep, wrapAngle } from '../core/math';

export interface TrackProj {
  index: number; // segment start sample
  t: number; // 0..1 along the segment
  s: number; // distance along centreline [0, length)
  lateral: number; // + = left of centreline (driver's left in race direction)
  height: number;
  tx: number;
  tz: number;
  nx: number; // left normal
  nz: number;
  halfWidth: number;
  wallL: number;
  wallR: number;
  kerbL: number;
  kerbR: number;
  curvature: number;
}

export const newProj = (): TrackProj => ({
  index: -1,
  t: 0,
  s: 0,
  lateral: 0,
  height: 0,
  tx: 0,
  tz: 1,
  nx: 1,
  nz: 0,
  halfWidth: 5,
  wallL: 10,
  wallR: 10,
  kerbL: 0,
  kerbR: 0,
  curvature: 0,
});

export const KERB_WIDTH = 1.05;
export const KERB_HEIGHT = 0.035;

/**
 * Closed-loop circuit sampled every ~1 m along its centreline. Provides fast
 * nearest-point projection (with a temporal hint), surfaces and wall limits.
 */
export class Track {
  name: string;
  N: number;
  length: number;
  ds: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  tx: Float32Array;
  tz: Float32Array;
  nx: Float32Array;
  nz: Float32Array;
  hw: Float32Array;
  wallL: Float32Array;
  wallR: Float32Array;
  curv: Float32Array;
  kerbL: Float32Array;
  kerbR: Float32Array;
  wallTypeL: Uint8Array; // 0 = tyre stack, 1 = concrete + fence
  wallTypeR: Uint8Array;
  bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  private grid = new Map<number, number[]>();
  private cell = 12;

  constructor(name: string, points: ControlPoint[]) {
    this.name = name;
    const cps = points.map((p) => new THREE.Vector3(p[0], 0, p[1]));
    const curve = new THREE.CatmullRomCurve3(cps, true, 'centripetal');
    curve.arcLengthDivisions = 4000;
    const len = curve.getLength();
    const N = Math.round(len / 1.0);
    this.N = N;
    this.length = len;
    this.ds = len / N;
    const spaced = curve.getSpacedPoints(N);
    const f = () => new Float32Array(N);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.tx = f();
    this.tz = f();
    this.nx = f();
    this.nz = f();
    this.hw = f();
    this.wallL = f();
    this.wallR = f();
    this.curv = f();
    this.kerbL = f();
    this.kerbR = f();
    this.wallTypeL = new Uint8Array(N);
    this.wallTypeR = new Uint8Array(N);

    const nCP = points.length;
    const cpVal = (k: number, field: number) => points[((k % nCP) + nCP) % nCP][field];
    const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) =>
      0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    const runL = f();
    const runR = f();

    for (let i = 0; i < N; i++) {
      const p = spaced[i];
      this.px[i] = p.x;
      this.pz[i] = p.z;
      const tt = curve.getUtoTmapping(i / N, 0) * nCP;
      const k = Math.floor(tt);
      const fr = tt - k;
      const interp = (field: number) => catmull(cpVal(k - 1, field), cpVal(k, field), cpVal(k + 1, field), cpVal(k + 2, field), fr);
      this.hw[i] = interp(2) / 2;
      runL[i] = interp(3);
      runR[i] = interp(4);
      this.py[i] = baseHeight(p.x, p.z);
      this.bounds.minX = Math.min(this.bounds.minX, p.x);
      this.bounds.maxX = Math.max(this.bounds.maxX, p.x);
      this.bounds.minZ = Math.min(this.bounds.minZ, p.z);
      this.bounds.maxZ = Math.max(this.bounds.maxZ, p.z);
    }
    // Smooth elevation so the road never has short bumps.
    for (let pass = 0; pass < 3; pass++) this.circularAverage(this.py, 14);

    for (let i = 0; i < N; i++) {
      const a = this.wrap(i - 1);
      const b = this.wrap(i + 1);
      let dx = this.px[b] - this.px[a];
      let dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      this.tx[i] = dx;
      this.tz[i] = dz;
      this.nx[i] = dz; // left normal
      this.nz[i] = -dx;
    }
    for (let i = 0; i < N; i++) {
      const a = this.wrap(i - 2);
      const b = this.wrap(i + 2);
      const ha = Math.atan2(this.tx[a], this.tz[a]);
      const hb = Math.atan2(this.tx[b], this.tz[b]);
      this.curv[i] = wrapAngle(hb - ha) / (4 * this.ds);
    }
    this.circularAverage(this.curv, 3);

    this.buildKerbs();
    this.buildWalls(runL, runR);

    for (let i = 0; i < N; i++) {
      const key = this.key(Math.floor(this.px[i] / this.cell), Math.floor(this.pz[i] / this.cell));
      let arr = this.grid.get(key);
      if (!arr) this.grid.set(key, (arr = []));
      arr.push(i);
    }
  }

  wrap(i: number) {
    return ((i % this.N) + this.N) % this.N;
  }

  wrapS(s: number) {
    return ((s % this.length) + this.length) % this.length;
  }

  /** Signed shortest distance a→b along the loop. */
  deltaS(a: number, b: number) {
    let d = b - a;
    if (d > this.length / 2) d -= this.length;
    if (d < -this.length / 2) d += this.length;
    return d;
  }

  private key(ix: number, iz: number) {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  private circularAverage(arr: Float32Array, radius: number) {
    const N = this.N;
    const src = arr.slice();
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[this.wrap(k)];
    for (let i = 0; i < N; i++) {
      arr[i] = sum / (2 * radius + 1);
      sum += src[this.wrap(i + radius + 1)] - src[this.wrap(i - radius)];
    }
  }

  private circularOp(arr: Float32Array, radius: number, op: (a: number, b: number) => number) {
    const src = arr.slice();
    for (let i = 0; i < this.N; i++) {
      let v = src[i];
      for (let k = -radius; k <= radius; k++) v = op(v, src[this.wrap(i + k)]);
      arr[i] = v;
    }
  }

  private buildKerbs() {
    const N = this.N;
    const inL = new Uint8Array(N);
    const inR = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const k = this.curv[i];
      const a = Math.abs(k);
      if (a > 1 / 50) {
        // inside of the corner
        if (k > 0) inL[i] = 1;
        else inR[i] = 1;
      }
      if (a > 1 / 26) {
        // outside on tight corners
        if (k > 0) inR[i] = 1;
        else inL[i] = 1;
      }
    }
    const post = (m: Uint8Array, out: Float32Array) => {
      // dilate by 5 m on each side
      const d = new Uint8Array(N);
      for (let i = 0; i < N; i++) if (m[i]) for (let k = -5; k <= 5; k++) d[this.wrap(i + k)] = 1;
      // remove short runs (< 10 m)
      for (let i = 0; i < N; i++) {
        if (!d[i] || d[this.wrap(i - 1)]) continue;
        let len = 0;
        while (d[this.wrap(i + len)] && len < N) len++;
        const w = len < 10 ? 0 : KERB_WIDTH;
        for (let k = 0; k < len; k++) out[this.wrap(i + k)] = w;
      }
    };
    post(inL, this.kerbL);
    post(inR, this.kerbR);
  }

  private buildWalls(runL: Float32Array, runR: Float32Array) {
    const N = this.N;
    for (let i = 0; i < N; i++) {
      const k = this.curv[i];
      const extra = 7 * smoothstep(1 / 90, 1 / 22, Math.abs(k));
      // outside of a right turn (k<0) is the left side
      this.wallL[i] = this.hw[i] + runL[i] + (k < 0 ? extra : extra * 0.2);
      this.wallR[i] = this.hw[i] + runR[i] + (k > 0 ? extra : extra * 0.2);
    }
    this.circularOp(this.wallL, 10, Math.max);
    this.circularOp(this.wallR, 10, Math.max);
    this.circularAverage(this.wallL, 8);
    this.circularAverage(this.wallR, 8);

    // Keep walls from intruding on neighbouring parts of the circuit.
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j += 1) {
        const sd = Math.abs(this.deltaS(i * this.ds, j * this.ds));
        if (sd < 45) continue;
        const dx = this.px[j] - this.px[i];
        const dz = this.pz[j] - this.pz[i];
        if (Math.abs(dx) > 50 || Math.abs(dz) > 50) continue;
        const along = dx * this.nx[i] + dz * this.nz[i];
        const perp = Math.abs(dx * this.tx[i] + dz * this.tz[i]);
        if (perp > 12) continue;
        const minWall = this.hw[i] + 2;
        if (along > 0) this.wallL[i] = Math.max(minWall, Math.min(this.wallL[i], along * 0.5 - 0.5));
        else this.wallR[i] = Math.max(minWall, Math.min(this.wallR[i], -along * 0.5 - 0.5));
      }
    }
    this.circularOp(this.wallL, 4, Math.min);
    this.circularOp(this.wallR, 4, Math.min);
    this.circularAverage(this.wallL, 4);
    this.circularAverage(this.wallR, 4);

    for (let i = 0; i < N; i++) {
      const onMain = this.pz[i] > 68 && this.px[i] > -72 && this.px[i] < 132;
      this.wallTypeL[i] = onMain ? 1 : 0;
      this.wallTypeR[i] = onMain ? 1 : 0;
    }
  }

  /**
   * Projects a world XZ point onto the centreline. `hint` is the previous
   * sample index (or -1) which makes the common case O(1).
   */
  project(x: number, z: number, hint: number, out: TrackProj): TrackProj {
    let best = -1;
    let bestD = Infinity;
    if (hint >= 0) {
      for (let k = -24; k <= 24; k++) {
        const i = this.wrap(hint + k);
        const dx = this.px[i] - x;
        const dz = this.pz[i] - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best < 0 || bestD > 22 * 22) {
      best = -1;
      bestD = Infinity;
      const cx = Math.floor(x / this.cell);
      const cz = Math.floor(z / this.cell);
      for (let r = 1; r <= 3 && best < 0; r++) {
        for (let ix = cx - r; ix <= cx + r; ix++)
          for (let iz = cz - r; iz <= cz + r; iz++) {
            const arr = this.grid.get(this.key(ix, iz));
            if (!arr) continue;
            for (const i of arr) {
              const dx = this.px[i] - x;
              const dz = this.pz[i] - z;
              const d = dx * dx + dz * dz;
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
          }
      }
      if (best < 0) {
        for (let i = 0; i < this.N; i++) {
          const dx = this.px[i] - x;
          const dz = this.pz[i] - z;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    // Refine on the two adjacent segments.
    let segI = best;
    let segT = 0;
    let segD = Infinity;
    for (const i of [this.wrap(best - 1), best]) {
      const j = this.wrap(i + 1);
      const ax = this.px[i];
      const az = this.pz[i];
      const bx = this.px[j] - ax;
      const bz = this.pz[j] - az;
      const l2 = bx * bx + bz * bz || 1;
      let t = ((x - ax) * bx + (z - az) * bz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + bx * t - x;
      const qz = az + bz * t - z;
      const d = qx * qx + qz * qz;
      if (d < segD) {
        segD = d;
        segI = i;
        segT = t;
      }
    }
    return this.fill(segI, segT, x, z, out);
  }

  private fill(i: number, t: number, x: number, z: number, out: TrackProj) {
    const j = this.wrap(i + 1);
    const u = 1 - t;
    const cx = this.px[i] * u + this.px[j] * t;
    const cz = this.pz[i] * u + this.pz[j] * t;
    let tx = this.tx[i] * u + this.tx[j] * t;
    let tz = this.tz[i] * u + this.tz[j] * t;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    out.index = i;
    out.t = t;
    out.s = this.wrapS((i + t) * this.ds);
    out.tx = tx;
    out.tz = tz;
    out.nx = tz;
    out.nz = -tx;
    out.lateral = (x - cx) * out.nx + (z - cz) * out.nz;
    out.height = this.py[i] * u + this.py[j] * t;
    out.halfWidth = this.hw[i] * u + this.hw[j] * t;
    out.wallL = this.wallL[i] * u + this.wallL[j] * t;
    out.wallR = this.wallR[i] * u + this.wallR[j] * t;
    out.kerbL = Math.min(this.kerbL[i], this.kerbL[j]);
    out.kerbR = Math.min(this.kerbR[i], this.kerbR[j]);
    out.curvature = this.curv[i] * u + this.curv[j] * t;
    return out;
  }

  /**
   * Like project() but only searches the spatial grid within `cells` cells;
   * returns false (without the expensive brute-force fallback) if nothing is near.
   */
  projectNear(x: number, z: number, out: TrackProj, cells = 3): boolean {
    let best = -1;
    let bestD = Infinity;
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let ix = cx - cells; ix <= cx + cells; ix++)
      for (let iz = cz - cells; iz <= cz + cells; iz++) {
        const arr = this.grid.get(this.key(ix, iz));
        if (!arr) continue;
        for (const i of arr) {
          const dx = this.px[i] - x;
          const dz = this.pz[i] - z;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    if (best < 0) return false;
    this.project(x, z, best, out);
    return true;
  }

  /** Sample the centreline at distance s (with optional lateral offset). */
  pointAt(s: number, lateral = 0, out = new THREE.Vector3()) {
    s = this.wrapS(s);
    const f = s / this.ds;
    const i = Math.floor(f) % this.N;
    const j = this.wrap(i + 1);
    const t = f - Math.floor(f);
    const u = 1 - t;
    const nx = this.nx[i] * u + this.nx[j] * t;
    const nz = this.nz[i] * u + this.nz[j] * t;
    out.set(
      this.px[i] * u + this.px[j] * t + nx * lateral,
      this.py[i] * u + this.py[j] * t,
      this.pz[i] * u + this.pz[j] * t + nz * lateral,
    );
    return out;
  }

  headingAt(s: number) {
    const i = Math.floor(this.wrapS(s) / this.ds) % this.N;
    return Math.atan2(this.tx[i], this.tz[i]);
  }

  indexAt(s: number) {
    return Math.floor(this.wrapS(s) / this.ds) % this.N;
  }

  /** Surface height at a point (the road is laterally flat; kerbs are raised). */
  surfaceAt(proj: TrackProj, lateral: number): { kind: 0 | 1 | 2; height: number } {
    const a = Math.abs(lateral);
    if (a <= proj.halfWidth) return { kind: 0, height: proj.height };
    const kerbW = lateral > 0 ? proj.kerbL : proj.kerbR;
    if (kerbW > 0 && a <= proj.halfWidth + kerbW) {
      const k = (a - proj.halfWidth) / kerbW;
      return { kind: 1, height: proj.height + KERB_HEIGHT * Math.min(1, k * 1.6) };
    }
    return { kind: 2, height: proj.height - 0.02 };
  }
}
