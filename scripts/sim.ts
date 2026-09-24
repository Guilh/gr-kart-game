// Headless simulation harness: runs the real track, racing line, physics and AI
// without a browser to tune handling and verify the AI can lap cleanly.
import { Track } from '../src/track/track';
import { SAKURA_CIRCUIT } from '../src/track/trackData';
import { computeRacingLine } from '../src/track/racingLine';
import { KartPhysics, CG_OFFSET } from '../src/kart/kartPhysics';
import { AIDriver } from '../src/game/ai';

const track = new Track(SAKURA_CIRCUIT.name, SAKURA_CIRCUIT.points);
const line = computeRacingLine(track);
console.log('track length', track.length.toFixed(1), 'samples', track.N);
let vmin = 99, vmax = 0;
for (let i = 0; i < track.N; i++) { vmin = Math.min(vmin, line.speed[i]); vmax = Math.max(vmax, line.speed[i]); }
console.log('line speed min/max', vmin.toFixed(1), vmax.toFixed(1), 'brake zones', line.brakeZones.length);
let lt = 0; for (let i = 0; i < track.N; i++) lt += track.ds / line.speed[i];
console.log('theoretical line lap', lt.toFixed(2), 's');

const skill = Number(process.argv[2] ?? 0.95);
const laps = Number(process.argv[3] ?? 3);
const racer: any = { phys: new KartPhysics(), isGhost: false, controls: { steer: 0, throttle: 0, brake: 0 } };
const ai = new AIDriver({ skill, aggression: 0.5, consistency: 1, reaction: 0 });
const s0 = -7;
const p = track.pointAt(s0, 2.4);
const h = track.headingAt(s0);
racer.phys.setPose(p.x - Math.sin(h) * CG_OFFSET, p.z - Math.cos(h) * CG_OFFSET, h, track);
const dt = 1 / 240;
let t = 0, dist = track.deltaS(0, racer.phys.proj.s), lastS = racer.phys.proj.s;
let lapStart = 0, lap = Math.floor(dist / track.length);
let offTrack = 0, maxLat = 0, wallHits = 0, maxSlip = 0, spins = 0;
let spinning = false;
const log: string[] = [];
while (t < 400 && lap < laps) {
  const c = ai.update(dt, racer, [racer], track, line, true);
  racer.phys.step(dt, c, track);
  t += dt;
  const P = racer.phys;
  const s = P.proj.s;
  dist += track.deltaS(lastS, s);
  lastS = s;
  const nl = Math.floor(dist / track.length);
  if (nl > lap) {
    if (lap >= 0) log.push(`lap ${lap + 1}: ${(t - lapStart).toFixed(3)}s`);
    lapStart = t;
    lap = nl;
  }
  if (P.onGrass > 0.5) offTrack += dt;
  maxLat = Math.max(maxLat, Math.abs(P.proj.lateral) - P.proj.halfWidth);
  if (P.impact > 0.5) { wallHits++; log.push(`wall hit v=${P.impact.toFixed(1)} at s=${s.toFixed(0)} t=${t.toFixed(1)}`); P.impact = 0; }
  maxSlip = Math.max(maxSlip, Math.abs(P.slipR));
  const rel = Math.abs(Math.atan2(Math.sin(P.heading - track.headingAt(s)), Math.cos(P.heading - track.headingAt(s))));
  if (rel > 1.2 && !spinning) { spins++; spinning = true; log.push(`spin at s=${s.toFixed(0)} t=${t.toFixed(1)} v=${P.speed.toFixed(1)}`); }
  if (rel < 0.5) spinning = false;
  if (process.argv[4] === 'v' && t > Number(process.argv[5] ?? 0) && t < Number(process.argv[6] ?? 1e9) && Math.round(t * 240) % 24 === 0) {
    console.log(`t=${t.toFixed(1)} s=${s.toFixed(0)} v=${P.speed.toFixed(1)} lat=${P.proj.lateral.toFixed(2)} steer=${c.steer.toFixed(2)} thr=${c.throttle.toFixed(2)} brk=${c.brake.toFixed(2)} slipR=${P.slipR.toFixed(3)} slipF=${P.slipF.toFixed(3)} latG=${P.latG.toFixed(2)} rpm=${P.rpm.toFixed(0)}`);
  }
}
console.log(log.join('\n'));
console.log({ skill, time: t.toFixed(1), offTrack: offTrack.toFixed(1), maxBeyondEdge: maxLat.toFixed(2), wallHits, spins, maxSlipR: maxSlip.toFixed(3) });
