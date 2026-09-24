import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { helmet as helmetTex } from '../render/textures';
import { clamp } from '../core/math';

// Seated kart driver with analytic two-bone IK for arms and legs, so hands stay
// on the (rotating) steering wheel and feet follow the (sliding) pedals.

export interface DriverLivery {
  suit: number;
  accent: number;
  helmet: string;
  helmet2: string;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

interface Limb {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  end: THREE.Mesh;
  l1: number;
  l2: number;
  root: THREE.Vector3; // driver-local joint
  pole: THREE.Vector3;
}

export class DriverModel {
  group = new THREE.Group();
  torso = new THREE.Group();
  head = new THREE.Group();
  helmetMesh!: THREE.Mesh;
  arms: Limb[] = [];
  legs: Limb[] = [];
  /** Kart-space position of the hip centre (driver origin). */
  hip = new THREE.Vector3(-0.04, 0.15, -0.23);
  scale = 1;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private lean = 0;
  private headTilt = 0;

  constructor(livery: DriverLivery, mats: { black: THREE.Material }) {
    const suitMat = new THREE.MeshStandardMaterial({ color: livery.suit, roughness: 0.75, vertexColors: true });
    const limbMat = new THREE.MeshStandardMaterial({ color: livery.suit, roughness: 0.75 });
    const accentMat = new THREE.MeshStandardMaterial({ color: livery.accent, roughness: 0.55 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: livery.accent, roughness: 0.6 });

    this.group.position.copy(this.hip);
    this.group.add(this.torso);

    // --- Torso: lofted along a reclined spine with suit panels in vertex colours.
    const spineDir = new THREE.Vector3(0, 0.42, -0.14).normalize();
    const rings: THREE.Vector3[][] = [];
    const specs: [number, number, number][] = [
      // t along spine (m), half-width, half-depth
      [-0.04, 0.12, 0.09],
      [0.02, 0.165, 0.11],
      [0.12, 0.15, 0.1],
      [0.24, 0.17, 0.11],
      [0.34, 0.19, 0.105],
      [0.41, 0.17, 0.09],
      [0.45, 0.07, 0.06],
    ];
    const side = new THREE.Vector3(1, 0, 0);
    const fwd = new THREE.Vector3().crossVectors(side, spineDir).normalize(); // chest direction
    const seg = 22;
    for (const [t, a, b] of specs) {
      const c = spineDir.clone().multiplyScalar(t);
      const ring: THREE.Vector3[] = [];
      for (let i = 0; i < seg; i++) {
        const ang = (i / seg) * Math.PI * 2;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const x = a * Math.sign(cs) * Math.pow(Math.abs(cs), 2 / 2.6);
        const y = b * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / 2.6);
        ring.push(c.clone().addScaledVector(side, x).addScaledVector(fwd, y));
      }
      rings.push(ring);
    }
    const black = new THREE.Color(0x151515);
    const white = new THREE.Color(0xffffff);
    const accent = new THREE.Color(livery.accent);
    const torsoGeo = buildRingMesh(rings, (ri, pi) => {
      const ang = (pi / seg) * Math.PI * 2;
      const sideAmt = Math.abs(Math.cos(ang));
      if (ri >= 4) return black; // shoulders / collar
      if (sideAmt > 0.86) return black; // side panels
      if (ri === 2 && Math.sin(ang) > 0.2) return accent; // chest band
      return white;
    });
    const torsoMesh = new THREE.Mesh(torsoGeo, suitMat);
    torsoMesh.castShadow = true;
    this.torso.add(torsoMesh);

