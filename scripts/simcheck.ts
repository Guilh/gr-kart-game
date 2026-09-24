// Regression check over the headless harnesses (runs them in parallel and parses their output).
// Fails on: any DNF, more than 14 spins in an 8-kart race, a spin or off-track in a solo AI run,
// a spin with the keyboard driver on assists, or a solo lap outside its difficulty band.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const tsx = (...args: string[]) => run('node_modules/.bin/tsx', args, { maxBuffer: 1 << 24 }).then((r) => r.stdout);

// steady-state lap (lap 3) per difficulty, recorded 2026-09-23; ±1 s bands
const SOLO = [
  { name: 'easy', skill: 0.85, lap: 50.8 },
  { name: 'medium', skill: 0.925, lap: 47.3 },
  { name: 'hard', skill: 0.985, lap: 44.8 },
];
const BAND = 1.0;
const SEEDS = [1, 2, 3, 4, 5, 6];
const MAX_SPINS_PER_RACE = 14;
const BASELINE_PACK_SPINS = 55; // total over the six seeds when recorded

const failures: string[] = [];
const num = (re: RegExp, text: string) => Number(text.match(re)?.[1] ?? NaN);

const [solo, pack, kb] = await Promise.all([
  Promise.all(SOLO.map((d) => tsx('scripts/sim.ts', String(d.skill), '3'))),
  Promise.all(SEEDS.map((seed) => tsx('scripts/sim8.ts', '0.95', '3', String(seed)))),
  tsx('scripts/simkb.ts', 'assist', '0.9'),
]);

console.log('solo AI (3 laps)');
SOLO.forEach((d, i) => {
  const out = solo[i];
  const lap = num(/lap 3: ([\d.]+)s/, out);
  const spins = num(/spins: (\d+)/, out);
  const off = num(/offTrack: '([\d.]+)'/, out);
  const ok = Math.abs(lap - d.lap) <= BAND && spins === 0 && off === 0;
  console.log(`  ${d.name.padEnd(6)} lap ${lap.toFixed(2)} s (band ${d.lap - BAND}–${d.lap + BAND})  spins ${spins}  off ${off}  ${ok ? 'ok' : 'FAIL'}`);
  if (!ok) failures.push(`solo ${d.name}`);
});

console.log('8-kart races (base skill 0.95, 3 laps)');
let totalSpins = 0;
SEEDS.forEach((seed, i) => {
  const rows = pack[i].split('\n').filter((l) => l.startsWith('#'));
  const spins = rows.reduce((a, l) => a + num(/spins=(\d+)/, l), 0);
  const resets = rows.reduce((a, l) => a + num(/resets=(\d+)/, l), 0);
  const dnf = rows.filter((l) => l.includes('DNF')).length;
  totalSpins += spins;
  const ok = dnf === 0 && spins <= MAX_SPINS_PER_RACE && rows.length === 8;
  console.log(`  seed ${seed}  spins ${String(spins).padStart(2)}  resets ${resets}  DNF ${dnf}  ${ok ? 'ok' : 'FAIL'}`);
  if (!ok) failures.push(`pack seed ${seed}`);
});
console.log(`  total spins ${totalSpins} (recorded baseline ${BASELINE_PACK_SPINS})`);

const kbSpins = num(/spins: (\d+)/, kb);
console.log(`keyboard driver with assists: spins ${kbSpins}  ${kbSpins === 0 ? 'ok' : 'FAIL'}`);
if (kbSpins !== 0) failures.push('keyboard assist');

if (failures.length) {
  console.log(`\nFAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
