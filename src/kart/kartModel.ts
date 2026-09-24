import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { interpolateRings, loftRings, nonIndexed, polarRing, Ring, superellipse, sweep, tube, v3 } from '../render/loft';
import { brakeDisc, carbon, numberPlate, tireSidewall } from '../render/textures';
import { DIM } from './kartSpecs';
import { DriverModel } from './driverModel';
import { clamp } from '../core/math';

// Procedural model of the Toyota GR KART (2026) built to the published
// dimensions: 1,820 L × 1,160 W × 670 H mm, 1,045 mm wheelbase.
// Local space: +Z forward, +X = driver's left, +Y up, origin = wheelbase centre at ground.

export interface KartLivery {
  name: string;
  code: string;
  number: number;
  accent: number;
  accent2: number;
  helmet: string;
  helmet2: string;
}

export const LIVERIES: KartLivery[] = [
  { name: 'You', code: 'YOU', number: 1, accent: 0xe0001b, accent2: 0x111111, helmet: '#e0001b', helmet2: '#111111' },
  { name: 'Haruto Sato', code: 'SAT', number: 7, accent: 0x1565ff, accent2: 0x0a1a40, helmet: '#1565ff', helmet2: '#ffd400' },
  { name: 'Mia Keller', code: 'KEL', number: 22, accent: 0xffc400, accent2: 0x111111, helmet: '#ffc400', helmet2: '#111111' },
  { name: 'Yuki Tanaka', code: 'TAN', number: 11, accent: 0x13b36b, accent2: 0x0b3b25, helmet: '#13b36b', helmet2: '#ffffff' },
  { name: 'Lucas Moreau', code: 'MOR', number: 4, accent: 0xff6a00, accent2: 0x2b1200, helmet: '#ff6a00', helmet2: '#1b1b1b' },
  { name: 'Aiko Mori', code: 'AIK', number: 31, accent: 0x9b3cff, accent2: 0x1c0836, helmet: '#9b3cff', helmet2: '#ff4fa3' },
  { name: 'Diego Ruiz', code: 'RUI', number: 16, accent: 0x00b7d4, accent2: 0x05303a, helmet: '#00b7d4', helmet2: '#ffffff' },
  { name: 'Sofia Rossi', code: 'ROS', number: 9, accent: 0xff3f8e, accent2: 0x3a0a1f, helmet: '#ff3f8e', helmet2: '#111111' },
];

export interface KartVisualState {
  steerAngle: number; // front wheel angle, + = left
  speed: number; // forward m/s
  throttle: number;
  brake: number;
  latG: number;
  longG: number;
  pitch: number;
  roll: number;
  rpm: number;
  onKerb?: number;
}

export type KartDetail = 'showroom' | 'race' | 'ghost';

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

function makeMaterials(livery: KartLivery) {
  return {
    bodyVC: new THREE.MeshPhysicalMaterial({
      color: 0xe4e4df,
      roughness: 0.46,
      clearcoat: 0.3,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.75,
      vertexColors: true,
    }),
    frame: new THREE.MeshPhysicalMaterial({
      color: 0xc3121c,
      roughness: 0.28,
      metalness: 0.05,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
    }),
    black: new THREE.MeshStandardMaterial({ color: 0x131315, roughness: 0.55 }),
    seat: new THREE.MeshPhysicalMaterial({ color: 0x141416, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.3, side: THREE.DoubleSide }),
    carbon: new THREE.MeshPhysicalMaterial({ map: carbon(), roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.88 }),
    rim: new THREE.MeshStandardMaterial({ color: 0x1f2023, metalness: 0.75, roughness: 0.33 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xd6d8dc, metalness: 1, roughness: 0.2 }),
    alu: new THREE.MeshStandardMaterial({ color: 0xa3a6ab, metalness: 0.9, roughness: 0.38 }),
    engine: new THREE.MeshStandardMaterial({ color: 0x28292c, metalness: 0.45, roughness: 0.48 }),
    tank: new THREE.MeshPhysicalMaterial({
      color: 0xf2efe4,
      roughness: 0.25,
      transparent: true,
      opacity: 0.82,
      clearcoat: 0.4,
    }),
    fuel: new THREE.MeshStandardMaterial({ color: 0xc9a441, roughness: 0.3, transparent: true, opacity: 0.55 }),
    accent: new THREE.MeshStandardMaterial({ color: livery.accent, roughness: 0.4 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xffd21a, roughness: 0.5 }),
    mirror: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.02 }),
    sidewall: new THREE.MeshStandardMaterial({
      map: tireSidewall(),
      transparent: true,
      roughness: 0.7,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
    disc: new THREE.MeshStandardMaterial({ map: brakeDisc(), metalness: 0.8, roughness: 0.35 }),
    number: new THREE.MeshStandardMaterial({ map: numberPlate(livery.number, hex(livery.accent)), roughness: 0.45 }),
  };
}

type Mats = ReturnType<typeof makeMaterials>;

export class KartModel {
  root = new THREE.Group(); // world transform
  body = new THREE.Group(); // pitch/roll
  parts: Record<string, THREE.Object3D> = {};
  explodeOffsets: Record<string, THREE.Vector3> = {};
  private basePos: Record<string, THREE.Vector3> = {};
  steerPivots: THREE.Object3D[] = [];
  frontSpin: THREE.Object3D[] = [];
  rearSpin = new THREE.Group();
  steerColumn = new THREE.Group();
  steeringWheel = new THREE.Group();
  pedalGroup = new THREE.Group();
  throttlePedal = new THREE.Group();
  brakePedal = new THREE.Group();
  driver: DriverModel | null = null;
  mats: Mats;
  livery: KartLivery;
  detail: KartDetail;

  private frontAngle = 0;
  private rearAngle = 0;
  private vib = 0;
  columnTilt = 0; // extra tilt (rad) for driver-fit adjustment
  pedalSlide = 0; // metres, + = towards driver
  private tmpV = new THREE.Vector3();
  private hands = [new THREE.Vector3(), new THREE.Vector3()];
  private feet = [new THREE.Vector3(), new THREE.Vector3()];

