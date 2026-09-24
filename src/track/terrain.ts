import { fbm, smoothstep } from '../core/math';

// Smooth height field the circuit is draped over. Gentle near the track, rising
// into forested hills towards the horizon.

export const CIRCUIT_CENTER = { x: 20, z: -5 };

/** Infield pond (carved into the terrain; well clear of the track). */
export const POND = { x: -32, z: -28, r: 19 };

function rawHeight(x: number, z: number) {
  let h = 2.4 * Math.sin(x * 0.0105 + 0.6) * Math.cos(z * 0.0125 - 0.4);
  h += 2.6 * (fbm(x * 0.0035 + 10.3, z * 0.0035 - 3.1, 3) - 0.5);
  const r = Math.hypot(x - CIRCUIT_CENTER.x, z - CIRCUIT_CENTER.z);
  const far = smoothstep(240, 620, r);
  h += far * (18 + 70 * fbm(x * 0.0024 + 4.2, z * 0.0024 + 7.7, 5));
  return h;
}

export const POND_LEVEL = rawHeight(POND.x, POND.z) - 0.35;

/** Pond outline radius at a given angle (organic, not a perfect circle). */
export function pondRadius(angle: number) {
  return POND.r * (1 + 0.18 * Math.sin(angle * 3 + 0.7) + 0.08 * Math.sin(angle * 5 + 2.1));
}

export function baseHeight(x: number, z: number) {
  const h = rawHeight(x, z);
  const dx = x - POND.x;
  const dz = z - POND.z;
  const d = Math.hypot(dx, dz);
  if (d > POND.r * 1.9) return h;
  const R = pondRadius(Math.atan2(dz, dx));
  const inside = 1 - smoothstep(R * 0.55, R * 1.08, d);
  const bed = POND_LEVEL - 1.2 * inside;
  const bank = smoothstep(R * 0.95, R * 1.6, d);
  return Math.min(h, bed + (h - bed) * bank + (inside > 0 ? 0 : 0));
}
