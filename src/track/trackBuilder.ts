import * as THREE from 'three';
import { KERB_HEIGHT, newProj, Track } from './track';
import type { RacingLine } from './racingLine';
import { baseHeight, CIRCUIT_CENTER } from './terrain';
import * as TX from '../render/textures';
import { chunkedInstances } from '../render/chunks';
import { fbm, lerp, rng, smoothstep } from '../core/math';

// Builds every mesh that belongs to the circuit itself: asphalt, kerbs,
// painted lines, rubbered-in racing line, terrain, barriers, gantry and bridge.

export const GRID_SLOTS = 8;
export const gridSlot = (k: number) => ({ s: -7 - k * 5.5, lateral: k % 2 === 0 ? 2.4 : -2.4 });

export class StartLights {
  group = new THREE.Group();
  private mats: THREE.MeshStandardMaterial[] = [];
  constructor() {
    const podGeo = new THREE.BoxGeometry(0.42, 1.0, 0.28);
    const podMat = new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.6 });
    const lensGeo = new THREE.CircleGeometry(0.13, 20);
    for (let c = 0; c < 5; c++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x220404, emissive: 0x000000, roughness: 0.3 });
      this.mats.push(mat);
      const pod = new THREE.Mesh(podGeo, podMat);
      pod.position.set((c - 2) * 0.62, 0, 0);
      this.group.add(pod);
      for (const y of [0.22, -0.22]) {
        const lens = new THREE.Mesh(lensGeo, mat);
        lens.position.set((c - 2) * 0.62, y, -0.145);
        lens.rotation.y = Math.PI;
        this.group.add(lens);
      }
    }
  }
  /** n = number of red columns lit (0..5); green = all green (formation). */
  set(n: number, green = false) {
    this.mats.forEach((m, i) => {
      const on = green || i < n;
      m.emissive.setHex(on ? (green ? 0x19ff5a : 0xff1020) : 0x000000);
      m.emissiveIntensity = on ? 4.5 : 0;
      m.color.setHex(on ? (green ? 0x19ff5a : 0xff2030) : 0x220404);
    });
  }
}

export interface TrackVisuals {
  group: THREE.Group;
  startLights: StartLights;
  cameraSpots: { pos: THREE.Vector3; s: number }[];
  terrainHeightAt: (x: number, z: number) => number;
  roadMaterial: THREE.MeshStandardMaterial;
}

type Column = { lat: number; dy: number; u: number };