  constructor(livery: KartLivery, detail: KartDetail = 'race', withDriver = true) {
    this.livery = livery;
    this.detail = detail;
    this.mats = makeMaterials(livery);
    this.root.add(this.body);
    this.root.name = `kart-${livery.code}`;

    this.buildChassis();
    this.buildBodywork();
    this.buildSeatAndFloor();
    this.buildEngine();
    this.buildRearAxle();
    this.buildFrontWheels();
    this.buildSteering();
    this.buildPedals();
    this.buildExtras();

    if (withDriver) {
      this.driver = new DriverModel(
        { suit: 0xf6f6f4, accent: livery.accent, helmet: livery.helmet, helmet2: livery.helmet2 },
        { black: this.mats.black },
      );
      this.addPart('driver', this.driver.group, v3(0, 0.9, -0.3));
    }

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = detail === 'showroom';
      }
    });

    if (detail !== 'showroom') {
      this.mergeStatic();
      // the rear wheels turn with the axle, so fold them into it and merge across both sides
      this.rearSpin.children.filter((c) => !(c as THREE.Mesh).isMesh).forEach(flatten);
      // collapse the small moving assemblies too (each front wheel, the axle, the steering wheel)
      [...this.frontSpin, this.rearSpin, this.steeringWheel, this.steerColumn].forEach(collapse);
    }
    if (detail === 'ghost') this.applyGhost();
    this.update({ steerAngle: 0, speed: 0, throttle: 0, brake: 0, latG: 0, longG: 0, pitch: 0, roll: 0, rpm: 0 }, 0);
  }

  private addPart(name: string, obj: THREE.Object3D, explode: THREE.Vector3, parent: THREE.Object3D = this.body) {
    obj.name = name;
    this.parts[name] = obj;
    this.explodeOffsets[name] = explode;
    this.basePos[name] = obj.position.clone();
    parent.add(obj);
  }

  private group(name: string, explode: THREE.Vector3, ...meshes: THREE.Object3D[]) {
    const g = new THREE.Group();
    meshes.forEach((m) => g.add(m));
    this.addPart(name, g, explode);
    return g;
  }

  // ---------------------------------------------------------------- chassis
  private buildChassis() {
    const m = this.mats.frame;
    const R = 0.015;
    const geos: THREE.BufferGeometry[] = [];
    const mirror = (pts: THREE.Vector3[]) => pts.map((p) => v3(-p.x, p.y, p.z));
    const both = (pts: THREE.Vector3[], r = R) => {
      geos.push(tube(pts, r));
      geos.push(tube(mirror(pts), r));
    };
    // Main rails
    both([v3(0.13, 0.06, 0.74), v3(0.19, 0.058, 0.58), v3(0.24, 0.058, 0.3), v3(0.29, 0.06, -0.08), v3(0.33, 0.07, -0.38), v3(0.31, 0.085, -0.62)]);
    // Side nerf bars (carry the side pods)
    both([v3(0.24, 0.06, 0.36), v3(0.42, 0.1, 0.32), v3(0.46, 0.105, 0.0), v3(0.45, 0.1, -0.26), v3(0.33, 0.07, -0.34)], 0.012);
    // Front axle beam with kingpin brackets
    geos.push(tube([v3(-0.4, 0.125, 0.5225), v3(-0.3, 0.1, 0.52), v3(0, 0.07, 0.52), v3(0.3, 0.1, 0.52), v3(0.4, 0.125, 0.5225)], R));
    // Nose bar & front bumper loop
    geos.push(tube([v3(-0.13, 0.06, 0.74), v3(0, 0.055, 0.77), v3(0.13, 0.06, 0.74)], R));
    geos.push(tube([v3(-0.3, 0.09, 0.62), v3(-0.22, 0.1, 0.8), v3(0, 0.1, 0.84), v3(0.22, 0.1, 0.8), v3(0.3, 0.09, 0.62)], 0.011));
    // Cross members
    geos.push(tube([v3(-0.29, 0.06, -0.08), v3(0, 0.055, -0.08), v3(0.29, 0.06, -0.08)], R));
    geos.push(tube([v3(-0.33, 0.07, -0.38), v3(0, 0.065, -0.38), v3(0.33, 0.07, -0.38)], R));
    // Rear bumper frame
    geos.push(
      tube([v3(-0.31, 0.085, -0.62), v3(-0.46, 0.13, -0.78), v3(-0.2, 0.15, -0.86), v3(0.2, 0.15, -0.86), v3(0.46, 0.13, -0.78), v3(0.31, 0.085, -0.62)], 0.013),
    );
    // Seat struts
    both([v3(0.2, 0.07, -0.38), v3(0.19, 0.25, -0.44), v3(0.17, 0.4, -0.47)], 0.01);
    // Steering column A-frame
    both([v3(0.12, 0.06, 0.56), v3(0.03, 0.14, 0.51)], 0.012);
    // Diagonal braces
    both([v3(0.24, 0.058, 0.3), v3(0.05, 0.056, 0.1)], 0.011);
    const chassis = new THREE.Mesh(mergeGeometries(geos.map(nonIndexed)), m);

    // Axle bearing hangers & spindle uprights (red plates)
    const hangerGeo = new RoundedBoxGeometry(0.02, 0.1, 0.08, 1, 0.008);
    const hangers: THREE.Mesh[] = [];
    for (const x of [-0.31, 0.31]) {
      const h = new THREE.Mesh(hangerGeo, m);
      h.position.set(x, 0.12, -0.5225);
      hangers.push(h);
    }
    this.group('chassis', v3(0, 0, 0), chassis, ...hangers);
  }

  // --------------------------------------------------------------- bodywork
  private buildBodywork() {
    const accent = new THREE.Color(this.livery.accent);
    const accent2 = new THREE.Color(this.livery.accent2);
    const white = new THREE.Color(1, 1, 1);
    const SEG = this.detail === 'showroom' ? 56 : 40;

    // Side pods — sculpted superellipse sections that rise towards the rear.
    const podKeys: [number, number, number, number, number, number][] = [
      // z,     cx,    cy,    a,     b,     n
      [0.39, 0.47, 0.125, 0.03, 0.035, 2.4],
      [0.365, 0.472, 0.135, 0.078, 0.07, 3.0],
      [0.3, 0.476, 0.145, 0.1, 0.085, 3.8],
      [0.15, 0.481, 0.158, 0.106, 0.098, 4.2],
      [-0.03, 0.484, 0.19, 0.106, 0.128, 4.2],
      [-0.18, 0.484, 0.235, 0.1, 0.165, 4.0],
      [-0.29, 0.478, 0.27, 0.085, 0.15, 3.6],
      [-0.36, 0.47, 0.325, 0.07, 0.085, 3.2],
      [-0.42, 0.462, 0.36, 0.05, 0.045, 2.6],
      [-0.445, 0.458, 0.365, 0.02, 0.02, 2.2],
    ];
    const podRings: Ring[] = podKeys.map(([z, cx, cy, a, b, n]) =>
      superellipse(a, b, n, SEG).map((p) => {
        // subtle horizontal character groove on the outer face
        const groove = p.x > a * 0.55 ? 0.011 * Math.exp(-(((p.y + 0.012) / 0.022) ** 2)) : 0;
        return v3(cx + p.x - groove, cy + p.y, z);
      }),
    );
    const podSteps = this.detail === 'showroom' ? 10 : 6;
    const podRingCount = (podKeys.length - 1) * podSteps + 1;
    const podColor = (ri: number, pi: number) => {
      const t = (pi / SEG) * Math.PI * 2;
      const along = ri / (podRingCount - 1); // 0 front .. 1 rear
      if (along < 0.08) return white;
      // accent sweep on the upper outer shoulder, rising towards the rear
      const lo = 0.1 + along * 0.1;
      if (t > lo * Math.PI && t < (lo + 0.13) * Math.PI) return accent;
      if (t > (lo + 0.13) * Math.PI && t < (lo + 0.16) * Math.PI) return accent2;
      return white;
    };
    const podGeoL = loftRings(interpolateRings(podRings, podSteps), { capStart: true, capEnd: true, colorFn: podColor });
    const podL = new THREE.Mesh(podGeoL, this.mats.bodyVC);
    const podR = new THREE.Mesh(mirrorX(podGeoL), this.mats.bodyVC);
    // Race numbers on the pods
    const numGeo = new THREE.PlaneGeometry(0.12, 0.12);
    const numL = new THREE.Mesh(numGeo, this.mats.number);
    numL.position.set(0.5885, 0.23, -0.2);
    numL.rotation.y = Math.PI / 2;
    const numR = new THREE.Mesh(numGeo, this.mats.number);
    numR.position.set(-0.5885, 0.23, -0.2);
    numR.rotation.y = -Math.PI / 2;
    this.group('podL', v3(0.55, 0.12, 0), podL, numL);
    this.group('podR', v3(-0.55, 0.12, 0), podR, numR);

    // Nose — lofted across the width; section in (z,y) wraps back at the ends.
    const noseRings: Ring[] = [];
    const nxs = [-0.57, -0.555, -0.52, -0.45, -0.33, -0.18, 0, 0.18, 0.33, 0.45, 0.52, 0.555, 0.57];
    for (const x of nxs) {
      const s = x / 0.56;
      const ax = Math.abs(x);
      const end = ax > 0.54 ? (ax > 0.56 ? 0.25 : 0.7) : 1;
      const zc = 0.8 - 0.05 * s ** 4;
      const dz = (0.112 - 0.045 * s * s) * end;
      const yc = 0.14 + 0.065 * s ** 4;
      const dy = (0.082 - 0.008 * s * s) * end;
      noseRings.push(
        superellipse(dz, dy, 3.4, SEG).map((p) => {
          // wedge: the top rises towards the fairing; a scoop on the upper front face
          const shear = -p.x * 0.34;
          const scoop = p.x > 0 && p.y > 0 ? 0.012 * Math.sin((p.y / dy) * Math.PI) * (1 - Math.abs(s)) : 0;
          return v3(x, yc + p.y + shear * (p.y > 0 ? 1 : 0.25), zc + p.x - scoop);
        }),
      );
    }
    const noseColor = (_ri: number, _pi: number, p: THREE.Vector3) => {
      // GR-style chevron: a centre stripe plus sweeps on the upswept tips
      if (p.y > 0.18 && Math.abs(p.x) < 0.05) return accent;
      if (p.y > 0.18 && Math.abs(p.x) < 0.064) return accent2;
      return white;
    };
    const nose = new THREE.Mesh(loftRings(interpolateRings(noseRings, this.detail === 'showroom' ? 7 : 4), { capStart: true, capEnd: true, colorFn: noseColor }), this.mats.bodyVC);
    this.group('nose', v3(0, 0.12, 0.55), nose);

    // Front fairing — an arched shell that rises from the nose to the steering column.
    const fairKeys: [number, number, number, number][] = [
      // z,    half-width, top y, bottom y
      [0.675, 0.17, 0.25, 0.165],
      [0.62, 0.225, 0.305, 0.14],
      [0.54, 0.258, 0.375, 0.13],
      [0.46, 0.27, 0.44, 0.135],
      [0.395, 0.255, 0.485, 0.17],
      [0.355, 0.22, 0.5, 0.235],
    ];
    const TH = 0.014;
    const HS = this.detail === 'showroom' ? 28 : 18;
    const fairRings: Ring[] = fairKeys.map(([z, w, yt, yb]) => {
      const h = yt - yb;
      const taper = (p: THREE.Vector2, hh: number) => v3(p.x * (1 - 0.32 * Math.max(0, p.y / hh) ** 1.5), yb + p.y, z);
      const outer = superellipse(w, h, 3.6, HS, 0, Math.PI).map((p) => taper(p, h));
      const inner = superellipse(w - TH, h - TH, 3.6, HS, 0, Math.PI)
        .map((p) => taper(p, h - TH))
        .reverse();
      return [...outer, ...inner];
    });
    const fairColor = (_ri: number, _pi: number, p: THREE.Vector3) => {
      // a clean racing band over the crown of the fairing
      if (p.z > 0.43 && p.z < 0.5 && p.y > 0.33) return accent;
      if (p.z >= 0.5 && p.z < 0.52 && p.y > 0.3) return accent2;
      return white;
    };
    const fairing = new THREE.Mesh(loftRings(interpolateRings(fairRings, this.detail === 'showroom' ? 8 : 5), { colorFn: fairColor }), this.mats.bodyVC);
    const fairMatDS = this.mats.bodyVC.clone();
    fairMatDS.side = THREE.DoubleSide;
    fairing.material = fairMatDS;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), this.mats.number);
    plate.position.set(0, 0.302, 0.632);
    plate.rotation.x = -0.82;
    this.group('fairing', v3(0, 0.42, 0.28), fairing, plate);

    // Rear bumper — full-width anti-climb shell.
    const bRings: Ring[] = [];
    const bxs = [-0.585, -0.57, -0.52, -0.4, -0.2, 0, 0.2, 0.4, 0.52, 0.57, 0.585];
    for (const x of bxs) {
      const s = x / 0.56;
      const end = Math.abs(x) > 0.56 ? (Math.abs(x) > 0.58 ? 0.3 : 0.75) : 1;
      const zc = -0.83 + 0.075 * s ** 4;
      const dz = 0.074 * end;
      const yc = 0.165 + 0.035 * s * s;
      const dy = (0.095 + 0.025 * s * s) * end;
      bRings.push(superellipse(dz, dy, 3.4, SEG).map((p) => v3(x, yc + p.y, zc + p.x)));
    }
    const bColor = (_ri: number, pi: number, p: THREE.Vector3) => {
      // band keyed to the section angle so it follows the sculpted surface cleanly
      const t = pi / SEG;
      if (Math.abs(p.x) < 0.5 && t > 0.3 && t < 0.345) return accent;
      if (Math.abs(p.x) < 0.5 && t >= 0.345 && t < 0.36) return accent2;
      return white;
    };
    const bumper = new THREE.Mesh(loftRings(interpolateRings(bRings, this.detail === 'showroom' ? 6 : 3), { capStart: true, capEnd: true, colorFn: bColor }), this.mats.bodyVC);
    this.group('bumper', v3(0, 0.1, -0.55), bumper);
  }

  // ---------------------------------------------------- seat, floor, tank
  private buildSeatAndFloor() {
    // Seat: U-sections swept along a reclined spine.
    const spine = [v3(-0.04, 0.12, 0.04), v3(-0.04, 0.128, -0.1), v3(-0.04, 0.14, -0.24), v3(-0.04, 0.2, -0.36), v3(-0.04, 0.35, -0.43), v3(-0.04, 0.52, -0.48), v3(-0.04, 0.625, -0.5)];
    const depth = [0.05, 0.072, 0.08, 0.09, 0.1, 0.09, 0.07];
    const width = [0.165, 0.185, 0.198, 0.2, 0.2, 0.2, 0.19];
    const HS = 12;
    const rings: Ring[] = spine.map((p, i) => {
      const prev = spine[Math.max(0, i - 1)];
      const next = spine[Math.min(spine.length - 1, i + 1)];
      const T = next.clone().sub(prev).normalize();
      const N = v3(0, -T.z, T.y).normalize(); // opening direction (towards the driver)
      const X = v3(1, 0, 0);
      const W = width[i];
      const D = depth[i];
      const outer: THREE.Vector3[] = [];
      const inner: THREE.Vector3[] = [];
      for (let k = 0; k <= HS; k++) {
        const t = (k / HS) * Math.PI;
        const cx = -Math.cos(t);
        const sy = -Math.sin(t);
        outer.push(p.clone().addScaledVector(X, cx * W).addScaledVector(N, sy * D));
        inner.push(p.clone().addScaledVector(X, cx * (W - 0.008)).addScaledVector(N, sy * (D - 0.008)));
      }
      return [...outer, ...inner.reverse()];
    });
    const seat = new THREE.Mesh(loftRings(interpolateRings(rings, 4)), this.mats.seat);
    // hand guard fin on the muffler side
    const guard = new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.16, 0.16, 1, 0.005), this.mats.seat);
    guard.position.set(0.17, 0.42, -0.46);
    guard.rotation.x = 0.35;
    this.group('seat', v3(0, 0.55, -0.1), seat, guard);

    // Carbon floor pan
    const floor = new THREE.Mesh(
      flatPlate(
        [
          [-0.17, 0.72],
          [0.17, 0.72],
          [0.27, -0.2],
          [-0.27, -0.2],
        ],
        0.006,
      ),
      this.mats.carbon,
    );
    floor.position.y = 0.045;
    this.group('floor', v3(0, -0.1, 0), floor);

    // Translucent fuel tank between the driver's legs, with visible fuel level
    const tank = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.13, 0.19, 3, 0.03), this.mats.tank);
    tank.position.set(0, 0.125, 0.34);
    const fuel = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.07, 0.17, 2, 0.02), this.mats.fuel);
    fuel.position.set(0, 0.095, 0.34);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.02, 16), this.mats.black);
    cap.position.set(0, 0.2, 0.38);
    this.group('tank', v3(0, 0.3, 0.15), fuel, tank, cap);

    // Ballast box with transponder mount
    const box = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.07, 0.15, 2, 0.01), this.mats.black);
    box.position.set(0.23, 0.095, 0.1);
    const transponder = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.03, 0.07, 1, 0.006), this.mats.yellow);
    transponder.position.set(0.23, 0.145, 0.1);
    this.group('weightbox', v3(0.32, 0.12, 0.15), box, transponder);
  }

  // ------------------------------------------------------------------ engine
  private buildEngine() {
    const M = this.mats;
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      g.add(mesh);
      return mesh;
    };
    // Engine mount plate
    add(new RoundedBoxGeometry(0.2, 0.012, 0.26, 1, 0.004), M.alu, 0.31, 0.075, -0.23);
    // Crankcase
    add(new RoundedBoxGeometry(0.17, 0.15, 0.22, 3, 0.025), M.alu, 0.31, 0.155, -0.23);
    // Inclined cylinder with cooling fins
    const cyl = new THREE.Group();
    cyl.position.set(0.3, 0.25, -0.13);
    cyl.rotation.x = -0.55;
    g.add(cyl);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 16), M.alu);
    barrel.position.y = 0.05;
    cyl.add(barrel);
    for (let i = 0; i < 6; i++) {
      const fin = new THREE.Mesh(new RoundedBoxGeometry(0.13, 0.006, 0.12, 1, 0.003), M.alu);
      fin.position.y = 0.0 + i * 0.022;
      cyl.add(fin);
    }
    const headCover = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.05, 0.11, 2, 0.015), M.engine);
    headCover.position.y = 0.145;
    cyl.add(headCover);
    // Fan shroud & top cover (black)
    add(new RoundedBoxGeometry(0.19, 0.13, 0.2, 4, 0.04), M.black, 0.32, 0.3, -0.29);
    // Air cleaner canister
    add(new THREE.CylinderGeometry(0.058, 0.058, 0.07, 24), M.black, 0.3, 0.37, -0.02, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.008, 24), M.accent, 0.338, 0.37, -0.02, 0, 0, Math.PI / 2);
    // Diaphragm carburettor
    const carb = add(new RoundedBoxGeometry(0.05, 0.045, 0.05, 1, 0.008), M.alu, 0.3, 0.33, -0.07);
    carb.name = 'carb';
    // Primer bulb
    add(new THREE.SphereGeometry(0.014, 12, 8), M.black, 0.35, 0.34, -0.07);
    // Muffler with exhaust header
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.19, 20), M.steel, 0.25, 0.29, -0.47, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.052, 0.052, 0.01, 20), M.alu, 0.155, 0.29, -0.47, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.052, 0.052, 0.01, 20), M.alu, 0.345, 0.29, -0.47, 0, 0, Math.PI / 2);
    g.add(new THREE.Mesh(tube([v3(0.28, 0.33, -0.2), v3(0.25, 0.36, -0.3), v3(0.26, 0.33, -0.42)], 0.014), M.steel));
    add(new THREE.CylinderGeometry(0.014, 0.014, 0.05, 12), M.steel, 0.21, 0.27, -0.53, Math.PI / 2 - 0.3, 0, 0);
    // Oil catch tank
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.07, 12), M.tank, 0.38, 0.27, -0.14);
    // Engine output pulley (on the seat side)
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.025, 20), M.black, 0.205, 0.165, -0.24, 0, 0, Math.PI / 2);
    this.addPart('engine', g, v3(0.45, 0.42, 0));

    // Toothed belt loop from engine pulley to axle sprocket, with auto tensioner
    const beltPath = beltLoop(0.165, -0.24, 0.036, DIM.rearTireR, DIM.rearAxleZ, 0.088);
    const belt = new THREE.Mesh(
      sweep(
        beltPath.map((p) => v3(0.2, p.y, p.x)),
        [new THREE.Vector2(-0.003, -0.011), new THREE.Vector2(0.003, -0.011), new THREE.Vector2(0.003, 0.011), new THREE.Vector2(-0.003, 0.011)],
        v3(1, 0, 0),
        { closedPath: true },
      ),
      this.mats.black,
    );
    const tensioner = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.026, 16), this.mats.alu);
    tensioner.rotation.z = Math.PI / 2;
    tensioner.position.set(0.2, 0.108, -0.39);
    const arm = new THREE.Mesh(new RoundedBoxGeometry(0.01, 0.012, 0.07, 1, 0.003), this.mats.black);
    arm.position.set(0.215, 0.12, -0.36);
    arm.rotation.x = 0.4;
    this.group('belt', v3(0.2, 0.18, -0.08), belt, tensioner, arm);
  }

  // --------------------------------------------------------- rear axle/wheels
  private buildRearAxle() {
    const M = this.mats;
    this.rearSpin.position.set(0, DIM.rearTireR, DIM.rearAxleZ);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.08, 16), M.steel);
    axle.rotation.z = Math.PI / 2;
    this.rearSpin.add(axle);
    // Brake disc
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.008, 32), [M.alu, M.disc, M.disc]);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = -0.2;
    this.rearSpin.add(disc);
    // Axle sprocket for the belt
    const sprocket = new THREE.Mesh(new THREE.CylinderGeometry(0.086, 0.086, 0.024, 40), M.alu);
    sprocket.rotation.z = Math.PI / 2;
    sprocket.position.x = 0.2;
    this.rearSpin.add(sprocket);
    const sprocketHub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 20), M.black);
    sprocketHub.rotation.z = Math.PI / 2;
    sprocketHub.position.x = 0.2;
    this.rearSpin.add(sprocketHub);
    // Hubs with stopper pins
    for (const s of [1, -1]) {
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.07, 16), M.alu);
      hub.rotation.z = Math.PI / 2;
      hub.position.x = s * 0.37;
      this.rearSpin.add(hub);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.05, 8), M.frame);
      pin.position.set(s * 0.37, 0.034, 0);
      this.rearSpin.add(pin);
    }
    const wl = this.makeWheel(DIM.rearTireR, DIM.rearTireW, 1);
    wl.position.x = DIM.rearTrackHalf;
    const wr = this.makeWheel(DIM.rearTireR, DIM.rearTireW, -1);
    wr.position.x = -DIM.rearTrackHalf;
    this.rearSpin.add(wl, wr);
    this.parts['wheelRL'] = wl;
    this.parts['wheelRR'] = wr;
    this.explodeOffsets['wheelRL'] = v3(0.35, 0, 0);
    this.explodeOffsets['wheelRR'] = v3(-0.35, 0, 0);
    this.basePos['wheelRL'] = wl.position.clone();
    this.basePos['wheelRR'] = wr.position.clone();
    this.addPart('axle', this.rearSpin, v3(0, 0, -0.32));

    // Static brake caliper
    const caliper = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.05, 0.06, 1, 0.008), M.black);
    caliper.position.set(-0.2, DIM.rearTireR + 0.075, DIM.rearAxleZ + 0.02);
    const calRed = new THREE.Mesh(new RoundedBoxGeometry(0.032, 0.02, 0.04, 1, 0.005), M.frame);
    calRed.position.copy(caliper.position).add(v3(0, 0.02, 0));
    this.group('caliper', v3(0, 0.05, -0.32), caliper, calRed);
  }

  // ------------------------------------------------------------ front wheels
  private buildFrontWheels() {
    for (const s of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.4, DIM.frontTireR, DIM.frontAxleZ);
      // spindle / upright
      const upright = new THREE.Mesh(new RoundedBoxGeometry(0.025, 0.09, 0.04, 1, 0.006), this.mats.frame);
      upright.position.set(0, 0.01, 0);
      pivot.add(upright);
      const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 10), this.mats.steel);
      stub.rotation.z = Math.PI / 2;
      stub.position.x = s * 0.035;
      pivot.add(stub);
      const steerArm = new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.012, 0.07, 1, 0.004), this.mats.alu);
      steerArm.position.set(-s * 0.02, 0.03, -0.045);
      steerArm.rotation.y = s * 0.4;
      pivot.add(steerArm);
      const spin = this.makeWheel(DIM.frontTireR, DIM.frontTireW, s);
      spin.position.x = s * (DIM.frontTrackHalf - 0.4);
      pivot.add(spin);
      this.steerPivots.push(pivot);
      this.frontSpin.push(spin);
      this.addPart(s > 0 ? 'wheelFL' : 'wheelFR', pivot, v3(s * 0.38, 0, 0.12));
    }
    // Tie rods from the column to the steering arms (static approximation)
    const rods = new THREE.Mesh(
      mergeGeometries([
        nonIndexed(tube([v3(0.02, 0.15, 0.49), v3(0.38, 0.155, 0.475)], 0.006)),
        nonIndexed(tube([v3(-0.02, 0.15, 0.49), v3(-0.38, 0.155, 0.475)], 0.006)),
      ]),
      this.mats.steel,
    );
    this.group('tierods', v3(0, 0.1, 0.2), rods);
  }

  private makeWheel(R: number, W: number, side: number) {
    const hw = W / 2;
    const Ri = DIM.rimR;
    const segs = this.detail === 'showroom' ? 48 : 28;
    const prof = [
      [Ri + 0.003, -hw * 0.8],
      [Ri + 0.016, -hw * 0.94],
      [Ri + (R - Ri) * 0.45, -hw],
      [R - 0.016, -hw * 0.97],
      [R - 0.005, -hw * 0.88],
      [R, -hw * 0.7],
      [R, hw * 0.7],
      [R - 0.005, hw * 0.88],
      [R - 0.016, hw * 0.97],
      [Ri + (R - Ri) * 0.45, hw],
      [Ri + 0.016, hw * 0.94],
      [Ri + 0.003, hw * 0.8],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const tireGeo = new THREE.LatheGeometry(prof, segs);
    tireGeo.rotateZ(Math.PI / 2);
    const g = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, this.mats.rubber);
    g.add(tire);
    // Rim barrel + outer dish
    const rimProf = [
      [Ri - 0.004, -hw * 0.82],
      [Ri, -hw * 0.8],
      [Ri, hw * 0.8],
      [Ri - 0.004, hw * 0.84],
      [Ri * 0.75, hw * 0.7],
      [Ri * 0.45, hw * 0.55],
      [0.028, hw * 0.62],
      [0.001, hw * 0.62],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const rimGeo = new THREE.LatheGeometry(rimProf, segs);
    rimGeo.rotateZ(Math.PI / 2);
    if (side > 0) rimGeo.rotateY(Math.PI);
    const rim = new THREE.Mesh(rimGeo, this.mats.rim);
    g.add(rim);
    // Lug bolts
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.012, 6), this.mats.steel);
      bolt.rotation.z = Math.PI / 2;
      bolt.position.set(side * hw * 0.6, Math.cos(a) * 0.04, Math.sin(a) * 0.04);
      g.add(bolt);
    }
    // Sidewall lettering (outer face)
    const deco = new THREE.Mesh(polarRing(Ri + 0.012, R - 0.02, segs), this.mats.sidewall);
    deco.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    deco.position.x = side * (hw + 0.0035);
    deco.renderOrder = 2;
    deco.castShadow = false;
    g.add(deco);
    return g;
  }

  // ---------------------------------------------------------------- steering
  private buildSteering() {
    const col = this.steerColumn;
    col.position.set(0, 0.13, 0.5);
    col.rotation.x = -0.73;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.5, 12), this.mats.steel);
    column.position.y = 0.25;
    col.add(column);
    const clamp1 = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.03, 0.04, 1, 0.006), this.mats.black);
    clamp1.position.y = 0.3;
    col.add(clamp1);

    const w = this.steeringWheel;
    w.position.y = 0.52;
    col.add(w);
    // Butterfly wheel outline with hand cut-outs
    const s = new THREE.Shape();
    s.moveTo(-0.15, 0.055);
    s.quadraticCurveTo(-0.162, 0.1, -0.11, 0.096);
    s.lineTo(0.11, 0.096);
    s.quadraticCurveTo(0.162, 0.1, 0.15, 0.055);
    s.lineTo(0.14, -0.05);
    s.quadraticCurveTo(0.13, -0.1, 0.08, -0.086);
    s.lineTo(0.03, -0.062);
    s.lineTo(-0.03, -0.062);
    s.lineTo(-0.08, -0.086);
    s.quadraticCurveTo(-0.13, -0.1, -0.14, -0.05);
    s.closePath();
    for (const sx of [1, -1]) {
      const h = new THREE.Path();
      h.moveTo(sx * 0.117, 0.058);
      h.lineTo(sx * 0.048, 0.058);
      h.lineTo(sx * 0.048, -0.036);
      h.quadraticCurveTo(sx * 0.09, -0.066, sx * 0.112, -0.034);
      h.closePath();
      s.holes.push(h);
    }
    const wheelGeo = new THREE.ExtrudeGeometry(s, {
      depth: 0.012,
      bevelEnabled: true,
      bevelThickness: 0.005,
      bevelSize: 0.005,
      bevelSegments: 2,
      curveSegments: 10,
    });
    wheelGeo.translate(0, 0, -0.006);
    wheelGeo.rotateX(Math.PI / 2);
    const wheelMesh = new THREE.Mesh(wheelGeo, this.mats.frame);
    w.add(wheelMesh);
    for (const sx of [1, -1]) {
      const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.085, 4, 10), this.mats.black);
      grip.rotation.x = Math.PI / 2;
      grip.position.set(sx * 0.134, 0.004, 0.008);
      w.add(grip);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.04, 0.035, 20), this.mats.black);
    hub.position.y = 0.012;
    w.add(hub);
    const badge = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.004, 20), this.mats.accent);
    badge.position.y = 0.031;
    w.add(badge);
    // Data display (lap timer) on the wheel
    const disp = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.01, 0.035, 1, 0.003), this.mats.black);
    disp.position.set(0, 0.02, 0.062);
    w.add(disp);
    this.addPart('steering', col, v3(0, 0.55, 0.1));
  }

  private buildPedals() {
    const P = this.pedalGroup;
    P.position.set(0, 0, 0.56);
    const rail = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.015, 0.22, 1, 0.004), this.mats.black);
    rail.position.set(0, 0.055, -0.02);
    P.add(rail);
    const mk = (pedal: THREE.Group, x: number, mat: THREE.Material) => {
      pedal.position.set(x, 0.06, 0.02);
      const arm = new THREE.Mesh(new RoundedBoxGeometry(0.014, 0.12, 0.014, 1, 0.004), this.mats.alu);
      arm.position.y = 0.06;
      pedal.add(arm);
      const plate = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.1, 0.012, 1, 0.004), mat);
      plate.position.set(0, 0.11, -0.005);
      pedal.add(plate);
      pedal.rotation.x = 0.55;
      P.add(pedal);
    };
    mk(this.brakePedal, 0.11, this.mats.black);
    mk(this.throttlePedal, -0.11, this.mats.alu);
    this.addPart('pedals', P, v3(0, 0.12, 0.38));
  }

  private buildExtras() {
    // Mirrors on stalks
    const mirrors = new THREE.Group();
    for (const s of [1, -1]) {
      mirrors.add(new THREE.Mesh(tube([v3(s * 0.2, 0.42, 0.41), v3(s * 0.26, 0.52, 0.43), v3(s * 0.31, 0.6, 0.42)], 0.006), this.mats.black));
      const head = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.06, 0.025, 2, 0.01), this.mats.black);
      head.position.set(s * 0.33, 0.62, 0.42);
      head.rotation.y = s * 0.25;
      mirrors.add(head);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.086, 0.046), this.mats.mirror);
      glass.position.set(s * 0.33 + s * 0.003, 0.62, 0.406);
      glass.rotation.y = Math.PI + s * 0.25;
      mirrors.add(glass);
    }
    this.addPart('mirrors', mirrors, v3(0, 0.35, 0.12));
  }

  // --------------------------------------------------------------- merging
  /** Merge static meshes by material to cut draw calls for race karts. */
  private mergeStatic() {
    const dynamic = new Set<THREE.Object3D>([this.rearSpin, this.steerColumn, this.pedalGroup, ...this.steerPivots]);
    if (this.driver) dynamic.add(this.driver.group);
    const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
    const toRemove: THREE.Mesh[] = [];
    this.body.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.body.matrixWorld).invert();
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      let p: THREE.Object3D | null = mesh.parent;
      while (p && p !== this.body) {
        if (dynamic.has(p)) return;
        p = p.parent;
      }
      const mat = mesh.material as THREE.Material;
      let geo = mesh.geometry.clone();
      geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
      if (geo.index) geo = geo.toNonIndexed();
      if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) geo.deleteAttribute(name);
      const key = mat.uuid + (geo.getAttribute('color') ? ':c' : '');
      if (!buckets.has(key)) buckets.set(key, { mat, geos: [] });
      buckets.get(key)!.geos.push(geo);
      toRemove.push(mesh);
    });
    toRemove.forEach((m) => m.parent?.remove(m));
    const merged = new THREE.Group();
    merged.name = 'merged';
    for (const { mat, geos } of buckets.values()) {
      const g = mergeGeometries(geos);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = true;
      if ((mat as THREE.MeshStandardMaterial).transparent) mesh.renderOrder = 1;
      merged.add(mesh);
    }
    this.body.add(merged);
  }

  private applyGhost() {
    const ghostMat = new THREE.MeshStandardMaterial({
      color: 0x7fd4ff,
      emissive: 0x2a7fff,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      roughness: 0.4,
    });
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = ghostMat;
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
  }

  // ---------------------------------------------------------------- runtime
  private explodeT = 0;

  setExplode(t: number) {
    this.explodeT = t;
    for (const name of Object.keys(this.parts)) {
      const obj = this.parts[name];
      const base = this.basePos[name];
      const off = this.explodeOffsets[name];
      if (!base || !off) continue;
      obj.position.copy(base).addScaledVector(off, t);
    }
    this.body.position.y = 0.3 * t;
  }

  setCockpitView(on: boolean) {
    if (!this.driver) return;
    this.driver.group.traverse((o) => {
      if (o.userData.hideInCockpit) o.visible = !on;
    });
  }

  update(s: KartVisualState, dt: number) {
    // Wheels
    this.frontAngle += (s.speed / DIM.frontTireR) * dt;
    this.rearAngle += (s.speed / DIM.rearTireR) * dt;
    for (const p of this.steerPivots) p.rotation.y = s.steerAngle;
    for (const w of this.frontSpin) w.rotation.x = this.frontAngle;
    this.rearSpin.rotation.x = this.rearAngle;

    // Steering column tilt (fit adjustment) and wheel rotation
    this.steerColumn.rotation.x = -0.73 + this.columnTilt;
    this.steeringWheel.rotation.y = s.steerAngle * 3.2;

    // Pedals
    this.pedalGroup.position.z = 0.56 - this.pedalSlide;
    this.throttlePedal.rotation.x = 0.55 + s.throttle * 0.35;
    this.brakePedal.rotation.x = 0.55 + s.brake * 0.25;

    // Chassis attitude: terrain pitch/roll + a touch of load-induced roll and
    // the signature inside-rear-wheel lift of a diff-less kart.
    const lift = clamp((Math.abs(s.latG) - 0.9) * 0.05, 0, 0.035) * Math.sign(s.latG);
    this.vib += dt * (20 + s.rpm * 0.012);
    const buzz = s.rpm > 0 ? Math.sin(this.vib * 6.1) * 0.0006 * (0.3 + s.throttle) : 0;
    const kerbShake = (s.onKerb ?? 0) * Math.sin(this.vib * 3.3) * 0.006;
    this.body.rotation.set(s.pitch - s.longG * 0.006 + buzz, 0, s.roll + s.latG * 0.012 + lift + kerbShake, 'YXZ');

    if (this.driver) {
      this.steerColumn.updateMatrix();
      this.steeringWheel.updateMatrix();
      const m = new THREE.Matrix4().multiplyMatrices(this.steerColumn.matrix, this.steeringWheel.matrix);
      this.hands[0].set(0.134, 0.02, 0.008).applyMatrix4(m);
      this.hands[1].set(-0.134, 0.02, 0.008).applyMatrix4(m);
      const pz = 0.56 - this.pedalSlide;
      this.feet[0].set(0.11, 0.155 - s.brake * 0.01, pz - 0.03 + s.brake * 0.02);
      this.feet[1].set(-0.11, 0.155 - s.throttle * 0.012, pz - 0.03 + s.throttle * 0.025);
      if (this.explodeT > 0) {
        // targets are relative to the assembled kart, so the driving pose holds
        // while the driver and the steering column fly apart
        const st = this.explodeOffsets['steering'];
        for (const h of this.hands) h.addScaledVector(st, -this.explodeT);
      }
      this.driver.update(this.hands, this.feet, s.latG, s.longG, Math.max(dt, 1 / 120));
    }
  }

  /** World-space position of the driver's eyes (for cockpit camera). */
  eyeLocal(out: THREE.Vector3) {
    return out.set(-0.04, 0.8, -0.36);
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
}

