// Emulates a keyboard player: the AI decides, but inputs are quantised to
// on/off keys and pass through the same ramping as Input.update().
import { Track } from '../src/track/track';
import { SAKURA_CIRCUIT } from '../src/track/trackData';
import { computeRacingLine } from '../src/track/racingLine';
import { KartPhysics, CG_OFFSET } from '../src/kart/kartPhysics';
import { AIDriver } from '../src/game/ai';
import { moveTowards } from '../src/core/math';

const track = new Track(SAKURA_CIRCUIT.name, SAKURA_CIRCUIT.points);
const line = computeRacingLine(track);
const assist = process.argv[2] !== 'noassist';
const skill = Number(process.argv[3] ?? 0.93);
const racer: any = { phys: new KartPhysics(), isGhost: false };
racer.phys.assist = assist;
const ai = new AIDriver({ skill, aggression: 0.5, consistency: 1, reaction: 0 });
const p = track.pointAt(-7, 0);
const h = track.headingAt(-7);
racer.phys.setPose(p.x - Math.sin(h) * CG_OFFSET, p.z - Math.cos(h) * CG_OFFSET, h, track);
const dt = 1 / 240;
let t = 0, spins = 0, off = 0, spinning = false, walls = 0;
let kbS = 0, kbT = 0, kbB = 0;
let dist = track.deltaS(0, racer.phys.proj.s), lastS = racer.phys.proj.s, lap = -1, lapStart = 0;
while (t < 200 && lap < 3) {
  const c = ai.update(dt, racer, [racer], track, line, true);
  // keyboard quantisation with a little hysteresis (human tapping)
  const ts = Math.abs(c.steer) > 0.3 ? Math.sign(c.steer) : 0;
  const returning = ts === 0 || Math.sign(ts) !== Math.sign(kbS);
  kbS = moveTowards(kbS, ts, dt * (returning ? 7.5 : 4.2));
  kbT = moveTowards(kbT, c.throttle > 0.5 ? 1 : 0, dt * 6);
  kbB = moveTowards(kbB, c.brake > 0.3 ? 1 : 0, dt * 5);
  racer.phys.step(dt, { steer: kbS, throttle: kbT, brake: kbB }, track);
  t += dt;
  const P = racer.phys;
  const s = P.proj.s;
  dist += track.deltaS(lastS, s); lastS = s;
  const nl = Math.floor(dist / track.length);
  if (nl > lap) { if (lap >= 0) console.log(`lap ${lap + 1} ${(t - lapStart).toFixed(2)}`); lap = nl; lapStart = t; }
  if (process.env.TRACE && t > Number(process.env.T0) && t < Number(process.env.T1) && Math.round(t * 240) % 12 === 0)
    console.log(`t=${t.toFixed(2)} s=${s.toFixed(0)} v=${P.speed.toFixed(1)} lat=${P.proj.lateral.toFixed(1)} kbS=${kbS.toFixed(2)} aiS=${c.steer.toFixed(2)} thr=${kbT.toFixed(1)} brk=${kbB.toFixed(1)} steer=${P.steer.toFixed(3)} aF=${P.slipF.toFixed(3)} aR=${P.slipR.toFixed(3)} yaw=${P.yawRate.toFixed(2)} latG=${P.latG.toFixed(2)} grass=${P.onGrass}`);
  if (P.onGrass > 0.5) off += dt;
  if (P.impact > 0.5) { walls++; P.impact = 0; }
  const rel = Math.abs(Math.atan2(Math.sin(P.heading - track.headingAt(s)), Math.cos(P.heading - track.headingAt(s))));
  if (rel > 1.2 && !spinning) { spins++; spinning = true; console.log(`spin s=${s.toFixed(0)} v=${P.speed.toFixed(1)} t=${t.toFixed(2)}`); }
  if (rel < 0.5) spinning = false;
}
console.log({ assist, skill, spins, offTrack: off.toFixed(1), walls });
