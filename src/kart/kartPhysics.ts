import type { DriveControls } from '../core/input';
import { clamp, lerp, moveTowards } from '../core/math';
import { newProj, Track, TrackProj } from '../track/track';
import { DIM } from './kartSpecs';

// Planar vehicle dynamics for a direct-drive kart:
//  • bicycle model with Pacejka "magic formula" lateral tyre forces
//  • rear-only brakes and drive through a solid axle (combined-slip friction circle)
//  • centrifugal clutch + torque curve for the 215 cc four-stroke, rev limiter
//  • longitudinal load transfer, slope gravity, aero drag, rolling resistance
//  • per-wheel surfaces: asphalt / kerb / grass

const G = 9.81;

export const KART_PARAMS = {
  mass: 83 + 72, // kart (spec) + driver
  wheelbase: DIM.wheelbase,
  cgToFront: 0.6025, // ~58% rear weight bias
  cgToRear: 0.4425,
  cgHeight: 0.28,
  inertia: 40,
  mu: 1.42,
  frontGrip: 0.95,
  rearGrip: 1.1,
  // Tyre curves. Rear cornering stiffness per unit load is kept ~20% above the
  // front so the kart has a positive understeer gradient (stable at speed),
  // while the rear's lower shape factor keeps grip past the peak (catchable slides).
  B: 12,
  C: 1.45,
  Br: 14,
  Cr: 1.35,
  E: 0.12,
  maxSteer: 0.42,
  cdA: 0.58,
  crr: 0.016,
  wheelR: DIM.rearTireR,
  gear: 3.7,
  idleRpm: 1750,
  clutchIn: 2500,
  clutchLock: 3100,
  limiter: 6150,
  brakeMax: 700,
  halfLength: 0.91,
  halfWidth: 0.58,
};

// Torque curve (rpm → N·m) for the 215 cc single — broad, flat, forgiving.
const TORQUE: [number, number][] = [
  [0, 0],
  [1500, 11.5],
  [2500, 15.8],
  [3500, 18.6],
  [4200, 19.1],
  [5000, 17.6],
  [5800, 15.2],
  [6400, 12.8],
];

function torqueAt(rpm: number) {
  if (rpm <= TORQUE[0][0]) return TORQUE[0][1];
  for (let i = 1; i < TORQUE.length; i++) {
    if (rpm <= TORQUE[i][0]) {
      const [r0, t0] = TORQUE[i - 1];
      const [r1, t1] = TORQUE[i];
      return lerp(t0, t1, (rpm - r0) / (r1 - r0));
    }
  }
  return TORQUE[TORQUE.length - 1][1];
}

function magic(alpha: number, B: number, C: number, E: number) {
  const x = B * alpha;
  return Math.sin(C * Math.atan(x - E * (x - Math.atan(x))));
}

const SURF_MU = [1, 0.9, 0.55];
const SURF_RR = [0, 0.004, 0.11];

// wheel offsets relative to CG in kart local (x = left, z = forward)
const WHEELS = [
  { x: DIM.frontTrackHalf, z: DIM.frontAxleZ + 0.08 },
  { x: -DIM.frontTrackHalf, z: DIM.frontAxleZ + 0.08 },
  { x: DIM.rearTrackHalf, z: DIM.rearAxleZ + 0.08 },
  { x: -DIM.rearTrackHalf, z: DIM.rearAxleZ + 0.08 },
];

/** Model origin sits 8 cm ahead of the centre of gravity. */
export const CG_OFFSET = 0.08;

export class KartPhysics {
  p = KART_PARAMS;
  // State (CG position in world)
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  steer = 0;
  rpm = KART_PARAMS.idleRpm;
  // Previous step (for render interpolation)
  prevX = 0;
  prevY = 0;
  prevZ = 0;
  prevHeading = 0;

  // Outputs / telemetry
  speed = 0; // signed forward speed
  latG = 0;
  longG = 0;
  slipF = 0;
  slipR = 0;
  rearSliding = 0; // 0..1 rear tyres beyond the peak / locked
  wheelLocked = false;
  limiterHit = false;
  throttle = 0;
  brake = 0;
  pitch = 0;
  roll = 0;
  onKerb = 0;
  onGrass = 0;
  wheelKinds: number[] = [0, 0, 0, 0];
  impact = 0; // last wall impact speed (m/s), consumed by FX
  impactX = 0;
  impactZ = 0;
  frozen = false;
  reversing = false;
  private stoppedTime = 0;
  private axFiltered = 0;
  proj: TrackProj = newProj();
  assist = false;