// ------------------------------------------------------------------ helpers

/** Re-parent a group's children to the group's parent, keeping their placement. */
function flatten(group: THREE.Object3D) {
  const parent = group.parent!;
  group.updateMatrix();
  for (const child of [...group.children]) {
    child.applyMatrix4(group.matrix);
    parent.add(child);
  }
  parent.remove(group);
}

/** Merge a group's direct child meshes by material (transforms baked relative to the group). */
function collapse(group: THREE.Object3D) {
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const remove = new Map<THREE.Material, THREE.Mesh[]>();
  const add = (mat: THREE.Material, g: THREE.BufferGeometry, m: THREE.Mesh) => {
    if (!buckets.has(mat)) buckets.set(mat, []), remove.set(mat, []);
    buckets.get(mat)!.push(g);
    remove.get(mat)!.push(m);
  };
  for (const child of group.children) {
    const m = child as THREE.Mesh;
    if (!m.isMesh) continue;
    m.updateMatrix();
    let g = m.geometry.clone().applyMatrix4(m.matrix);
    if (g.index) g = g.toNonIndexed();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!Array.isArray(m.material)) add(m.material, g, m);
    // multi-material meshes (the brake disc) are split per group so each part joins its material's bucket
    else if (g.groups.length) for (const grp of g.groups) add(m.material[grp.materialIndex ?? 0], sliceGroup(g, grp.start, grp.count), m);
  }
  const removed = new Set<THREE.Mesh>();
  const kept = new Set<THREE.Mesh>();
  for (const [mat, geos] of buckets) {
    const meshes = remove.get(mat)!;
    if (geos.length < 2 && !Array.isArray(meshes[0].material)) {
      kept.add(meshes[0]);
      continue;
    }
    const merged = mergeGeometries(geos);
    if (!merged) {
      meshes.forEach((r) => kept.add(r));
      continue;
    }
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = !(mat as THREE.MeshStandardMaterial).transparent;
    mesh.renderOrder = (mat as THREE.MeshStandardMaterial).transparent ? 2 : 0;
    group.add(mesh);
    meshes.forEach((r) => removed.add(r));
  }
  // a split mesh goes only if every one of its parts was merged
  for (const r of removed) if (!kept.has(r)) group.remove(r);
}