/** Builds a strip following the centreline. Returns null if nothing emitted. */
function strip(track: Track, columns: (i: number) => Column[] | null, vScale: number, dyBase = 0) {
  const N = track.N;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let prevRow = -1;
  let prevCount = 0;
  for (let r = 0; r <= N; r++) {
    const i = r % N;
    const cols = columns(i);
    if (!cols) {
      prevRow = -1;
      continue;
    }
    const base = pos.length / 3;
    const v = (r * track.ds) / vScale;
    for (const c of cols) {
      pos.push(track.px[i] + track.nx[i] * c.lat, track.py[i] + c.dy + dyBase, track.pz[i] + track.nz[i] * c.lat);
      uv.push(c.u, v);
    }
    if (prevRow >= 0 && prevCount === cols.length) {
      for (let k = 0; k < cols.length - 1; k++) {
        const a = prevRow + k;
        const b = prevRow + k + 1;
        const c = base + k;
        const d = base + k + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    prevRow = base;
    prevCount = cols.length;
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure normals point up
  const n = g.getAttribute('normal');
  let up = 0;
  for (let k = 0; k < n.count; k++) up += n.getY(k);
  if (up < 0) {
    for (let k = 0; k < idx.length; k += 3) {
      const t = idx[k + 1];
      idx[k + 1] = idx[k + 2];
      idx[k + 2] = t;
    }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/** Points along a wall line (offset from the centreline) resampled by arc length. */
function wallPath(track: Track, side: 1 | -1, extra: number, spacing: number, filter?: (i: number) => boolean) {
  const out: { x: number; y: number; z: number; heading: number; i: number }[] = [];
  let carry = 0;
  for (let i = 0; i < track.N; i++) {
    const j = track.wrap(i + 1);
    const wi = side > 0 ? track.wallL[i] : track.wallR[i];
    const wj = side > 0 ? track.wallL[j] : track.wallR[j];
    const ax = track.px[i] + track.nx[i] * (wi + extra) * side;
    const az = track.pz[i] + track.nz[i] * (wi + extra) * side;
    const bx = track.px[j] + track.nx[j] * (wj + extra) * side;
    const bz = track.pz[j] + track.nz[j] * (wj + extra) * side;
    const segL = Math.hypot(bx - ax, bz - az);
    let d = carry;
    while (d < segL) {
      const t = d / segL;
      if (!filter || filter(i)) {
        out.push({
          x: lerp(ax, bx, t),
          y: lerp(track.py[i], track.py[j], t),
          z: lerp(az, bz, t),
          heading: Math.atan2(bx - ax, bz - az),
          i,
        });
      }
      d += spacing;
    }
    carry = d - segL;
  }
  return out;
}

export function buildTrack(track: Track, line: RacingLine, quality: 'low' | 'medium' | 'high'): TrackVisuals {
  const group = new THREE.Group();
  group.name = 'track';
  const proj = newProj();

  // ------------------------------------------------------------ terrain fn
  const terrainHeightAt = (x: number, z: number) => {
    const hBase = baseHeight(x, z);
    if (!track.projectNear(x, z, proj, 4)) return hBase;
    const lat = proj.lateral;
    const a = Math.abs(lat);
    const wall = lat > 0 ? proj.wallL : proj.wallR;
    const road = proj.height - (a < proj.halfWidth + 1.2 ? 0.08 : 0.03);
    return lerp(road, hBase, smoothstep(wall + 1.5, wall + 22, a));
  };

  // ------------------------------------------------------------------ road
  const asphalt = TX.asphalt();
  const roadMaterial = new THREE.MeshStandardMaterial({
    map: asphalt.map,
    normalMap: asphalt.normalMap,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughnessMap: asphalt.roughnessMap,
    roughness: 1,
    color: 0x9c9c9c,
    envMapIntensity: 0.55,
  });
  const roadGeo = strip(
    track,
    (i) => {
      const hw = track.hw[i];
      const cols: Column[] = [];
      for (let k = 0; k <= 6; k++) {
        const lat = lerp(-hw, hw, k / 6);
        cols.push({ lat, dy: 0, u: lat / 5 });
      }
      return cols;
    },
    5,
  )!;
  const road = new THREE.Mesh(roadGeo, roadMaterial);
  road.receiveShadow = true;
  road.name = 'road';
  group.add(road);

  // Rubbered-in racing line
  const rubber = strip(
    track,
    (i) => {
      const o = line.offset[i];
      return [
        { lat: o - 0.95, dy: 0.006, u: 0 },
        { lat: o + 0.95, dy: 0.006, u: 1 },
      ];
    },
    6,
  )!;
  const rubberMat = new THREE.MeshStandardMaterial({
    map: TX.rubberBand(),
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const rubberMesh = new THREE.Mesh(rubber, rubberMat);
  rubberMesh.receiveShadow = true;
  group.add(rubberMesh);

  // White edge lines
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const side of [1, -1]) {
    const g = strip(
      track,
      (i) => {
        const hw = track.hw[i];
        return [
          { lat: side * (hw - 0.34), dy: 0.008, u: 0 },
          { lat: side * (hw - 0.2), dy: 0.008, u: 1 },
        ];
      },
      5,
    )!;
    const m = new THREE.Mesh(g, lineMat);
    m.receiveShadow = true;
    group.add(m);
  }

  // Kerbs: raised red/white strips with a sloped inner lip
  const kerbMat = new THREE.MeshStandardMaterial({ map: TX.kerb(), roughness: 0.55 });
  for (const side of [1, -1] as const) {
    const g = strip(
      track,
      (i) => {
        const w = side > 0 ? track.kerbL[i] : track.kerbR[i];
        const j = track.wrap(i + 1);
        const wn = side > 0 ? track.kerbL[j] : track.kerbR[j];
        const wp = side > 0 ? track.kerbL[track.wrap(i - 1)] : track.kerbR[track.wrap(i - 1)];
        if (w <= 0 && wn <= 0 && wp <= 0) return null;
        const ww = Math.max(w, 0.001);
        const hw = track.hw[i];
        const taper = w > 0 ? 1 : 0;
        return [
          { lat: side * (hw - 0.02), dy: 0.004, u: 0 },
          { lat: side * (hw + ww * 0.35), dy: KERB_HEIGHT * 0.65 * taper, u: 0.35 },
          { lat: side * (hw + ww), dy: KERB_HEIGHT * taper, u: 1 },
          { lat: side * (hw + ww + 0.06), dy: -0.03, u: 1 },
        ];
      },
      2.4,
    );
    if (g) {
      const m = new THREE.Mesh(g, kerbMat);
      m.receiveShadow = true;
      m.castShadow = false;
      group.add(m);
    }
  }

  // Start / finish line and grid boxes
  {
    const s0 = 0;
    const i0 = track.indexAt(s0);
    const hw = track.hw[i0];
    const heading = track.headingAt(s0);
    const g = new THREE.PlaneGeometry(hw * 2, 1.0);
    g.rotateX(-Math.PI / 2);
    const tex = TX.checker(22, 2);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3 }));
    const p = track.pointAt(s0);
    m.position.set(p.x, p.y + 0.01, p.z);
    m.rotation.y = heading;
    m.receiveShadow = true;
    group.add(m);
    const barGeo = new THREE.PlaneGeometry(1.5, 0.14);
    barGeo.rotateX(-Math.PI / 2);
    const sideGeo = new THREE.PlaneGeometry(0.12, 1.2);
    sideGeo.rotateX(-Math.PI / 2);
    for (let k = 0; k < GRID_SLOTS; k++) {
      const slot = gridSlot(k);
      const sp = track.pointAt(slot.s + 1.05, slot.lateral);
      const bar = new THREE.Mesh(barGeo, lineMat);
      bar.position.set(sp.x, sp.y + 0.01, sp.z);
      bar.rotation.y = track.headingAt(slot.s);
      group.add(bar);
      for (const sx of [-0.72, 0.72]) {
        const sp2 = track.pointAt(slot.s + 0.5, slot.lateral + sx);
        const b2 = new THREE.Mesh(sideGeo, lineMat);
        b2.position.set(sp2.x, sp2.y + 0.01, sp2.z);
        b2.rotation.y = track.headingAt(slot.s);
        group.add(b2);
      }
    }
    // Painted circuit name on the straight
    const nameGeo = new THREE.PlaneGeometry(8, 2);
    nameGeo.rotateX(-Math.PI / 2);
    const nm = new THREE.Mesh(
      nameGeo,
      new THREE.MeshStandardMaterial({ map: TX.paintedText('SAKURA', 1024, 256), transparent: true, depthWrite: false, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3 }),
    );
    const np = track.pointAt(40);
    nm.position.set(np.x, np.y + 0.012, np.z);
    nm.rotation.y = track.headingAt(40) + Math.PI;
    group.add(nm);
  }

  // --------------------------------------------------------------- terrain
  const terrain = buildTerrain(track, terrainHeightAt, quality);
  group.add(terrain);

  // -------------------------------------------------------------- barriers
  buildBarriers(track, group, quality);

  // ---------------------------------------------------------------- gantry
  const startLights = new StartLights();
  {
    const i0 = track.indexAt(0);
    const p = track.pointAt(0);
    const heading = track.headingAt(0);
    const g = new THREE.Group();
    g.position.copy(p);
    g.rotation.y = heading;
    const wl = track.wallL[i0] + 1.0;
    const wr = track.wallR[i0] + 1.0;
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.6, roughness: 0.45 });
    const red = new THREE.MeshStandardMaterial({ color: 0xd0101a, roughness: 0.4 });
    for (const lat of [wl, -wr]) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.6, 6.4, 0.6), steel);
      pil.position.set(lat, 3.2, 0);
      pil.castShadow = true;
      g.add(pil);
    }
    const span = wl + wr + 0.6;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 1.3, 0.9), red);
    beam.position.set((wl - wr) / 2, 5.9, 0);
    beam.castShadow = true;
    g.add(beam);
    for (const [zOff, rot] of [
      [-0.46, Math.PI],
      [0.46, 0],
    ] as const) {
      const ban = new THREE.Mesh(new THREE.PlaneGeometry(span * 0.96, 1.1), new THREE.MeshStandardMaterial({ map: TX.banner('SAKURA KART CIRCUIT', '#111', '#fff', '#e0001b', 2048, 128), roughness: 0.5 }));
      ban.position.set((wl - wr) / 2, 5.9, zOff);
      ban.rotation.y = rot;
      g.add(ban);
    }
    startLights.group.position.set(0, 4.55, -0.1);
    g.add(startLights.group);
    group.add(g);
  }

  // ---------------------------------------------------------------- bridge
  {
    // find the back-straight sample nearest (15, -92)
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < track.N; i++) {
      const d = (track.px[i] - 15) ** 2 + (track.pz[i] + 92) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const p = new THREE.Vector3(track.px[bi], track.py[bi], track.pz[bi]);
    const heading = Math.atan2(track.tx[bi], track.tz[bi]);
    const g = new THREE.Group();
    g.position.copy(p);
    g.rotation.y = heading;
    const wl = track.wallL[bi] + 1.6;
    const wr = track.wallR[bi] + 1.6;
    const concrete = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.85 });
    for (const lat of [wl, -wr]) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(1.1, 6.2, 1.4), concrete);
      pil.position.set(lat, 3.1, 0);
      pil.castShadow = true;
      pil.receiveShadow = true;
      g.add(pil);
    }
    const span = wl + wr + 1.1;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 1.5, 2.2), new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.6 }));
    deck.position.set((wl - wr) / 2, 6.6, 0);
    deck.castShadow = true;
    g.add(deck);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.9, 0.08), new THREE.MeshStandardMaterial({ color: 0xe0001b, roughness: 0.5 }));
    rail.position.set((wl - wr) / 2, 7.8, 1.06);
    g.add(rail);
    const rail2 = rail.clone();
    rail2.position.z = -1.06;
    g.add(rail2);
    const b1 = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 0.95, 1.3),
      new THREE.MeshStandardMaterial({ map: TX.banner('CLAUDE OPUS 5.5', '#0e0e10', '#f4efe6', '#d97757', 2048, 128), roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.05, emissiveMap: TX.banner('CLAUDE OPUS 5.5', '#0e0e10', '#f4efe6', '#d97757', 2048, 128) }),
    );
    b1.position.set((wl - wr) / 2, 6.6, -1.11);
    b1.rotation.y = Math.PI;
    g.add(b1);
    const b2 = new THREE.Mesh(new THREE.PlaneGeometry(span * 0.95, 1.3), new THREE.MeshStandardMaterial({ map: TX.banner('GR KART · 215cc', '#f5f5f3', '#111', '#e0001b', 2048, 128), roughness: 0.5 }));
    b2.position.set((wl - wr) / 2, 6.6, 1.11);
    g.add(b2);
    group.add(g);
  }

  // ----------------------------------------------------------- brake boards
  {
    const boardMat = (txt: string) =>
      new THREE.MeshStandardMaterial({ map: TX.banner(txt, '#f5f5f3', '#111', undefined, 256, 256), roughness: 0.6 });
    const post = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.6 });
    for (const zi of line.brakeZones) {
      const k = track.curv[track.wrap(zi + 25)];
      const side = k < 0 ? 1 : -1; // outside of the coming corner
      for (const [dist, label] of [
        [16, '50'],
        [34, '100'],
      ] as const) {
        const i = track.wrap(zi - Math.round(dist / track.ds) + 18);
        const lat = side * (track.hw[i] + 1.6);
        const x = track.px[i] + track.nx[i] * lat;
        const z = track.pz[i] + track.nz[i] * lat;
        const y = track.py[i];
        const b = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.75), boardMat(label));
        b.position.set(x, y + 1.0, z);
        b.rotation.y = Math.atan2(track.tx[i], track.tz[i]) + Math.PI;
        b.castShadow = true;
        group.add(b);
        const pl = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), post);
        pl.position.set(x, y + 0.35, z);
        group.add(pl);
      }
    }
  }

  // ---------------------------------------------------------- camera spots
  const cameraSpots: { pos: THREE.Vector3; s: number }[] = [];
  for (let s = 10; s < track.length; s += 48) {
    const i = track.indexAt(s);
    const k = track.curv[track.wrap(i + 12)];
    const side = k < 0 ? 1 : -1;
    // behind a concrete wall the catch fence (3.15 m) would fill the shot, so stand right
    // behind it on a raised platform instead
    const fenced = (side > 0 ? track.wallTypeL[i] : track.wallTypeR[i]) === 1;
    const lat = side * ((side > 0 ? track.wallL[i] : track.wallR[i]) + (fenced ? 1.2 : 3.5));
    const x = track.px[i] + track.nx[i] * lat;
    const z = track.pz[i] + track.nz[i] * lat;
    const y = fenced ? track.py[i] + 6.2 : terrainHeightAt(x, z) + 3.2 + (s % 3);
    cameraSpots.push({ pos: new THREE.Vector3(x, y, z), s });
  }

  return { group, startLights, cameraSpots, terrainHeightAt, roadMaterial };
}

