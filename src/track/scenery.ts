import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { newProj, Track } from './track';
import { CIRCUIT_CENTER, POND, POND_LEVEL, pondRadius } from './terrain';
import * as TX from '../render/textures';
import { chunkedInstances } from '../render/chunks';
import { nonIndexed } from '../render/loft';
import { fbm, rng, smoothstep, valueNoise } from '../core/math';

// Everything around the circuit: grandstand + crowd, pit building, paddock,
// infield pond with a torii, instanced forests with wind, flags, Mt. Fuji.

export interface Scenery {
  group: THREE.Group;
  update(time: number, excitement: number): void;
  fuji: THREE.Mesh;
}

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const GRANDSTAND = { x0: -52, x1: 48, z: 96.5 };
const FOREST_CELL = 180;
const PIT = { x: -18, z: 53, w: 74, d: 11 };

const sharedUniforms = { uTime: { value: 0 }, uExcite: { value: 0 } };

function windify(mat: THREE.Material, strength = 0.06) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float h = max(0.0, transformed.y - 1.0);
        float sw = sin(uTime * 1.4 + ip.x * 0.07 + ip.z * 0.05) + 0.4 * sin(uTime * 3.1 + ip.z * 0.2);
        transformed.x += sw * ${strength.toFixed(3)} * h;
        transformed.z += sw * ${(strength * 0.6).toFixed(3)} * h;`,
      );
  };
  return mat;
}

export function buildScenery(track: Track, heightAt: (x: number, z: number) => number, quality: 'low' | 'medium' | 'high'): Scenery {
  const group = new THREE.Group();
  group.name = 'scenery';
  const rand = rng(2026);
  const exclusions: Rect[] = [];

  // ------------------------------------------------------------ grandstand
  {
    const rows = 11;
    const depth = 0.9;
    const rise = 0.46;
    const shape = new THREE.Shape();
    shape.moveTo(0, -1.5);
    let sy = 0.9;
    shape.lineTo(0, sy);
    for (let r = 0; r < rows; r++) {
      shape.lineTo((r + 1) * depth, sy); // tread
      if (r < rows - 1) {
        sy += rise;
        shape.lineTo((r + 1) * depth, sy); // riser
      }
    }
    const top = sy;
    shape.lineTo(rows * depth, top + 2.4);
    shape.lineTo(rows * depth + 0.4, top + 2.4);
    shape.lineTo(rows * depth + 0.4, -1.5);
    shape.closePath();
    const len = GRANDSTAND.x1 - GRANDSTAND.x0;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
    geo.rotateY(-Math.PI / 2);
    const baseY = heightAt((GRANDSTAND.x0 + GRANDSTAND.x1) / 2, GRANDSTAND.z + 4);
    const stand = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.85 }));
    stand.position.set(GRANDSTAND.x1, baseY, GRANDSTAND.z);
    stand.castShadow = true;
    stand.receiveShadow = true;
    group.add(stand);
    // coloured seat rows
    const seatGeos: THREE.BufferGeometry[] = [];
    for (let r = 0; r < rows; r++) {
      const g = new THREE.BoxGeometry(len - 1, 0.12, 0.36);
      g.translate((GRANDSTAND.x0 + GRANDSTAND.x1) / 2, baseY + 0.96 + r * rise, GRANDSTAND.z + r * depth + 0.55);
      seatGeos.push(g);
    }
    const seats = new THREE.Mesh(mergeGeometries(seatGeos), new THREE.MeshStandardMaterial({ color: 0xc8141e, roughness: 0.6 }));
    seats.receiveShadow = true;
    group.add(seats);
    // roof
    const roofY = baseY + top + 5.2;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.35, rows * depth + 3), new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.7, metalness: 0.3 }));
    roof.position.set((GRANDSTAND.x0 + GRANDSTAND.x1) / 2, roofY, GRANDSTAND.z + (rows * depth) / 2 + 0.2);
    roof.rotation.x = -0.06;
    roof.castShadow = true;
    group.add(roof);
    const fascia = new THREE.Mesh(
      new THREE.PlaneGeometry(len + 2, 1.4),
      new THREE.MeshStandardMaterial({ map: TX.banner('SAKURA KART CIRCUIT  ·  GR KART  ·  CLAUDE OPUS 5.5', '#e0001b', '#fff', '#111', 4096, 128), roughness: 0.5 }),
    );
    fascia.position.set((GRANDSTAND.x0 + GRANDSTAND.x1) / 2, roofY - 0.3, GRANDSTAND.z - 1.35);
    fascia.rotation.y = Math.PI;
    group.add(fascia);
    const colGeo = new THREE.CylinderGeometry(0.16, 0.16, roofY - baseY, 8);
    const colMat = new THREE.MeshStandardMaterial({ color: 0x33363b, metalness: 0.6, roughness: 0.4 });
    for (let x = GRANDSTAND.x0 + 2; x <= GRANDSTAND.x1 - 2; x += 12) {
      const c = new THREE.Mesh(colGeo, colMat);
      c.position.set(x, (roofY + baseY) / 2, GRANDSTAND.z + rows * depth + 0.2);
      c.castShadow = true;
      group.add(c);
    }
    exclusions.push({ x0: GRANDSTAND.x0 - 4, x1: GRANDSTAND.x1 + 4, z0: GRANDSTAND.z - 3, z1: GRANDSTAND.z + rows * depth + 6 });

    // Crowd — instanced, bobbing via vertex shader, louder on excitement.
    const body = new THREE.CapsuleGeometry(0.19, 0.42, 2, 6);
    body.translate(0, 0.4, 0);
    const head = new THREE.SphereGeometry(0.12, 8, 6);
    head.translate(0, 0.95, 0);
    const skin = new THREE.Color(0xe9c29b);
    const hc = new Float32Array(head.getAttribute('position').count * 3);
    for (let i = 0; i < hc.length; i += 3) {
      hc[i] = skin.r;
      hc[i + 1] = skin.g;
      hc[i + 2] = skin.b;
    }
    head.setAttribute('color', new THREE.BufferAttribute(hc, 3));
    const bc = new Float32Array(body.getAttribute('position').count * 3).fill(1);
    body.setAttribute('color', new THREE.BufferAttribute(bc, 3));
    const person = mergeGeometries([nonIndexed(body), nonIndexed(head)])!;
    const crowdMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    crowdMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = sharedUniforms.uTime;
      shader.uniforms.uExcite = sharedUniforms.uExcite;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uExcite;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float hsh = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
          float jump = max(0.0, sin(uTime * (4.0 + hsh * 5.0) + hsh * 6.28));
          transformed.y += jump * (0.03 + uExcite * 0.28);
          transformed.x += sin(uTime * 1.3 + hsh * 20.0) * 0.03;`,
        );
    };
    const perRow = quality === 'low' ? 40 : quality === 'medium' ? 70 : 95;
    const count = perRow * rows;
    const crowd = new THREE.InstancedMesh(person, crowdMat, count);
    const palette = [0xe0001b, 0xffffff, 0x1a1a1a, 0x2e6bff, 0xffc400, 0x13b36b, 0xff6a00, 0x9b3cff, 0xf2f2f2, 0xe0001b];
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < perRow; i++) {
        if (rand() < 0.14) continue;
        const x = GRANDSTAND.x0 + 1.2 + ((len - 2.4) * (i + rand() * 0.6)) / perRow;
        const y = baseY + 0.9 + r * rise;
        const z = GRANDSTAND.z + r * depth + 0.62;
        const s = 0.9 + rand() * 0.2;
        m.makeRotationY(Math.PI + (rand() - 0.5) * 0.6);
        m.scale(new THREE.Vector3(s, s, s));
        m.setPosition(x, y, z);
        crowd.setMatrixAt(k, m);
        crowd.setColorAt(k, c.setHex(palette[Math.floor(rand() * palette.length)]).multiplyScalar(0.75 + rand() * 0.3));
        k++;
      }
    }
    crowd.count = k;
    crowd.castShadow = quality !== 'low';
    crowd.receiveShadow = true;
    group.add(crowd);
  }

  // ------------------------------------------------------------ pit building
  {
    const baseY = heightAt(PIT.x, PIT.z + 4);
    const facade = makeFacadeTexture();
    const mats = [
      new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.7 }),
      new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.7 }),
      new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 }),
      new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.7 }),
      new THREE.MeshStandardMaterial({ map: facade, roughness: 0.25, metalness: 0.35 }),
      new THREE.MeshStandardMaterial({ color: 0xd8d6d0, roughness: 0.7 }),
    ];
    const bld = new THREE.Mesh(new THREE.BoxGeometry(PIT.w, 7.5, PIT.d), mats);
    bld.position.set(PIT.x, baseY + 3.75 - 0.5, PIT.z);
    bld.castShadow = true;
    bld.receiveShadow = true;
    group.add(bld);
    // Cantilevered roof and signage
    const roof = new THREE.Mesh(new THREE.BoxGeometry(PIT.w + 3, 0.4, PIT.d + 5), new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.5 }));
    roof.position.set(PIT.x, baseY + 7.3, PIT.z + 2);
    roof.castShadow = true;
    group.add(roof);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 2.6),
      new THREE.MeshStandardMaterial({ map: TX.banner('GR KART', '#e0001b', '#ffffff', '#111', 1024, 128), roughness: 0.4, emissive: 0xffffff, emissiveIntensity: 0.08, emissiveMap: TX.banner('GR KART', '#e0001b', '#ffffff', '#111', 1024, 128) }),
    );
    sign.position.set(PIT.x - 18, baseY + 9.1, PIT.z + 2.2);
    group.add(sign);
    const sign2 = new THREE.Mesh(new THREE.PlaneGeometry(30, 2.6), new THREE.MeshStandardMaterial({ map: TX.banner('SAKURA KART CIRCUIT', '#111', '#ffffff', '#e0001b', 1024, 96), roughness: 0.4 }));
    sign2.position.set(PIT.x + 16, baseY + 9.1, PIT.z + 2.2);
    group.add(sign2);
    const signBack = new THREE.Mesh(new THREE.BoxGeometry(60, 2.8, 0.3), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    signBack.position.set(PIT.x - 1, baseY + 9.1, PIT.z + 2.0);
    group.add(signBack);
    // Control tower
    const tower = new THREE.Mesh(new THREE.BoxGeometry(7, 15, 7), mats[0]);
    tower.position.set(PIT.x - PIT.w / 2 - 2, baseY + 7, PIT.z);
    tower.castShadow = true;
    group.add(tower);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(7.6, 3, 7.6), new THREE.MeshStandardMaterial({ color: 0x1b2c3c, metalness: 0.9, roughness: 0.08 }));
    glass.position.set(PIT.x - PIT.w / 2 - 2, baseY + 13.2, PIT.z);
    group.add(glass);
    exclusions.push({ x0: PIT.x - PIT.w / 2 - 8, x1: PIT.x + PIT.w / 2 + 4, z0: PIT.z - PIT.d / 2 - 16, z1: PIT.z + PIT.d / 2 + 5 });

    // Paddock tents and vans behind the building
    const tentColors = [0xe0001b, 0xffffff, 0x1565ff, 0xffc400, 0x13b36b, 0x222222];
    for (let i = 0; i < 7; i++) {
      const x = PIT.x - 30 + i * 9.5;
      const z = PIT.z - 13;
      const y = heightAt(x, z);
      const tg = new THREE.Group();
      tg.position.set(x, y, z);
      const top = new THREE.Mesh(new THREE.ConeGeometry(3.4, 1.6, 4, 1), new THREE.MeshStandardMaterial({ color: tentColors[i % tentColors.length], roughness: 0.7 }));
      top.rotation.y = Math.PI / 4;
      top.position.y = 3.2;
      top.castShadow = true;
      tg.add(top);
      for (const [lx, lz] of [
        [-2.3, -2.3],
        [2.3, -2.3],
        [-2.3, 2.3],
        [2.3, 2.3],
      ]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5), new THREE.MeshStandardMaterial({ color: 0x999999 }));
        leg.position.set(lx, 1.25, lz);
        tg.add(leg);
      }
      group.add(tg);
    }
    for (let i = 0; i < 5; i++) {
      const x = PIT.x - 26 + i * 12 + rand() * 3;
      const z = PIT.z - 22 - rand() * 4;
      const van = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.9, 4.7), new THREE.MeshStandardMaterial({ color: [0xffffff, 0xd8d8d8, 0x222222, 0x8a1016][i % 4], roughness: 0.35, metalness: 0.4 }));
      van.position.set(x, heightAt(x, z) + 1.1, z);
      van.rotation.y = (rand() - 0.5) * 0.3;
      van.castShadow = true;
      group.add(van);
    }
  }

  // --------------------------------------------------------------- flags
  {
    const flagMat = (tex: THREE.Texture) => {
      const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.7 });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = sharedUniforms.uTime;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            float fx = (position.x + 0.9);
            transformed.z += sin(fx * 3.2 - uTime * 7.0 + modelMatrix[3][0]) * 0.13 * fx;
            transformed.y += sin(fx * 2.1 - uTime * 5.0) * 0.04 * fx;`,
          );
      };
      return mat;
    };
    const texes = [
      TX.checker(6, 4),
      TX.banner('GR', '#e0001b', '#fff', '#111', 256, 160),
      TX.banner('OPUS 5.5', '#1a1a1d', '#f1ece3', '#d97757', 512, 320),
      TX.banner('桜', '#ffffff', '#e0001b', undefined, 256, 160),
    ];
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.06, 7, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xcfcfcf, metalness: 0.8, roughness: 0.3 });
    for (let i = 0; i < 8; i++) {
      const x = -30 + i * 9;
      const z = 92.5;
      const y = heightAt(x, z + 2);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(x, y + 3.5, z + 1.2);
      group.add(pole);
      const fg = new THREE.PlaneGeometry(1.8, 1.1, 14, 6);
      const f = new THREE.Mesh(fg, flagMat(texes[i % texes.length]));
      f.position.set(x - 0.9, y + 6.3, z + 1.2);
      f.castShadow = true;
      group.add(f);
    }
  }

  // ------------------------------------------------------ pond and torii
  {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const r = pondRadius(a) * 1.02;
      pts.push(new THREE.Vector2(POND.x + Math.cos(a) * r, POND.z + Math.sin(a) * r));
    }
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.y)));
    const g = new THREE.ShapeGeometry(shape, 8);
    g.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(
      g,
      new THREE.MeshPhysicalMaterial({
        color: 0x1d4a55,
        roughness: 0.04,
        metalness: 0.1,
        clearcoat: 1,
        normalMap: makeWaterNormals(),
        normalScale: new THREE.Vector2(0.25, 0.25),
        transparent: true,
        opacity: 0.92,
      }),
    );
    water.position.y = POND_LEVEL;
    water.receiveShadow = true;
    water.name = 'water';
    (water.material as THREE.MeshPhysicalMaterial).normalMap!.repeat.set(0.08, 0.08);
    group.add(water);
    // torii standing in the water
    const vermilion = new THREE.MeshStandardMaterial({ color: 0xe0381b, roughness: 0.5 });
    const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.5 });
    const torii = new THREE.Group();
    const tx = POND.x + 4;
    const tz = POND.z + pondRadius(Math.atan2(1, 0)) * 0.55;
    torii.position.set(tx, POND_LEVEL - 0.2, tz);
    torii.rotation.y = 0.35;
    for (const sx of [-2.1, 2.1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.33, 6.2, 12), vermilion);
      p.position.set(sx, 3.1, 0);
      p.castShadow = true;
      torii.add(p);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.5, 12), black);
      base.position.set(sx, 0.25, 0);
      torii.add(base);
    }
    const nuki = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.35, 0.3), vermilion);
    nuki.position.y = 4.7;
    torii.add(nuki);
    const kasagiShape = new THREE.Shape();
    kasagiShape.moveTo(-3.8, 0.25);
    kasagiShape.quadraticCurveTo(0, -0.05, 3.8, 0.25);
    kasagiShape.lineTo(3.9, 0.62);
    kasagiShape.quadraticCurveTo(0, 0.3, -3.9, 0.62);
    kasagiShape.closePath();
    const kasagiGeo = new THREE.ExtrudeGeometry(kasagiShape, { depth: 0.5, bevelEnabled: false });
    kasagiGeo.translate(0, 0, -0.25);
    const kasagi = new THREE.Mesh(kasagiGeo, black);
    kasagi.position.y = 5.75;
    kasagi.castShadow = true;
    torii.add(kasagi);
    const shimaki = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.4, 0.45), vermilion);
    shimaki.position.y = 5.85;
    torii.add(shimaki);
    const gakuzuka = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 0.2), black);
    gakuzuka.position.y = 5.2;
    torii.add(gakuzuka);
    group.add(torii);
  }

  // ------------------------------------------------------------------ trees
  const trees = buildForest(track, heightAt, exclusions, quality);
  group.add(trees);

  // ----------------------------------------------------- Mt. Fuji & ranges
  const fuji = buildFuji();
  group.add(fuji);
  group.add(buildRanges());

  return {
    group,
    fuji,
    update(time: number, excitement: number) {
      sharedUniforms.uTime.value = time;
      sharedUniforms.uExcite.value += (excitement - sharedUniforms.uExcite.value) * 0.05;
    },
  };
}

function makeFacadeTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#e9e7e2';
  ctx.fillRect(0, 0, 1024, 128);
  // upper glazing
  const g = ctx.createLinearGradient(0, 8, 0, 56);
  g.addColorStop(0, '#2b4a63');
  g.addColorStop(1, '#0f1c28');
  ctx.fillStyle = g;
  ctx.fillRect(0, 10, 1024, 44);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let x = 0; x < 1024; x += 32) ctx.fillRect(x, 10, 2, 44);
  // garage doors
  for (let i = 0; i < 10; i++) {
    const x = 14 + i * 101;
    ctx.fillStyle = i % 3 === 1 ? '#1d1f22' : '#bfc2c6';
    ctx.fillRect(x, 66, 84, 60);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 68; y < 126; y += 5) ctx.fillRect(x, y, 84, 1);
    ctx.fillStyle = '#e0001b';
    ctx.fillRect(x, 62, 84, 3);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 12px Arial';
    ctx.fillText(`${i + 1}`, x + 38, 76);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeWaterNormals() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const h = (x: number, y: number) => {
    const u = x / S;
    const v = y / S;
    // tileable sum of sines
    return (
      Math.sin((u * 6 + v * 3) * Math.PI * 2) * 0.5 +
      Math.sin((u * 2 - v * 7) * Math.PI * 2) * 0.35 +
      Math.sin((u * 11 + v * 9) * Math.PI * 2) * 0.15
    );
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = h(x + 1, y) - h(x - 1, y);
      const dy = h(x, y + 1) - h(x, y - 1);
      const n = new THREE.Vector3(-dx * 3, -dy * 3, 1).normalize();
      const i = (y * S + x) * 4;
      img.data[i] = (n.x * 0.5 + 0.5) * 255;
      img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildForest(track: Track, heightAt: (x: number, z: number) => number, exclusions: Rect[], quality: string) {
  const g = new THREE.Group();
  g.name = 'forest';
  const rand = rng(77);
  const proj = newProj();
  const maxTrees = quality === 'low' ? 1100 : quality === 'medium' ? 2200 : 3400;

  // Geometries
  const pineFoliage = mergeGeometries(
    [0, 1, 2].map((k) => {
      const cg = new THREE.ConeGeometry(2.4 - k * 0.6, 3.2 - k * 0.5, 8, 1);
      cg.translate(0, 2.6 + k * 1.6, 0);
      return nonIndexed(cg);
    }),
  )!;
  const lumpy = (radius: number, detail: number, seed: number) => {
    const ig = new THREE.IcosahedronGeometry(radius, detail);
    const p = ig.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const n = 0.82 + 0.36 * valueNoise(x * 1.3 + seed, z * 1.3 + y * 0.7);
      p.setXYZ(i, x * n, y * n * 0.85, z * n);
    }
    ig.computeVertexNormals();
    return ig;
  };
  const broadFoliage = lumpy(2.3, 1, 3);
  broadFoliage.translate(0, 4.2, 0);
  const cherryParts = [lumpy(1.7, 1, 1), lumpy(1.4, 1, 5), lumpy(1.5, 1, 9), lumpy(1.2, 1, 13)];
  cherryParts[0].translate(0, 3.8, 0);
  cherryParts[1].translate(1.3, 3.4, 0.4);
  cherryParts[2].translate(-1.2, 3.5, -0.3);
  cherryParts[3].translate(0.2, 4.6, 0.9);
  const cherryFoliage = mergeGeometries(cherryParts.map(nonIndexed))!;
  cherryFoliage.computeVertexNormals();
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 3.2, 6);
  trunk.translate(0, 1.6, 0);

  const types = [
    { foliage: pineFoliage, color: 0x2f5a2c, trunk: 0x4a3526, list: [] as THREE.Matrix4[], colors: [] as number[] },
    { foliage: broadFoliage, color: 0x4f7f33, trunk: 0x57402d, list: [] as THREE.Matrix4[], colors: [] as number[] },
    { foliage: cherryFoliage, color: 0xf4b6c8, trunk: 0x3b2a24, list: [] as THREE.Matrix4[], colors: [] as number[] },
  ];

  const inExcl = (x: number, z: number) => exclusions.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
  let placed = 0;
  let tries = 0;
  while (placed < maxTrees && tries < maxTrees * 30) {
    tries++;
    // bias samples towards the circuit area but spread out to the hills
    const r = Math.pow(rand(), 0.75) * 430;
    const a = rand() * Math.PI * 2;
    const x = CIRCUIT_CENTER.x + Math.cos(a) * r * 1.05;
    const z = CIRCUIT_CENTER.z + Math.sin(a) * r;
    const forest = fbm(x * 0.012 + 3, z * 0.012 - 7, 3);
    const nearPond = Math.hypot(x - POND.x, z - POND.z);
    const pondRim = nearPond < POND.r * 1.9 && nearPond > POND.r * 1.25;
    // clumped woodland: dense stands where the noise is high, open meadow elsewhere
    const clump = smoothstep(0.4, 0.62, forest);
    const density = r > 190 ? 0.04 + clump * 0.96 : clump * 0.75 + 0.02;
    if (!pondRim && rand() > density) continue;
    if (nearPond < POND.r * 1.25) continue;
    if (inExcl(x, z)) continue;
    if (track.projectNear(x, z, proj, 3)) {
      const wall = proj.lateral > 0 ? proj.wallL : proj.wallR;
      if (Math.abs(proj.lateral) < wall + 5) continue;
    }
    // keep sight-lines from the grandstand open
    if (z > 70 && z < 130 && x > -70 && x < 70) continue;
    const y = heightAt(x, z);
    let t = 1;
    if (pondRim) t = 2;
    else if (r > 230) t = rand() < 0.65 ? 0 : 1;
    else t = rand() < 0.28 ? 2 : rand() < 0.5 ? 0 : 1;
    const s = (0.75 + rand() * 0.6) * (r > 250 ? 1.35 : 1);
    const mtx = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y - 0.1, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2),
      new THREE.Vector3(s, s * (0.85 + rand() * 0.35), s),
    );
    types[t].list.push(mtx);
    types[t].colors.push(rand());
    placed++;
  }

  const trunkMatBase = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  for (const ty of types) {
    if (!ty.list.length) continue;
    const fMat = windify(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: false }), ty.foliage === cherryFoliage ? 0.04 : 0.05);
    const tMat = trunkMatBase.clone();
    tMat.color.setHex(ty.trunk);
    const foliage = ty.list.map((matrix, k) => {
      const v = ty.colors[k];
      return { matrix, color: new THREE.Color(ty.color).offsetHSL((v - 0.5) * 0.04, (v - 0.5) * 0.15, (v - 0.5) * 0.12) };
    });
    // ~180 m cells: the 72 m shadow frustum only has to draw the stands it touches
    for (const fol of chunkedInstances(ty.foliage, fMat, foliage, FOREST_CELL, 'foliage')) {
      fol.castShadow = true;
      fol.receiveShadow = true;
      g.add(fol);
    }
    for (const tr of chunkedInstances(trunk, tMat, ty.list.map((matrix) => ({ matrix })), FOREST_CELL, 'trunks')) {
      tr.castShadow = true;
      g.add(tr);
    }
  }
  return g;
}

function buildFuji() {
  const H = 1000;
  const R = 3300;
  const rTop = 170;
  const prof: THREE.Vector2[] = [];
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const h = t * H;
    const r = rTop + (R - rTop) * Math.pow(1 - t, 2.3);
    prof.push(new THREE.Vector2(r, h));
  }
  prof.push(new THREE.Vector2(rTop * 0.75, H - 14));
  prof.push(new THREE.Vector2(0.1, H - 18));
  const g = new THREE.LatheGeometry(prof, 160);
  const p = g.getAttribute('position');
  const colors = new Float32Array(p.count * 3);
  const snow = new THREE.Color(0xf4f7fb);
  const rock = new THREE.Color(0x5d6a82);
  const forest = new THREE.Color(0x3c5566);
  const haze = new THREE.Color(0x9fb5cc);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const ang = Math.atan2(z, x);
    const hn = y / H;
    // erosion gullies — stronger near the summit
    const gully = valueNoise(ang * 22, hn * 3) * 0.6 + valueNoise(ang * 55, hn * 6) * 0.4;
    const k = 1 + (gully - 0.5) * 0.05 * smoothstep(0.2, 0.9, hn);
    p.setXYZ(i, x * k, y, z * k);
    const snowLine = 0.58 + (gully - 0.5) * 0.4;
    if (hn > snowLine) c.copy(snow).multiplyScalar(0.92 + gully * 0.08);
    else if (hn > 0.3) c.copy(rock).lerp(forest, smoothstep(0.55, 0.3, hn));
    else c.copy(forest);
    c.lerp(haze, 0.2 + (1 - hn) * 0.28);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, fog: false }));
  mesh.position.set(CIRCUIT_CENTER.x - 3700, -30, CIRCUIT_CENTER.z - 1350);
  mesh.name = 'fuji';
  return mesh;
}

function buildRanges() {
  // Two layered rings of distant ridges for depth, excluding Fuji's bearing.
  const g = new THREE.Group();
  const fujiAng = Math.atan2(-1350, -3700);
  const layers = [
    { r: 1500, h: 120, col: 0x4d6b5b, haze: 0.45 },
    { r: 2600, h: 240, col: 0x5f7890, haze: 0.62 },
  ];
  layers.forEach((L, li) => {
    const seg = 256;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const base = new THREE.Color(L.col);
    const haze = new THREE.Color(0xa9bdd0);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      let d = Math.abs(Math.atan2(Math.sin(a - fujiAng), Math.cos(a - fujiAng)));
      const clear = smoothstep(0.08, 0.35, d);
      const n = fbm(Math.cos(a) * 3 + li * 10, Math.sin(a) * 3, 5);
      const h = (0.25 + n * 0.9) * L.h * (li === 0 ? 1 : clear * 0.8 + 0.2);
      const x = CIRCUIT_CENTER.x + Math.cos(a) * L.r;
      const z = CIRCUIT_CENTER.z + Math.sin(a) * L.r;
      const x2 = CIRCUIT_CENTER.x + Math.cos(a) * (L.r + 500);
      const z2 = CIRCUIT_CENTER.z + Math.sin(a) * (L.r + 500);
      pos.push(x, -20, z, x2, h, z2, x2 + Math.cos(a) * 600, -20, z2 + Math.sin(a) * 600);
      const c = base.clone().lerp(haze, L.haze);
      const cTop = c.clone().lerp(haze, 0.15);
      col.push(c.r, c.g, c.b, cTop.r, cTop.g, cTop.b, c.r, c.g, c.b);
      d = 0;
    }
    for (let i = 0; i < seg; i++) {
      const a = i * 3;
      const b = (i + 1) * 3;
      idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
    g.add(m);
  });
  return g;
}