  setPose(x: number, z: number, heading: number, track: Track) {
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    this.heading = this.prevHeading = heading;
    this.vx = this.vz = this.yawRate = this.steer = 0;
    this.speed = 0;
    this.rpm = this.p.idleRpm;
    this.proj.index = -1;
    track.project(x, z, -1, this.proj);
    this.y = this.prevY = this.proj.height;
  }

  step(dt: number, ctrl: DriveControls, track: Track) {
    const P = this.p;
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevHeading = this.heading;

    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    // forward f = (sin, cos), left l = (cos, -sin)
    let u = this.vx * sinH + this.vz * cosH;
    let w = this.vx * cosH - this.vz * sinH;
    const absU = Math.abs(u);

    this.throttle = ctrl.throttle;
    this.brake = ctrl.brake;

    // --- Steering: rate-limited and speed-sensitive
    const speedFactor = clamp(absU / 21, 0, 1);
    const maxSteer = lerp(P.maxSteer, P.maxSteer * (this.assist ? 0.37 : 0.4), speedFactor);
    let target = -ctrl.steer * maxSteer;
    // Counter-steer assist: when the rear steps out, bias the wheels into the slide.
    if (this.assist && absU > 4) {
      const slideAngle = Math.atan2(w, absU);
      target += clamp(slideAngle * 0.55, -0.18, 0.18) * (1 - Math.abs(ctrl.steer) * 0.5);
    }
    this.steer = moveTowards(this.steer, target, dt * 2.6);
    const delta = this.steer;

    // --- Track & surfaces under each wheel
    track.project(this.x, this.z, this.proj.index, this.proj);
    const pr = this.proj;
    let muF = 0;
    let muR = 0;
    let rr = 0;
    let kerb = 0;
    let grass = 0;
    const hts = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const wh = WHEELS[k];
      // world offset of wheel from CG
      const ox = wh.z * sinH + wh.x * cosH;
      const oz = wh.z * cosH - wh.x * sinH;
      const lat = pr.lateral + ox * pr.nx + oz * pr.nz;
      const surf = track.surfaceAt(pr, lat);
      this.wheelKinds[k] = surf.kind;
      hts[k] = surf.height;
      const mu = SURF_MU[surf.kind];
      if (k < 2) muF += mu * 0.5;
      else muR += mu * 0.5;
      rr += SURF_RR[surf.kind] * 0.25;
      if (surf.kind === 1) kerb += 0.25;
      if (surf.kind === 2) grass += 0.25;
    }
    this.onKerb = kerb;
    this.onGrass = grass;

    // --- Normal loads with longitudinal transfer
    const L = P.wheelbase;
    const mg = P.mass * G;
    const transfer = (P.mass * this.axFiltered * P.cgHeight) / L;
    const FzF = Math.max(50, (mg * P.cgToRear) / L - transfer);
    const FzR = Math.max(50, (mg * P.cgToFront) / L + transfer);

    // --- Slip angles (velocity floor keeps low speeds stable)
    const uSafe = Math.max(absU, 3.5);
    const dir = u >= 0 ? 1 : -1;
    const alphaF = Math.atan2(w + P.cgToFront * this.yawRate, uSafe) - delta * dir;
    const alphaR = Math.atan2(w - P.cgToRear * this.yawRate, uSafe);
    this.slipF = alphaF;
    this.slipR = alphaR;