    // --- Head: neck + helmet with iridescent visor
    const neckTop = spineDir.clone().multiplyScalar(0.5);
    this.head.position.copy(neckTop);
    this.torso.add(this.head);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.09, 12), mats.black);
    neck.position.set(0, -0.02, 0);
    this.head.add(neck);
    const hGeo = new THREE.SphereGeometry(0.135, 32, 24);
    hGeo.scale(0.93, 1.0, 1.08);
    const helmetMat = new THREE.MeshPhysicalMaterial({
      map: helmetTex(livery.helmet, livery.helmet2),
      roughness: 0.25,
      clearcoat: 0.8,
      clearcoatRoughness: 0.12,
    });
    this.helmetMesh = new THREE.Mesh(hGeo, helmetMat);
    this.helmetMesh.rotation.y = Math.PI / 2; // put the livery stripes on the sides
    this.helmetMesh.position.set(0, 0.13, 0.01);
    this.helmetMesh.castShadow = true;
    this.head.add(this.helmetMesh);
    const visorGeo = new THREE.SphereGeometry(0.139, 28, 10, Math.PI / 2 - 0.95, 1.9, 1.28, 0.5);
    visorGeo.scale(0.93, 1.0, 1.08);
    const visor = new THREE.Mesh(
      visorGeo,
      new THREE.MeshPhysicalMaterial({
        color: 0x0c0e12,
        metalness: 0.7,
        roughness: 0.06,
        iridescence: 1,
        iridescenceIOR: 1.6,
        iridescenceThicknessRange: [250, 700],
        envMapIntensity: 1.6,
      }),
    );
    visor.position.copy(this.helmetMesh.position);
    this.head.add(visor);
    // chin bar vent (accent)
    const chin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.02), accentMat);
    chin.position.set(0, 0.03, 0.14);
    this.head.add(chin);
    this.helmetMesh.userData.hideInCockpit = true;
    visor.userData.hideInCockpit = true;
    chin.userData.hideInCockpit = true;

    // --- Limbs
    const mkLimb = (
      root: THREE.Vector3,
      l1: number,
      l2: number,
      r1: number,
      r2: number,
      endGeo: THREE.BufferGeometry,
      endMat: THREE.Material,
      pole: THREE.Vector3,
      parent: THREE.Object3D,
    ): Limb => {
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(r1, l1 - r1, 4, 10), limbMat);
      const lower = new THREE.Mesh(new THREE.CapsuleGeometry(r2, l2 - r2, 4, 10), limbMat);
      const end = new THREE.Mesh(endGeo, endMat);
      [upper, lower, end].forEach((m) => {
        m.castShadow = true;
        parent.add(m);
      });
      return { upper, lower, end, l1, l2, root, pole };
    };

    const glove = new THREE.SphereGeometry(1, 12, 8);
    glove.scale(0.042, 0.036, 0.058);
    const boot = new RoundedBoxGeometry(0.085, 0.075, 0.2, 2, 0.025);
    boot.translate(0, 0, 0.06);
    const bootMat = new THREE.MeshStandardMaterial({ color: livery.accent, roughness: 0.5 });

    // Shoulders ride on the torso (they lean with it), so arms are parented to the driver group
    // and their roots are recomputed from the torso transform each frame.
    for (const s of [1, -1]) {
      this.arms.push(
        mkLimb(new THREE.Vector3(0.175 * s, 0.37, -0.15), 0.31, 0.3, 0.047, 0.04, glove, gloveMat, new THREE.Vector3(0.9 * s, -0.8, 0.1), this.group),
      );
    }
    for (const s of [1, -1]) {
      this.legs.push(
        mkLimb(new THREE.Vector3(0.085 * s, 0.0, 0.03), 0.43, 0.41, 0.066, 0.05, boot, bootMat, new THREE.Vector3(0.25 * s, 1, 0.2), this.group),
      );
    }
  }

  setHeight(cm: number) {
    this.scale = cm / 175;
    this.group.scale.setScalar(this.scale);
  }

  /**
   * @param hands kart-space grip targets [left, right]
   * @param feet kart-space pedal targets [left, right]
   */
  update(hands: THREE.Vector3[], feet: THREE.Vector3[], latG: number, longG: number, dt: number) {
    // Body lean: torso rolls away from the corner, head fights back to level.
    const k = 1 - Math.exp(-8 * dt);
    this.lean += (clamp(latG * 0.11, -0.2, 0.2) - this.lean) * k;
    this.headTilt += (clamp(-latG * 0.16, -0.3, 0.3) - this.headTilt) * k;
    this.torso.rotation.set(clamp(-longG * 0.05, -0.08, 0.08), 0, this.lean);
    this.head.rotation.set(0, 0, this.headTilt);
    this.torso.updateMatrix();

    const inv = 1 / this.scale;
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      const root = this.tmpA.copy(arm.root).applyMatrix4(this.torso.matrix);
      const target = this.tmpC.copy(hands[i]).sub(this.hip).multiplyScalar(inv);
      this.solve(arm, root, target);
      const leg = this.legs[i];
      const lroot = this.tmpA.copy(leg.root);
      const ltarget = this.tmpC.copy(feet[i]).sub(this.hip).multiplyScalar(inv);
      this.solve(leg, lroot, ltarget, true);
    }
  }

  private solve(limb: Limb, A: THREE.Vector3, C: THREE.Vector3, isLeg = false) {
    const { l1, l2 } = limb;
    const d = this.tmpB.copy(C).sub(A);
    let dist = d.length();
    const straight = (l1 + l2) * 0.98;
    if (!isLeg && dist > straight) {
      // near full lock the grip swings out of reach: roll the shoulder forward (up to 5 cm)
      // rather than let the hand leave the wheel
      A.addScaledVector(d, Math.min(dist - straight, 0.05) / dist);
      dist = d.copy(C).sub(A).length();
    }
    dist = clamp(dist, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    const dir = d.normalize();
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pole = limb.pole.clone().addScaledVector(dir, -limb.pole.dot(dir)).normalize();
    const B = A.clone().addScaledVector(dir, a).addScaledVector(pole, h);
    const end = A.clone().addScaledVector(dir, dist);
    placeBone(limb.upper, A, B);
    placeBone(limb.lower, B, end);
    limb.end.position.copy(end);
    if (isLeg) {
      // boots point forward along the pedal face
      limb.end.rotation.set(-0.75, 0, 0);
    } else {
      limb.end.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), end.clone().sub(B).normalize());
    }
  }
}

