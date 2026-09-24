import * as THREE from 'three';
import { clamp, damp, dampAngle, noise1, wrapAngle } from '../core/math';
import type { Track } from '../track/track';
import type { Racer } from './racer';

// Camera director: chase / far chase / helmet cam / trackside TV / helicopter
// / orbit, with spring smoothing, speed-dependent FOV and shake.

export type RigMode = 'chase' | 'far' | 'cockpit' | 'tv' | 'heli' | 'orbit' | 'bumper';

export const RIG_LABELS: Record<RigMode, string> = {
  chase: 'Chase cam',
  far: 'Far chase',
  cockpit: 'Helmet cam',
  tv: 'TV cam',
  heli: 'Heli cam',
  orbit: 'Orbit cam',
  bumper: 'Bumper cam',
};

export class CameraRig {
  camera = new THREE.PerspectiveCamera(62, 1, 0.05, 9000);
  mode: RigMode = 'chase';
  shake = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private yaw = 0;
  private initialized = false;
  private tvIndex = -1;
  private time = 0;
  private orbitAngle = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  fovBase = 62;
  lookBack = false;
  groundAt: ((x: number, z: number) => number) | null = null;
  /** Boxes around buildings the heli camera must not sit in or shoot through. */
  obstacles: THREE.Box3[] = [];
  private ray = new THREE.Ray();
  private tmp3 = new THREE.Vector3();
  private tmp4 = new THREE.Vector3();

  constructor(private track: Track, private spots: { pos: THREE.Vector3; s: number }[]) {}

  setMode(m: RigMode) {
    if (m !== this.mode) {
      this.mode = m;
      this.initialized = false;
      this.tvIndex = -1;
    }
  }

  cut() {
    this.initialized = false;
    this.tvIndex = -1;
  }

  addShake(v: number) {
    this.shake = Math.min(1.5, this.shake + v);
  }