// ------------------------------------------------------------------ terrain
function buildTerrain(track: Track, heightAt: (x: number, z: number) => number, quality: string) {
  const SEG = quality === 'low' ? 200 : quality === 'medium' ? 290 : 360;
  const A = 500;
  const B = 2300;
  const warp = (u: number) => Math.sign(u) * (A * Math.abs(u) + B * Math.abs(u) ** 5);
  const n = SEG + 1;
  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const proj = newProj();
  const c = new THREE.Color();
  const lawnA = new THREE.Color(0x5f9a3e);
  const lawnB = new THREE.Color(0x6fa94a);
  const grassA = new THREE.Color(0x5a8a36);
  const grassB = new THREE.Color(0x86a64c);
  const dry = new THREE.Color(0xa7a060);
  const forest = new THREE.Color(0x2e4d27);
  const forest2 = new THREE.Color(0x3d5f2c);
  const gravel = new THREE.Color(0xc2ab86);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = CIRCUIT_CENTER.x + warp((i / SEG) * 2 - 1);
      const z = CIRCUIT_CENTER.z + warp((j / SEG) * 2 - 1);
      const k = j * n + i;
      const h = heightAt(x, z);
      pos[k * 3] = x;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / 3;
      uv[k * 2 + 1] = z / 3;
      const r = Math.hypot(x - CIRCUIT_CENTER.x, z - CIRCUIT_CENTER.z);
      const nz = fbm(x * 0.02, z * 0.02, 3);
      c.copy(grassA).lerp(grassB, nz);
      c.lerp(dry, smoothstep(0.62, 0.8, fbm(x * 0.008 + 5, z * 0.008, 3)) * 0.5);
      if (track.projectNear(x, z, proj, 3)) {
        const a = Math.abs(proj.lateral);
        const wall = proj.lateral > 0 ? proj.wallL : proj.wallR;
        if (a < wall + 1) {
          const stripe = Math.floor(proj.s / 6) % 2 === 0;
          c.copy(stripe ? lawnA : lawnB).lerp(grassA, nz * 0.25);
          const outside = Math.sign(proj.lateral) === -Math.sign(proj.curvature);
          if (outside && Math.abs(proj.curvature) > 1 / 32 && a > proj.halfWidth + 2.2 && a < wall - 0.6) {
            c.copy(gravel).multiplyScalar(0.9 + nz * 0.2);
          }
        }
      }
      const f = smoothstep(200, 420, r);
      if (f > 0) {
        const fc = forest.clone().lerp(forest2, fbm(x * 0.01, z * 0.01, 3));
        c.lerp(fc, f);
      }
      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < SEG; j++)
    for (let i = 0; i < SEG; i++) {
      const a = j * n + i;
      const b = a + 1;
      const cc = a + n;
      const d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: TX.grassDetail(), roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

// ----------------------------------------------------------------- barriers
function buildBarriers(track: Track, group: THREE.Group, quality: string) {
  // Tyre stacks (instanced), textured bands, a few painted ones at corners.
  const sideTex = (() => {
    const cnv = document.createElement('canvas');
    cnv.width = 16;
    cnv.height = 64;
    const ctx = cnv.getContext('2d')!;
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(0, 0, 16, 64);
    for (let k = 0; k < 3; k++) {
      const y = k * 21.33;
      const g = ctx.createLinearGradient(0, y, 0, y + 21.33);
      g.addColorStop(0, '#6a6a6a');
      g.addColorStop(0.18, '#d8d8d8');
      g.addColorStop(0.82, '#cfcfcf');
      g.addColorStop(1, '#5a5a5a');
      ctx.fillStyle = g;
      ctx.fillRect(0, y, 16, 21.33);
    }
    const t = new THREE.CanvasTexture(cnv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const topTex = (() => {
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = 64;
    const ctx = cnv.getContext('2d')!;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#d0d0d0';
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.arc(32, 32, 17, 0, Math.PI * 2, true);
    ctx.fill();
    const t = new THREE.CanvasTexture(cnv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const stackGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.64, quality === 'low' ? 8 : 12, 1);
  stackGeo.translate(0, 0.32, 0);
  // the bottom cap sits below the ground and is never seen: drop its draw call
  stackGeo.groups = stackGeo.groups.filter((gr) => gr.materialIndex !== 2);
  const mats = [new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.9 }), new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.9 })];
  const tyres: { x: number; y: number; z: number; c: number }[] = [];
  const rand = rng(42);
  for (const side of [1, -1] as const) {
    const pts = wallPath(track, side, 0.32, 0.6, (i) => (side > 0 ? track.wallTypeL[i] : track.wallTypeR[i]) === 0);
    pts.forEach((p, n) => {
      const curvy = Math.abs(track.curv[p.i]) > 1 / 45;
      let c = 0x1d1d1f;
      if (curvy && Math.floor(n / 2) % 4 === 0) c = n % 2 ? 0xf2f2f2 : 0xd11a24;
      tyres.push({ x: p.x, y: p.y, z: p.z, c });
      // second row on the outside of fast corners
      if (curvy && rand() < 0.9) {
        const hx = Math.cos(p.heading) * side;
        const hz = -Math.sin(p.heading) * side;
        tyres.push({ x: p.x + hx * 0.6, y: p.y, z: p.z + hz * 0.6, c: 0x1d1d1f });
      }
    });
  }
  const stacks = tyres.map((t) => ({
    matrix: new THREE.Matrix4().makeRotationY(rand() * Math.PI).setPosition(t.x, t.y - 0.05, t.z),
    color: new THREE.Color(t.c),
  }));
  // chunked like the forest; the barriers hug the track, so smaller cells pay off
  for (const inst of chunkedInstances(stackGeo, mats, stacks, 60, 'tyres')) {
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  }
  const m = new THREE.Matrix4();

  // Concrete walls with advertising and catch fence along the main straight
  const adTex = (() => {
    const cnv = document.createElement('canvas');
    cnv.width = 2048;
    cnv.height = 128;
    const ctx = cnv.getContext('2d')!;
    const ads: [string, string, string][] = [
      ['CLAUDE OPUS 5.5', '#1a1a1d', '#f1ece3'],
      ['GR KART', '#e0001b', '#ffffff'],
      ['SAKURA KART CIRCUIT', '#ffffff', '#111111'],
      ['215cc · 4-STROKE', '#111111', '#e0001b'],
    ];
    ads.forEach(([t, bg, fg], k) => {
      ctx.fillStyle = bg;
      ctx.fillRect(k * 512, 0, 512, 128);
      ctx.fillStyle = fg;
      ctx.font = 'italic 900 58px "Titillium Web", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, k * 512 + 256, 68, 480);
    });
    const t = new THREE.CanvasTexture(cnv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  })();
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xbdbab3, roughness: 0.9 });
  const adMat = new THREE.MeshStandardMaterial({ map: adTex, roughness: 0.6 });
  const fenceMat = new THREE.MeshStandardMaterial({
    map: TX.fence(),
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    metalness: 0.6,
    roughness: 0.5,
    transparent: false,
  });
  const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6);
  postGeo.translate(0, 1.6, 0);
  const posts: THREE.Vector3[] = [];
  for (const side of [1, -1] as const) {
    // collect runs of concrete
    let run: number[] = [];
    const flush = () => {
      if (run.length > 3) buildWallRun(track, run, side, concreteMat, adMat, fenceMat, group, posts);
      run = [];
    };
    for (let i = 0; i < track.N; i++) {
      const t = side > 0 ? track.wallTypeL[i] : track.wallTypeR[i];
      if (t === 1) run.push(i);
      else flush();
    }
    flush();
  }
  const postMesh = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.7, roughness: 0.4 }), posts.length);
  posts.forEach((p, k) => postMesh.setMatrixAt(k, m.makeTranslation(p.x, p.y, p.z)));
  postMesh.castShadow = true;
  group.add(postMesh);
}

