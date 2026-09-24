import * as THREE from 'three';

// Geometry helpers for organic, sculpted bodywork. Shapes are described as a
// sequence of cross-section "rings" that get skinned into a smooth mesh.

export type Ring = THREE.Vector3[];

/** Superellipse outline — n=2 is an ellipse, higher n gets boxier. */
/** Non-indexed copy of `g`, or `g` itself when it already is (three warns on a redundant toNonIndexed). */
export function nonIndexed(g: THREE.BufferGeometry) {
  return g.index ? g.toNonIndexed() : g;
}

export function superellipse(a: number, b: number, n: number, segments: number, start = 0, end = Math.PI * 2) {
  const pts: THREE.Vector2[] = [];
  const closed = Math.abs(end - start - Math.PI * 2) < 1e-6;
  const count = closed ? segments : segments + 1;
  for (let i = 0; i < count; i++) {
    const t = start + ((end - start) * i) / segments;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(
      new THREE.Vector2(
        a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n),
        b * Math.sign(s) * Math.pow(Math.abs(s), 2 / n),
      ),
    );
  }
  return pts;
}

/**
 * Smoothly interpolates between key rings (Catmull-Rom per ring vertex) to
 * produce `steps` intermediate rings between each pair.
 */
export function interpolateRings(keys: Ring[], steps: number): Ring[] {
  if (keys.length < 2) return keys;
  const n = keys[0].length;
  const curves: THREE.CatmullRomCurve3[] = [];
  for (let j = 0; j < n; j++) {
    curves.push(new THREE.CatmullRomCurve3(keys.map((r) => r[j]), false, 'catmullrom', 0.5));
  }
  const total = (keys.length - 1) * steps;
  const out: Ring[] = [];
  for (let i = 0; i <= total; i++) {
    const t = i / total;
    out.push(curves.map((c) => c.getPoint(t)));
  }
  return out;
}

export interface LoftOptions {
  closedRing?: boolean; // ring wraps around (true for closed cross-sections)
  capStart?: boolean;
  capEnd?: boolean;
  colorFn?: (ringIndex: number, pointIndex: number, p: THREE.Vector3) => THREE.Color | null;
}

/** Skins a list of rings (all with the same vertex count) into a mesh. */
export function loftRings(rings: Ring[], opts: LoftOptions = {}): THREE.BufferGeometry {
  const closedRing = opts.closedRing ?? true;
  const nR = rings.length;
  const nP = rings[0].length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const cols = closedRing ? nP + 1 : nP; // duplicate seam for clean UVs
  const useColor = !!opts.colorFn;
  const white = new THREE.Color(1, 1, 1);

  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < cols; j++) {
      const p = rings[i][j % nP];
      positions.push(p.x, p.y, p.z);
      uvs.push(j / (cols - 1), i / (nR - 1));
      if (useColor) {
        const c = opts.colorFn!(i, j % nP, p) ?? white;
        colors.push(c.r, c.g, c.b);
      }
    }
  }
  for (let i = 0; i < nR - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (useColor) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  // Make sure normals point away from each ring's centroid (outward).
  const centroids = rings.map((r) => r.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(r.length));
  const nAttr = geo.getAttribute('normal');
  let score = 0;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < cols; j++) {
      const k = i * cols + j;
      tmp.fromArray(positions, k * 3).sub(centroids[i]);
      score += tmp.x * nAttr.getX(k) + tmp.y * nAttr.getY(k) + tmp.z * nAttr.getZ(k);
    }
  }
  if (score < 0) {
    for (let k = 0; k < indices.length; k += 3) {
      const t = indices[k + 1];
      indices[k + 1] = indices[k + 2];
      indices[k + 2] = t;
    }
    geo.setIndex(indices);
    geo.computeVertexNormals();
  }
  fixSeamNormals(geo, nR, cols, closedRing);

  const parts: THREE.BufferGeometry[] = [geo];
  if (opts.capStart) {
    const out = centroids[0].clone().sub(centroids[Math.min(1, nR - 1)]);
    parts.push(capRing(rings[0], out, useColor ? opts.colorFn!(0, 0, rings[0][0]) : null));
  }
  if (opts.capEnd) {
    const out = centroids[nR - 1].clone().sub(centroids[Math.max(0, nR - 2)]);
    parts.push(capRing(rings[nR - 1], out, useColor ? opts.colorFn!(nR - 1, 0, rings[nR - 1][0]) : null));
  }
  if (parts.length === 1) return geo;
  return mergeSimple(parts, useColor);
}

