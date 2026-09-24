// 8-kart pack race from the grid: traffic, overtakes, collisions.
import { Track } from '../src/track/track';
import { SAKURA_CIRCUIT } from '../src/track/trackData';
import { computeRacingLine } from '../src/track/racingLine';
import { KartPhysics, CG_OFFSET } from '../src/kart/kartPhysics';
import { AIDriver } from '../src/game/ai';
import { collideKarts, Contact } from '../src/game/collisions';

const gridSlot = (k: number) => ({ s: -7 - k * 5.5, lateral: k % 2 === 0 ? 2.4 : -2.4 });
const track = new Track(SAKURA_CIRCUIT.name, SAKURA_CIRCUIT.points);
const line = computeRacingLine(track);
const base = Number(process.argv[2] ?? 0.925);
const laps = Number(process.argv[3] ?? 3);
let seed = Number(process.argv[4] ?? 1);
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
Math.random = rnd;
const racers: any[] = [];
for (let k = 0; k < 8; k++) {
  const r: any = { id: k, phys: new KartPhysics(), isGhost: false, controls: { steer: 0, throttle: 0, brake: 0 } };
  r.ai = new AIDriver({ skill: Math.min(0.99, base + (rnd() - 0.5) * 0.035 + (8 - k) * 0.002), aggression: 0.15 + rnd() * 0.75, consistency: 0.86 + rnd() * 0.12, reaction: 0.12 + rnd() * 0.28 });
  const g = gridSlot(k);
  const p = track.pointAt(g.s, g.lateral);
  const h = track.headingAt(g.s);
  r.phys.setPose(p.x - Math.sin(h) * CG_OFFSET, p.z - Math.cos(h) * CG_OFFSET, h, track);
  r.dist = track.deltaS(0, r.phys.proj.s);
  r.lastS = r.phys.proj.s;
  r.stats = { off: 0, spins: 0, walls: 0, stuck: 0, spinning: false, finish: 0, contacts: 0 };
  racers.push(r);
}
const dt = 1 / 240;
let t = 0;
const contacts: Contact[] = [];
let totalContacts = 0;
while (t < 260) {
  for (const r of racers) {
    r.controls = r.ai.update(dt, r, racers, track, line, true);
    if (r.ai.needsReset) {
      r.ai.needsReset = false;
      const pr = r.phys.proj;
      const lat = Math.max(-pr.halfWidth + 1.5, Math.min(pr.halfWidth - 1.5, pr.lateral));
      const p = track.pointAt(pr.s, lat);
      r.phys.setPose(p.x, p.z, track.headingAt(pr.s), track);
      r.lastS = r.phys.proj.s;
      r.stats.resets = (r.stats.resets ?? 0) + 1;
    }
    r.phys.step(dt, r.controls, track);
  }
  contacts.length = 0;
  collideKarts(racers.map((r) => r.phys), contacts);
  for (const c of contacts) if (c.strength > 0.8) { totalContacts++; racers[c.a].stats.contacts++; racers[c.b].stats.contacts++; }
  t += dt;
  for (const r of racers) {
    const P = r.phys;
    const s = P.proj.s;
    r.dist += track.deltaS(r.lastS, s);
    r.lastS = s;
    if (!r.stats.finish && r.dist >= laps * track.length) r.stats.finish = t;
    if (P.onGrass > 0.5) r.stats.off += dt;
    if (P.impact > 0.5) { r.stats.walls++; P.impact = 0; }
    const rel = Math.abs(Math.atan2(Math.sin(P.heading - track.headingAt(s)), Math.cos(P.heading - track.headingAt(s))));
    if (rel > 1.2 && !r.stats.spinning) { r.stats.spins++; r.stats.spinning = true; if (process.env.SPINLOG) console.log(`spin #${r.id} s=${s.toFixed(0)} t=${t.toFixed(1)} v=${P.speed.toFixed(1)} lat=${P.proj.lateral.toFixed(1)} grass=${P.onGrass} aiLat=${r.ai.lateral.toFixed(1)} brake=${r.controls.brake.toFixed(2)}`); }
    if (rel < 0.5) r.stats.spinning = false;
    if (Math.abs(P.speed) < 1) r.stats.stuck += dt;
  }
  if (racers.every((r) => r.stats.finish)) break;
}
const order = [...racers].sort((a, b) => (a.stats.finish || 1e9) - (b.stats.finish || 1e9) || b.dist - a.dist);
for (const r of order) console.log(`#${r.id} skill=${r.ai.profile.skill.toFixed(3)} finish=${r.stats.finish ? r.stats.finish.toFixed(1) : 'DNF(' + r.dist.toFixed(0) + 'm)'} off=${r.stats.off.toFixed(1)} spins=${r.stats.spins} walls=${r.stats.walls} contacts=${r.stats.contacts} stuck=${r.stats.stuck.toFixed(1)} resets=${r.stats.resets ?? 0}`);
console.log('total contacts', totalContacts, 'sim time', t.toFixed(1));
