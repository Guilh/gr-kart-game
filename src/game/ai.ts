import type { DriveControls } from '../core/input';
import { clamp, lerp, moveTowards } from '../core/math';
import type { RacingLine } from '../track/racingLine';
import type { Track } from '../track/track';
import { KART_PARAMS } from '../kart/kartPhysics';
import type { Racer } from './racer';

// AI driver: pure-pursuit steering on the optimised racing line, speed
// tracking of the line's speed profile, traffic awareness (lift, dive for the
// inside, give room alongside), personalities and the occasional mistake.

export interface AIProfile {
  skill: number; // multiplier on the line's target speed
  aggression: number; // 0..1 — how readily it dives for gaps / bumps
  consistency: number; // 0..1 — lower = more mistakes
  reaction: number; // start reaction time (s)
}

export class AIDriver {
  lateral = 0; // offset relative to the racing line
  lateralTarget = 0;
  private mistake = 0;
  private mistakeKind = 0;
  private wobble = Math.random() * 100;
  private startDelay: number;
  catchup = 1;
  needsReset = false;
  private stuckTime = 0;
  controls: DriveControls = { steer: 0, throttle: 0, brake: 0 };

  constructor(public profile: AIProfile) {
    this.startDelay = profile.reaction;
  }

  resetStart() {
    this.startDelay = this.profile.reaction;
  }