  update(dt: number, target: Racer) {
    this.time += dt;
    const cam = this.camera;
    const kp = target.renderPos;
    const h = target.renderHeading;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const speed = Math.abs(target.phys.speed);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const surfaceShake = target.phys.onKerb * 0.25 + target.phys.onGrass * 0.35;
    const sh = Math.min(1.2, this.shake + surfaceShake * clamp(speed / 12, 0, 1));
    target.model.setCockpitView(this.mode === 'cockpit' && !this.lookBack);

    switch (this.mode) {
      case 'chase':
      case 'far': {
        const far = this.mode === 'far';
        const back = far ? 4.7 : 3.05;
        const up = far ? 1.85 : 1.12;
        // camera yaw follows the direction of travel slightly so slides read clearly
        const vx = target.phys.vx;
        const vz = target.phys.vz;
        let desiredYaw = h;
        if (speed > 3) {
          const velYaw = Math.atan2(vx, vz);
          desiredYaw = h + clamp(wrapAngle(velYaw - h), -0.6, 0.6) * 0.55;
        }
        if (this.lookBack) desiredYaw = h + Math.PI;
        if (!this.initialized) this.yaw = desiredYaw;
        this.yaw = dampAngle(this.yaw, desiredYaw, this.lookBack ? 30 : 6.5, dt);
        const dx = Math.sin(this.yaw);
        const dz = Math.cos(this.yaw);
        const desired = this.tmp.set(kp.x - dx * back, kp.y + up, kp.z - dz * back);
        if (!this.initialized) {
          this.pos.copy(desired);
          this.initialized = true;
        }
        this.pos.x = damp(this.pos.x, desired.x, 14, dt);
        this.pos.z = damp(this.pos.z, desired.z, 14, dt);
        this.pos.y = damp(this.pos.y, desired.y, 7, dt);
        if (this.groundAt) this.pos.y = Math.max(this.pos.y, this.groundAt(this.pos.x, this.pos.z) + 0.35);
        cam.position.copy(this.pos);
        this.look.set(kp.x + dx * 1.8, kp.y + (far ? 0.5 : 0.42), kp.z + dz * 1.8);
        cam.lookAt(this.look);
        cam.fov = this.fovBase + clamp(speed * 0.55, 0, 14);
        break;
      }
      case 'bumper': {
        cam.position.set(kp.x + fx * 0.3, kp.y + 0.55, kp.z + fz * 0.3);
        cam.lookAt(kp.x + fx * 10, kp.y + 0.35, kp.z + fz * 10);
        cam.fov = 70 + clamp(speed * 0.4, 0, 10);
        break;
      }
      case 'cockpit': {
        const body = target.model.body;
        body.updateMatrixWorld();
        const eye = this.tmp.set(-0.04 + clamp(-target.phys.latG * 0.02, -0.04, 0.04), 0.79, -0.33);
        body.localToWorld(eye);
        cam.position.copy(eye);
        const lookLocal = this.tmp2.set(-0.04 + clamp(target.phys.latG * 0.35, -0.8, 0.8), 0.62, this.lookBack ? -8 : 8);
        body.localToWorld(lookLocal);
        cam.up.set(0, 1, 0);
        cam.lookAt(lookLocal);
        cam.rotateZ(clamp(-target.phys.latG * 0.035, -0.06, 0.06));
        cam.fov = 74 + clamp(speed * 0.3, 0, 8);
        cam.near = 0.03;
        break;
      }
      case 'tv': {
        // choose the camera slightly ahead of the kart along the track
        const s = target.phys.proj.s;
        let best = this.tvIndex;
        const cur = best >= 0 ? this.spots[best] : null;
        const curD = cur ? this.track.deltaS(s, cur.s) : Infinity;
        if (!cur || curD < -26 || curD > 60) {
          let bd = Infinity;
          this.spots.forEach((sp, i) => {
            const dd = this.track.deltaS(s, sp.s);
            const score = Math.abs(dd - 16);
            if (dd > -5 && score < bd) {
              bd = score;
              best = i;
            }
          });
          if (best !== this.tvIndex) this.initialized = false;
          this.tvIndex = best;
        }
        const sp = this.spots[this.tvIndex];
        cam.position.copy(sp.pos);
        const tgt = this.tmp.set(kp.x, kp.y + 0.4, kp.z);
        if (!this.initialized) {
          this.look.copy(tgt);
          this.initialized = true;
        }
        this.look.x = damp(this.look.x, tgt.x, 9, dt);
        this.look.y = damp(this.look.y, tgt.y, 9, dt);
        this.look.z = damp(this.look.z, tgt.z, 9, dt);
        cam.lookAt(this.look);
        const dist = cam.position.distanceTo(tgt);
        cam.fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(3.6 / dist)), 7, 55);
        break;
      }
      case 'heli': {
        const a = this.time * 0.12;
        const r = 26;
        const desired = this.tmp.set(kp.x + Math.cos(a) * r, kp.y + 16, kp.z + Math.sin(a) * r);
        // climb over the grandstand roof, pit building or tower rather than film through them
        // (no height helps while the kart is under the bridge)
        if (!this.blocked(this.tmp4.set(kp.x, kp.y + 40, kp.z), kp)) for (let k = 0; k < 8 && this.blocked(desired, kp); k++) desired.y += 3;
        if (!this.initialized) {
          this.pos.copy(desired);
          this.look.copy(kp);
          this.initialized = true;
        }
        this.pos.lerp(desired, 1 - Math.exp(-2 * dt));
        this.look.lerp(kp, 1 - Math.exp(-5 * dt));
        cam.position.copy(this.pos);
        cam.lookAt(this.look);
        cam.fov = 38;
        break;
      }
      case 'orbit': {
        this.orbitAngle += dt * 0.25;
        const r = 5.2;
        cam.position.set(kp.x + Math.cos(this.orbitAngle) * r, kp.y + 1.5 + Math.sin(this.time * 0.3) * 0.4, kp.z + Math.sin(this.orbitAngle) * r);
        cam.lookAt(kp.x, kp.y + 0.4, kp.z);
        cam.fov = 45;
        break;
      }
    }
    if (this.mode !== 'cockpit') cam.near = 0.05;
    if (sh > 0.001 && this.mode !== 'tv' && this.mode !== 'heli') {
      const t = this.time * 38;
      cam.position.x += noise1(t, 1) * 0.02 * sh;
      cam.position.y += noise1(t, 2) * 0.025 * sh;
      cam.rotateZ(noise1(t, 3) * 0.006 * sh);
    }
    cam.updateProjectionMatrix();
  }

  private blocked(from: THREE.Vector3, to: THREE.Vector3) {
    const d = this.tmp2.copy(to).sub(from);
    const len = d.length();
    this.ray.set(from, d.divideScalar(len));
    for (const b of this.obstacles) {
      if (b.containsPoint(from)) return true;
      const hit = this.ray.intersectBox(b, this.tmp3);
      if (hit && hit.distanceTo(from) < len) return true;
    }
    return false;
  }
}