function buildWallRun(
  track: Track,
  run: number[],
  side: 1 | -1,
  concreteMat: THREE.Material,
  adMat: THREE.Material,
  fenceMat: THREE.Material,
  group: THREE.Group,
  posts: THREE.Vector3[],
) {
  const wallPos: number[] = [];
  const adPos: number[] = [];
  const adUv: number[] = [];
  const fencePos: number[] = [];
  const fenceUv: number[] = [];
  let dist = 0;
  let lastPost = -10;
  const T = 0.3;
  const H = 0.95;
  const wallIdx: number[] = [];
  const quadIdx = (arr: number[], base: number) => arr.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  const adIdx: number[] = [];
  const fenceIdx: number[] = [];
  let prev: THREE.Vector3 | null = null;
  run.forEach((i) => {
    const w = (side > 0 ? track.wallL[i] : track.wallR[i]) + 0.05;
    const nx = track.nx[i] * side;
    const nz = track.nz[i] * side;
    const x = track.px[i] + nx * w;
    const z = track.pz[i] + nz * w;
    const y = track.py[i] - 0.1;
    const cur = new THREE.Vector3(x, y, z);
    if (prev) dist += cur.distanceTo(prev);
    prev = cur;
    // wall cross-section: inner face bottom/top, outer top/bottom
    const base = wallPos.length / 3;
    wallPos.push(x, y, z, x, y + H, z, x + nx * T, y + H, z + nz * T, x + nx * T, y, z + nz * T);
    if (base > 0) {
      const p = base - 4;
      for (let k = 0; k < 3; k++) {
        const a = p + k;
        const b = p + k + 1;
        const c = base + k;
        const d = base + k + 1;
        wallIdx.push(a, b, c, b, d, c);
      }
    }
    const ab = adPos.length / 3;
    adPos.push(x - nx * 0.01, y + 0.12, z - nz * 0.01, x - nx * 0.01, y + H - 0.08, z - nz * 0.01);
    // mirror u on right-hand walls so the text reads correctly from the track
    adUv.push((side * dist) / 32, 0, (side * dist) / 32, 1);
    if (ab > 0) quadIdx(adIdx, ab - 2);
    const fb = fencePos.length / 3;
    fencePos.push(x + nx * 0.15, y + H, z + nz * 0.15, x + nx * 0.15, y + H + 2.3, z + nz * 0.15);
    fenceUv.push(dist / 0.9, 0, dist / 0.9, 2.3 / 0.9);
    if (fb > 0) quadIdx(fenceIdx, fb - 2);
    if (dist - lastPost > 4) {
      posts.push(new THREE.Vector3(x + nx * 0.15, y, z + nz * 0.15));
      lastPost = dist;
    }
  });
  const mk = (pos: number[], idx: number[], mat: THREE.Material, uv?: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const wallMat = concreteMat.clone();
  (wallMat as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  mk(wallPos, wallIdx, wallMat);
  const adMatDS = adMat.clone();
  (adMatDS as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  (adMatDS as THREE.MeshStandardMaterial).polygonOffset = true;
  (adMatDS as THREE.MeshStandardMaterial).polygonOffsetFactor = -1;
  mk(adPos, adIdx, adMatDS, adUv);
  const f = mk(fencePos, fenceIdx, fenceMat, fenceUv);
  f.castShadow = false;
}