    // --- Engine, clutch and drive force
    const axleRpm = ((absU / P.wheelR) * 60) / (2 * Math.PI);
    const coupledRpm = axleRpm * P.gear;
    let driveF = 0;
    const thr = this.frozen ? ctrl.throttle : ctrl.throttle;
    // Free-revving target when the clutch is slipping
    const freeRpm = lerp(P.idleRpm, 4600, thr);
    const clutch = clamp((Math.max(coupledRpm, this.rpm) - P.clutchIn) / (P.clutchLock - P.clutchIn), 0, 1);
    if (this.frozen) {
      this.rpm = moveTowards(this.rpm, lerp(P.idleRpm, 5600, thr), dt * (thr > this.rpm / 6000 ? 9000 : 5000));
    } else if (coupledRpm >= P.clutchLock) {
      this.rpm = coupledRpm;
    } else {
      const target2 = Math.max(coupledRpm, thr > 0.05 ? Math.min(freeRpm, 3600) : P.idleRpm);
      this.rpm = moveTowards(this.rpm, target2, dt * 7000);
    }
    this.limiterHit = false;
    if (this.rpm > P.limiter) {
      this.limiterHit = true;
    }
    if (!this.frozen && !this.reversing) {
      const tq = this.limiterHit ? 0 : torqueAt(this.rpm) * thr;
      driveF = (tq * P.gear * 0.92 * clutch) / P.wheelR;
      if (thr < 0.05 && coupledRpm >= P.clutchLock) driveF -= (this.rpm / 6000) * 38; // engine braking
    }
    if (u < -0.3 && !this.reversing) driveF = Math.max(driveF, 0);

    // --- Reverse ("marshal push") when stationary with the brake held
    if (absU < 0.4 && ctrl.brake > 0.6 && ctrl.throttle < 0.05) this.stoppedTime += dt;
    else if (ctrl.throttle > 0.05 || ctrl.brake < 0.1) this.stoppedTime = 0;
    this.reversing = this.stoppedTime > 0.45;

    // --- Brakes (rear axle only)
    let brakeF = 0;
    if (!this.reversing) {
      brakeF = ctrl.brake * P.brakeMax;
      // Assist: anti-lock — never ask the rear tyres for more than ~85% of their grip
      if (this.assist) brakeF = Math.min(brakeF, 0.85 * P.mu * P.rearGrip * muR * FzR);
    }

    // Longitudinal rear-axle force demand
    let FxR = driveF;
    if (this.reversing) FxR = u > -2.2 ? -170 : 0;
    else if (absU > 0.05) FxR -= brakeF * dir;
    else FxR = Math.abs(FxR) > brakeF ? FxR - Math.sign(FxR) * brakeF : 0;

    // Friction circle on the rear
    const rearMax = P.mu * P.rearGrip * muR * FzR;
    this.wheelLocked = false;
    if (Math.abs(FxR) > rearMax) {
      if (brakeF > 0 && absU > 1) this.wheelLocked = true;
      FxR = Math.sign(FxR) * rearMax * 0.92;
    }
    const latCapR = Math.sqrt(Math.max(0, rearMax * rearMax - FxR * FxR));
    let FyR = -magic(alphaR, P.Br, P.Cr, P.E) * rearMax;
    FyR = clamp(FyR, -latCapR, latCapR);
    if (this.wheelLocked) FyR *= 0.4;

    const frontMax = P.mu * P.frontGrip * muF * FzF;
    const FyF = -magic(alphaF, P.B, P.C, P.E) * frontMax;

    this.rearSliding = clamp(Math.max(Math.abs(alphaR) / 0.2 - 0.45, 0) + (this.wheelLocked ? 0.8 : 0) + Math.abs(FxR) / Math.max(1, rearMax) * (driveF > rearMax * 0.95 ? 0.5 : 0), 0, 1);

    // --- Resistances
    const drag = 0.5 * 1.2 * P.cdA * u * absU;
    const rolling = (P.crr + rr) * mg * (absU > 0.2 ? dir : u / 0.2);
    // Solid rear axle scrubs speed in tight corners
    const scrub = Math.abs(this.yawRate) * absU * 3.2 * dir;
    // Gravity along the slope (heights ahead/behind)
    const slope = (hts[0] + hts[1] - hts[2] - hts[3]) / (2 * (WHEELS[0].z - WHEELS[2].z));
    const gravity = -mg * slope;

    const Fx = FxR - FyF * Math.sin(delta) - drag - rolling - scrub + gravity;
    const Fy = FyR + FyF * Math.cos(delta);
    const torque = P.cgToFront * FyF * Math.cos(delta) - P.cgToRear * FyR;