function placeBone(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a);
  const len = dir.length();
  if (len < 1e-5) return;
  mesh.quaternion.setFromUnitVectors(Y_AXIS, dir.divideScalar(len));
}

function buildRingMesh(rings: THREE.Vector3[][], color: (ri: number, pi: number) => THREE.Color) {
  const nR = rings.length;
  const nP = rings[0].length;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < nR; i++)
    for (let j = 0; j < nP; j++) {
      const p = rings[i][j];
      pos.push(p.x, p.y, p.z);
      const c = color(i, j);
      col.push(c.r, c.g, c.b);
    }
  for (let i = 0; i < nR - 1; i++)
    for (let j = 0; j < nP; j++) {
      const a = i * nP + j;
      const b = i * nP + ((j + 1) % nP);
      const c = a + nP;
      const d = b + nP;
      idx.push(a, b, c, b, d, c);
    }
  // caps
  const addCap = (ri: number, flip: boolean) => {
    const center = rings[ri].reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(nP);
    const ci = pos.length / 3;
    pos.push(center.x, center.y, center.z);
    const c = color(ri, 0);
    col.push(c.r, c.g, c.b);
    for (let j = 0; j < nP; j++) {
      const a = ri * nP + j;
      const b = ri * nP + ((j + 1) % nP);
      if (flip) idx.push(ci, b, a);
      else idx.push(ci, a, b);
    }
  };
  addCap(0, true);
  addCap(nR - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // ensure outward normals
  const n = g.getAttribute('normal');
  let score = 0;
  for (let i = 0; i < nR; i++) {
    const center = rings[i].reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(nP);
    for (let j = 0; j < nP; j++) {
      const k = i * nP + j;
      score += (pos[k * 3] - center.x) * n.getX(k) + (pos[k * 3 + 1] - center.y) * n.getY(k) + (pos[k * 3 + 2] - center.z) * n.getZ(k);
    }
  }
  if (score < 0) {
    for (let k = 0; k < idx.length; k += 3) {
      const t = idx[k + 1];
      idx[k + 1] = idx[k + 2];
      idx[k + 2] = t;
    }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}