/** Averages normals across the duplicated UV seam so it doesn't show. */
function fixSeamNormals(geo: THREE.BufferGeometry, nR: number, cols: number, closedRing: boolean) {
  if (!closedRing) return;
  const n = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < nR; i++) {
    const a = i * cols;
    const b = i * cols + cols - 1;
    const x = n.getX(a) + n.getX(b);
    const y = n.getY(a) + n.getY(b);
    const z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l);
    n.setXYZ(b, x / l, y / l, z / l);
  }
}

function capRing(ring: Ring, outward: THREE.Vector3, color: THREE.Color | null) {
  const center = new THREE.Vector3();
  ring.forEach((p) => center.add(p));
  center.divideScalar(ring.length);
  const positions: number[] = [center.x, center.y, center.z];
  ring.forEach((p) => positions.push(p.x, p.y, p.z));
  // Decide winding from the accumulated fan normal vs. the outward direction.
  const acc = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (let j = 0; j < ring.length; j++) {
    e1.copy(ring[j]).sub(center);
    e2.copy(ring[(j + 1) % ring.length]).sub(center);
    acc.add(e1.cross(e2));
  }
  const flip = acc.dot(outward) < 0;
  const idx: number[] = [];
  for (let j = 0; j < ring.length; j++) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % ring.length);
    if (flip) idx.push(0, b, a);
    else idx.push(0, a, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((ring.length + 1) * 2).fill(0.5), 2));
  if (color) {
    const cols: number[] = [];
    for (let i = 0; i <= ring.length; i++) cols.push(color.r, color.g, color.b);
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  }
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Minimal indexed merge (all parts share the same attribute layout). */
export function mergeSimple(parts: THREE.BufferGeometry[], withColor: boolean) {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const g of parts) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const c = g.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      if (withColor) colors.push(c ? c.getX(i) : 1, c ? c.getY(i) : 1, c ? c.getZ(i) : 1);
    }
    const idx = g.getIndex();
    if (idx) for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset);
    else for (let i = 0; i < p.count; i++) indices.push(i + offset);
    offset += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (withColor) out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  out.setIndex(indices);
  return out;
}

/**
 * Sweeps a 2D profile along a 3D path. The profile's x axis maps to the
 * frame's side vector, y to its "up" vector.
 */
export function sweep(
  path: THREE.Vector3[],
  profile: THREE.Vector2[],
  upHint: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
  opts: LoftOptions & { closedPath?: boolean } = {},
) {
  const rings: Ring[] = [];
  const n = path.length;
  const closedPath = !!opts.closedPath;
  for (let i = 0; i < n; i++) {
    const prev = path[closedPath ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = path[closedPath ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const t = next.clone().sub(prev).normalize();
    const side = new THREE.Vector3().crossVectors(upHint, t).normalize();
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(t, side).normalize();
    rings.push(profile.map((p) => path[i].clone().addScaledVector(side, p.x).addScaledVector(up, p.y)));
  }
  if (closedPath) rings.push(rings[0].map((p) => p.clone()));
  return loftRings(rings, opts);
}

/** Rounded rectangle profile for sweeps and extrusions. */
export function roundedRect(w: number, h: number, r: number, segs = 3) {
  const pts: THREE.Vector2[] = [];
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const corners = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, (Math.PI * 3) / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (i / segs) * (Math.PI / 2);
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  }
  return pts;
}

/** Ring geometry with polar UVs (u = angle, v = radius) for decals on discs. */
export function polarRing(inner: number, outer: number, segments = 64) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    positions.push(c * inner, s * inner, 0, c * outer, s * outer, 0);
    uvs.push(i / segments, 0, i / segments, 1);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Tube through points with a smooth Catmull-Rom interpolation. */
export function tube(points: THREE.Vector3[], radius: number, radial = 8, closed = false, tension = 0.5) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', tension);
  const len = curve.getLength();
  return new THREE.TubeGeometry(curve, Math.max(4, Math.ceil(len / 0.03)), radius, radial, closed);
}

export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