/** Copy of a non-indexed geometry's vertex range [start, start + count). */
function sliceGroup(g: THREE.BufferGeometry, start: number, count: number) {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    out.setAttribute(name, new THREE.BufferAttribute(a.array.slice(start * a.itemSize, (start + count) * a.itemSize), a.itemSize));
  }
  return out;
}

function mirrorX(geo: THREE.BufferGeometry) {
  const g = geo.clone();
  g.scale(-1, 1, 1);
  const idx = g.getIndex();
  if (idx) {
    const arr = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    idx.needsUpdate = true;
  }
  g.computeVertexNormals();
  return g;
}

/** Thin plate from an XZ outline, extruded upward. */
function flatPlate(outline: [number, number][], thickness: number) {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Convex hull of two pulleys in the (z,y) plane → belt path. */
function beltLoop(y1: number, z1: number, r1: number, y2: number, z2: number, r2: number) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push(new THREE.Vector2(z1 + Math.cos(a) * r1, y1 + Math.sin(a) * r1));
    pts.push(new THREE.Vector2(z2 + Math.cos(a) * r2, y2 + Math.sin(a) * r2));
  }
  // Andrew's monotone chain
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: THREE.Vector2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: THREE.Vector2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  // resample evenly
  const out: THREE.Vector2[] = [];
  const curve = new THREE.CatmullRomCurve3(hull.map((p) => v3(p.x, p.y, 0)), true, 'centripetal');
  for (const p of curve.getSpacedPoints(120).slice(0, -1)) out.push(new THREE.Vector2(p.x, p.y));
  return out;
}