  update(dt: number, me: Racer, all: Racer[], track: Track, line: RacingLine, racing: boolean): DriveControls {
    const P = me.phys;
    const c = this.controls;
    if (!racing) {
      // hold on the grid, blip the throttle occasionally
      c.steer = 0;
      c.brake = 1;
      c.throttle = Math.random() < 0.02 ? 0.6 : c.throttle * 0.95;
      return c;
    }
    if (this.startDelay > 0) {
      this.startDelay -= dt;
      c.throttle = 0.2;
      c.brake = 0;
      c.steer = 0;
      return c;
    }

    const v = Math.max(0, P.speed);
    const s = P.proj.s;
    // marshal recovery if beached or pinned against a barrier
    if (Math.abs(P.speed) < 1.0) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    if (this.stuckTime > 3) {
      this.stuckTime = 0;
      this.needsReset = true;
    }
    const sinH = Math.sin(P.heading);
    const cosH = Math.cos(P.heading);

    // --- Traffic
    let lift = 1;
    let vCap = Infinity;
    let wantLat: number | null = null;
    const myLat = P.proj.lateral;
    for (const o of all) {
      if (o === me || o.isGhost) continue;
      const dx = o.phys.x - P.x;
      const dz = o.phys.z - P.z;
      if (Math.abs(dx) > 20 || Math.abs(dz) > 20) continue;
      const ahead = dx * sinH + dz * cosH;
      const side = dx * cosH - dz * sinH; // + = other kart is on my left
      const closing = v - o.phys.speed;
      if (ahead > 0.4 && ahead < 14 && Math.abs(side) < 1.9 && closing > -0.4) {
        const oLat = o.phys.proj.lateral;
        const hw = P.proj.halfWidth;
        const roomL = hw - oLat - 1.5;
        const roomR = oLat + hw - 1.5;
        const nextK = line.curvature[track.indexAt(s + 18)];
        let dir = 0;
        if (roomL > 1.2 && (nextK > 0.004 || roomR < 1.2 || (Math.abs(nextK) <= 0.004 && myLat > oLat))) dir = 1;
        else if (roomR > 1.2) dir = -1;
        if (dir !== 0) {
          const lineOff = line.offset[track.indexAt(s + ahead)];
          wantLat = oLat + dir * 1.75 - lineOff;
        }
        if (Math.abs(side) < 1.35 && ahead < 9) {
          // follow: never plan to arrive faster than the kart in front allows
          vCap = Math.min(vCap, Math.max(0, o.phys.speed) + (ahead - 2.8) * (1.1 + this.profile.aggression * 0.6));
        }
        if (ahead < 4.5 && Math.abs(side) < 1.3 && closing > -0.2) {
          // don't punt the kart ahead: match its speed until there's a gap
          lift = Math.min(lift, clamp(lerp(0.1, 0.55, this.profile.aggression) + (ahead - 1.8) * 0.2, 0, 1));
        }
      }
      if (Math.abs(ahead) < 1.4 && Math.abs(side) < 1.6) {
        // alongside: give a little room
        this.lateralTarget -= Math.sign(side) * dt * 1.6;
      }
    }
    if (wantLat !== null) this.lateralTarget = moveTowards(this.lateralTarget, wantLat, dt * 3.5);
    else this.lateralTarget = moveTowards(this.lateralTarget, 0, dt * 0.55);
    this.lateralTarget = clamp(this.lateralTarget, -5, 5);
    this.lateral = moveTowards(this.lateral, this.lateralTarget, dt * 1.9);

    // --- Mistakes
    if (this.mistake > 0) this.mistake -= dt;
    else if (Math.random() < (1 - this.profile.consistency) * 0.25 * dt) {
      this.mistake = 0.5 + Math.random() * 0.6;
      this.mistakeKind = Math.random() < 0.6 ? 0 : 1;
    }

    // --- Steering: pure pursuit on the (offset) racing line
    const Ld = 3.6 + v * 0.36;
    const sa = s + Ld;
    const ia = track.indexAt(sa);
    const ib = track.wrap(ia + 1);
    const fr = track.wrapS(sa) / track.ds - Math.floor(track.wrapS(sa) / track.ds);
    const hw = track.hw[ia];
    const latPos = clamp(line.offset[ia] + this.lateral, -hw + 0.95, hw - 0.95);
    const baseX = lerp(track.px[ia], track.px[ib], fr);
    const baseZ = lerp(track.pz[ia], track.pz[ib], fr);
    const tx = baseX + track.nx[ia] * latPos;
    const tz = baseZ + track.nz[ia] * latPos;
    const dx = tx - P.x;
    const dz = tz - P.z;
    const fwd = dx * sinH + dz * cosH;
    const left = dx * cosH - dz * sinH;
    const alpha = Math.atan2(left, Math.max(0.5, fwd));
    const delta = Math.atan((2 * KART_PARAMS.wheelbase * Math.sin(alpha)) / Ld);
    const speedFactor = clamp(v / 21, 0, 1);
    const maxSteer = lerp(KART_PARAMS.maxSteer, KART_PARAMS.maxSteer * 0.4, speedFactor);
    this.wobble += dt;
    let steer = -delta / maxSteer;
    // damp yaw to avoid weaving; counter a sliding rear
    steer += P.yawRate * 0.02 * (v / 10);
    if (this.mistake > 0 && this.mistakeKind === 1) steer += Math.sin(this.wobble * 9) * 0.25;
    steer += Math.sin(this.wobble * 0.7) * 0.02 * (1 - this.profile.consistency);
    c.steer = clamp(steer, -1, 1);

    // --- Speed: brake early enough to hit the line's speed at every point ahead
    const decel = 4.2;
    let vt = Infinity;
    for (let d = 0; d <= 44; d += 2) {
      const vl = line.speed[track.indexAt(s + d + 1)] * this.profile.skill * this.catchup;
      vt = Math.min(vt, Math.sqrt(vl * vl + 2 * decel * Math.max(0, d - v * 0.12)));
    }
    if (this.mistake > 0 && this.mistakeKind === 0) vt *= 1.1; // late braking
    vt = Math.min(vt, Math.max(2, vCap));
    // the speed profile assumes the ideal line — respect the extra curvature when off it
    const kAhead = Math.abs(line.curvature[track.indexAt(s + 10)]);
    vt *= 1 - clamp(Math.abs(this.lateral) * 0.04 * clamp(kAhead * 25, 0, 1), 0, 0.15);
    if (P.onGrass > 0.3) vt = Math.min(vt, 12);
    const err = vt - v;
    if (err > 0.3) {
      c.throttle = clamp(err * 1.1 + 0.4, 0, 1);
      c.brake = 0;
    } else if (err < -0.25) {
      c.throttle = 0;
      c.brake = clamp(-err * 0.9 + 0.2, 0.2, 0.95);
      // ease off the brake when the rear is already working hard laterally
      if (Math.abs(P.latG) > 0.7) c.brake *= clamp(1.6 - Math.abs(P.latG), 0.35, 1);
    } else {
      c.throttle = 0.6;
      c.brake = 0;
    }
    c.throttle *= lift;
    if (lift < 0.5 && err < 0.5) c.brake = Math.max(c.brake, 0.25);
    if (P.rearSliding > 0.55) c.throttle *= 0.6;
    // Recover if facing the wrong way / stuck
    const rel = Math.abs(Math.atan2(Math.sin(P.heading - track.headingAt(s)), Math.cos(P.heading - track.headingAt(s))));
    if (rel > 1.6 && v < 3) {
      c.throttle = 0.6;
      c.steer = -Math.sign(left) || 1;
    }
    return c;
  }
}
