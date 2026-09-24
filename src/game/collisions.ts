import type { KartPhysics } from '../kart/kartPhysics';

// Kart-to-kart contact: each kart is approximated by two circles along its
// length. Contacts resolve with positional correction and an impulse that also
// transfers yaw (so a tap on the rear bumper can spin someone around).

const R = 0.56;
const OFF = 0.4;

export interface Contact {
  a: number;
  b: number;
  x: number;
  y: number;
  z: number;
  strength: number;
}

export function collideKarts(karts: KartPhysics[], contacts: Contact[]) {
  const n = karts.length;
  for (let i = 0; i < n; i++) {
    const A = karts[i];
    for (let j = i + 1; j < n; j++) {
      const B = karts[j];
      const dx0 = B.x - A.x;
      const dz0 = B.z - A.z;
      if (dx0 * dx0 + dz0 * dz0 > 4.5) continue;
      let best = 0;
      let nx = 0;
      let nz = 0;
      let cx = 0;
      let cz = 0;
      const sa = Math.sin(A.heading);
      const ca = Math.cos(A.heading);
      const sb = Math.sin(B.heading);
      const cb = Math.cos(B.heading);
      for (const oa of [OFF, -OFF]) {
        const ax = A.x + sa * oa;
        const az = A.z + ca * oa;
        for (const ob of [OFF, -OFF]) {
          const bx = B.x + sb * ob;
          const bz = B.z + cb * ob;
          const dx = bx - ax;
          const dz = bz - az;
          const d = Math.hypot(dx, dz);
          const pen = 2 * R - d;
          if (pen > best && d > 1e-5) {
            best = pen;
            nx = dx / d;
            nz = dz / d;
            cx = (ax + bx) / 2;
            cz = (az + bz) / 2;
          }
        }
      }
      if (best <= 0) continue;
      const mA = A.p.mass;
      const mB = B.p.mass;
      const inv = 1 / (mA + mB);
      // positional correction (mass-weighted)
      A.x -= nx * best * mB * inv;
      A.z -= nz * best * mB * inv;
      B.x += nx * best * mA * inv;
      B.z += nz * best * mA * inv;
      // relative velocity at the contact point (ω × r = (ω rz, -ω rx))
      const rax = cx - A.x;
      const raz = cz - A.z;
      const rbx = cx - B.x;
      const rbz = cz - B.z;
      const vax = A.vx + A.yawRate * raz;
      const vaz = A.vz - A.yawRate * rax;
      const vbx = B.vx + B.yawRate * rbz;
      const vbz = B.vz - B.yawRate * rbx;
      const rvx = vbx - vax;
      const rvz = vbz - vaz;
      const vn = rvx * nx + rvz * nz;
      if (vn >= 0) continue;
      const e = 0.35;
      const raXn = raz * nx - rax * nz;
      const rbXn = rbz * nx - rbx * nz;
      const IA = A.p.inertia;
      const IB = B.p.inertia;
      const denom = 1 / mA + 1 / mB + (raXn * raXn) / IA + (rbXn * rbXn) / IB;
      const J = (-(1 + e) * vn) / denom;
      const jx = J * nx;
      const jz = J * nz;
      A.vx -= jx / mA;
      A.vz -= jz / mA;
      B.vx += jx / mB;
      B.vz += jz / mB;
      // torque: τ = rz Fx − rx Fz
      A.yawRate -= ((raz * jx - rax * jz) / IA) * 0.32;
      B.yawRate += ((rbz * jx - rbx * jz) / IB) * 0.32;
      // a little tangential friction
      const tx = -nz;
      const tz = nx;
      const vt = rvx * tx + rvz * tz;
      const jt = Math.max(-Math.abs(J) * 0.25, Math.min(Math.abs(J) * 0.25, (-vt / (1 / mA + 1 / mB)) * 0.3));
      A.vx -= (jt * tx) / mA;
      A.vz -= (jt * tz) / mA;
      B.vx += (jt * tx) / mB;
      B.vz += (jt * tz) / mB;
      contacts.push({ a: i, b: j, x: cx, y: (A.y + B.y) / 2 + 0.25, z: cz, strength: -vn });
    }
  }
}