    // --- Integrate in the world frame (forces rotate with the body, velocity doesn't)
    const ax = Fx / P.mass;
    const ay = Fy / P.mass;
    this.vx += (ax * sinH + ay * cosH) * dt;
    this.vz += (ax * cosH - ay * sinH) * dt;
    this.yawRate += (torque / P.inertia) * dt;
    u = this.vx * sinH + this.vz * cosH;
    w = this.vx * cosH - this.vz * sinH;

    // Assist: stability control — when the rear is sliding, pull the yaw rate back
    // towards what the steering asks for (like a gentle ESC).
    if (this.assist && absU > 3) {
      const rRef = clamp((u * Math.tan(delta)) / L, -(P.mu * G) / Math.max(absU, 1), (P.mu * G) / Math.max(absU, 1));
      const slide = clamp((Math.abs(alphaR) - 0.1) * 7, 0, 1);
      this.yawRate += (rRef - this.yawRate) * slide * 5 * dt;
    }

    // Low-speed kinematic blend keeps parking-lot behaviour sane.
    const lowK = clamp(1 - Math.abs(u) / 3, 0, 1);
    if (lowK > 0) {
      const kin = (u * Math.tan(delta)) / L;
      this.yawRate = lerp(this.yawRate, kin, lowK * 0.5);
      w *= 1 - lowK * 0.35;
    }
    // Grass: random bumps make it lively
    if (grass > 0 && absU > 3) {
      this.yawRate += (Math.random() - 0.5) * grass * 0.9 * dt * absU;
    }
    if (Math.abs(u) < 0.15 && thr < 0.05 && !this.reversing) {
      u *= 0.8;
      w *= 0.8;
    }
    this.vx = u * sinH + w * cosH;
    this.vz = u * cosH - w * sinH;

    this.heading += this.yawRate * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    this.axFiltered += (ax - this.axFiltered) * Math.min(1, dt * 10);
    this.longG += (ax / G - this.longG) * Math.min(1, dt * 8);
    this.latG += (ay / G - this.latG) * Math.min(1, dt * 8);
    this.speed = u;

    this.collideWalls(track);

    // Attitude & ride height
    track.project(this.x, this.z, this.proj.index, this.proj);
    const hAvg = (hts[0] + hts[1] + hts[2] + hts[3]) / 4;
    this.y = hAvg;
    this.pitch = -Math.atan(slope);
    const rollSlope = (hts[0] + hts[2] - hts[1] - hts[3]) / (4 * DIM.rearTrackHalf);
    this.roll = Math.atan(rollSlope);
  }

  private collideWalls(track: Track) {
    const pr = track.project(this.x, this.z, this.proj.index, this.proj);
    const rel = this.heading - Math.atan2(pr.tx, pr.tz);
    const ext = Math.abs(this.p.halfLength * Math.sin(rel)) + Math.abs(this.p.halfWidth * Math.cos(rel));
    let pen = 0;
    let nSign = 0;
    if (pr.lateral + ext > pr.wallL) {
      pen = pr.lateral + ext - pr.wallL;
      nSign = 1;
    } else if (pr.lateral - ext < -pr.wallR) {
      pen = -pr.wallR - (pr.lateral - ext);
      nSign = -1;
    }
    if (nSign === 0) return;
    // outward normal of the wall (pointing away from track centre)
    const nx = pr.nx * nSign;
    const nz = pr.nz * nSign;
    this.x -= nx * pen;
    this.z -= nz * pen;
    const vn = this.vx * nx + this.vz * nz;
    if (vn > 0) {
      const rest = 0.28;
      this.vx -= nx * vn * (1 + rest);
      this.vz -= nz * vn * (1 + rest);
      const fr = 1 - Math.min(0.35, vn * 0.05);
      this.vx *= fr;
      this.vz *= fr;
      // yaw kick: align with the wall a little
      const tangentHeading = Math.atan2(pr.tx, pr.tz);
      let d = this.heading - tangentHeading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > Math.PI / 2) d = d - Math.sign(d) * Math.PI;
      this.yawRate += -d * Math.min(4, vn * 0.6) + (Math.random() - 0.5) * vn * 0.3;
      if (vn > this.impact) {
        this.impact = vn;
        this.impactX = this.x + nx * this.p.halfWidth;
        this.impactZ = this.z + nz * this.p.halfWidth;
      }
    }
  }

  /** Speed in km/h. */
  get kmh() {
    return Math.abs(this.speed) * 3.6;
  }
}
