import * as THREE from 'three';
import type { Input } from '../core/input';
import { clamp, rng } from '../core/math';
import type { CameraMode, Difficulty } from '../core/settings';
import { LIVERIES } from '../kart/kartModel';
import { audio, type EngineVoice } from '../audio/audio';
import { AIDriver } from './ai';
import { CameraRig, RIG_LABELS, RigMode } from './cameras';
import { collideKarts, Contact } from './collisions';
import { Racer } from './racer';
import { GhostLap, newSample, ReplayRecorder } from './replay';
import type { World } from './world';
import { gridSlot } from '../track/trackBuilder';

export type RaceMode = 'race' | 'timetrial' | 'attract';
export type RaceState = 'intro' | 'countdown' | 'running' | 'finished' | 'replay';

export interface RaceOptions {
  laps: number;
  opponents: number;
  difficulty: Difficulty;
  catchup: boolean;
  assist: boolean;
  camera: CameraMode;
  autopilot?: boolean;
}

export interface RaceEvents {
  message(text: string, kind?: 'big' | 'info' | 'good' | 'bad' | 'purple', seconds?: number): void;
  finished(results: ResultRow[]): void;
  lapSplit?(text: string, kind: 'good' | 'bad' | 'purple'): void;
}

export interface ResultRow {
  pos: number;
  name: string;
  code: string;
  color: number;
  time: number;
  bestLap: number;
  isPlayer: boolean;
  gapText: string;
}

export interface Standing {
  code: string;
  name: string;
  color: number;
  gap: number; // NaN until the racer's first timing marker past the line
  isPlayer: boolean;
  finished: boolean;
  lap: number;
}

const FIXED = 1 / 240;
/** Engine voices per race; they go to the karts nearest the camera. Each one is an AudioWorklet. */
const ENGINE_VOICES = 4;
const SKILL: Record<Difficulty, number> = { easy: 0.85, medium: 0.925, hard: 0.985 };

export class Race {
  racers: Racer[] = [];
  player: Racer | null = null;
  focus!: Racer;
  rig: CameraRig;
  state: RaceState = 'intro';
  stateTime = 0;
  raceTime = 0;
  lights = 0;
  private holdTime = 0;
  private acc = 0;
  private contacts: Contact[] = [];
  private voices: EngineVoice[] = [];
  private markerTimes = new Map<number, number>();
  recorder: ReplayRecorder | null = null;
  replayTime = 0;
  replaySpeed = 1;
  replayPaused = false;
  replayAuto = true;
  private replayShotTime = 0;
  private sample = newSample();
  ghost: GhostLap | null = null;
  ghostRacer: Racer | null = null;
  private ghostRec = new GhostLap();
  private bestSectors: number[] = [];
  private curSectors: number[] = [];
  lastDelta = NaN;
  excitement = 0.2;
  userCam: RigMode;
  private directorTime = 0;
  private finishShown = false;
  private finishTimer = 0;
  private lapEvent = new Map<Racer, number>();
  private fxAcc = new Map<Racer, number>();
  private wheelTmp: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  private stuckHintShown = 0;
  results: ResultRow[] | null = null;

  constructor(public world: World, public mode: RaceMode, public opts: RaceOptions, private events: RaceEvents) {
    this.rig = new CameraRig(world.track, world.visuals.cameraSpots);
    this.rig.groundAt = world.visuals.terrainHeightAt;
    this.rig.obstacles = world.obstacles;
    this.userCam = opts.camera === 'tv' ? 'tv' : opts.camera;
    this.setup();
  }

  // --------------------------------------------------------------- setup
  private setup() {
    const track = this.world.track;
    const rand = rng((Date.now() & 0xffff) + 7);
    const count = this.mode === 'timetrial' ? 1 : this.mode === 'attract' ? 8 : 1 + clamp(this.opts.opponents, 0, 7);
    const playerSlot = this.mode === 'race' ? Math.min(count - 1, 4) : -1;
    // attract mode uses every livery; the red #1 gets an AI driver name
    const aiLiveries = this.mode === 'attract' ? [{ ...LIVERIES[0], name: 'Kenta Arai', code: 'ARA' }, ...LIVERIES.slice(1)] : LIVERIES.slice(1);
    let aiIdx = 0;
    for (let slot = 0; slot < count; slot++) {
      const isPlayer = this.mode !== 'attract' && (this.mode === 'timetrial' || slot === playerSlot);
      const livery = isPlayer ? LIVERIES[0] : aiLiveries[aiIdx++ % aiLiveries.length];
      const base = this.mode === 'attract' ? 0.95 : SKILL[this.opts.difficulty];
      const ai = isPlayer
        ? null
        : new AIDriver({
            skill: Math.min(0.99, base + (rand() - 0.5) * 0.035 + (count - slot) * 0.002),
            aggression: 0.15 + rand() * 0.75,
            consistency: 0.86 + rand() * 0.12,
            reaction: 0.12 + rand() * 0.28,
          });
      const r = new Racer(slot, livery, isPlayer, ai);
      if (isPlayer) {
        r.name = 'You';
        this.player = r;
        r.phys.assist = this.opts.assist;
        if (this.opts.autopilot) r.ai = new AIDriver({ skill: 0.95, aggression: 0.5, consistency: 0.97, reaction: 0.15 });
      }
      const gs = gridSlot(slot);
      if (this.mode === 'timetrial') r.placeOnTrack(track, -60, 0);
      else r.placeOnTrack(track, gs.s, gs.lateral);
      this.world.scene.add(r.model.root);
      this.racers.push(r);
      this.lapEvent.set(r, -1);
    }
    this.focus = this.player ?? this.racers[0];
    if (this.mode === 'timetrial') {
      this.ghost = GhostLap.load();
      if (this.ghost) this.spawnGhost();
    }
    this.recorder = this.mode === 'attract' ? null : new ReplayRecorder(this.racers.length);
    if (this.mode === 'attract') {
      this.state = 'running';
      this.world.visuals.startLights.set(0);
      this.rig.setMode('tv');
    } else {
      this.state = 'intro';
      this.rig.setMode('heli');
      this.world.visuals.startLights.set(0);
    }
    this.world.clearFx();
  }

  private spawnGhost() {
    if (this.ghostRacer) return;
    const g = new Racer(99, LIVERIES[0], false, null, 'ghost');
    g.isGhost = true;
    this.ghostRacer = g;
    g.model.root.visible = false;
    this.world.scene.add(g.model.root);
  }

  attachAudio() {
    if (!audio.ready) return;
    while (this.voices.length < Math.min(ENGINE_VOICES, this.racers.length)) {
      const v = audio.createEngine(true);
      if (!v) return;
      this.voices.push(v);
    }
  }

  /** Give the engine voices to the karts nearest the camera; the focused kart always has one. */
  private assignVoices() {
    const cam = this.rig.camera.position;
    // karts that already have a voice count as 20% closer, so two karts near the cut-off don't swap every frame
    const ranked = this.racers.map((r) => ({ r, d: r === this.focus ? -1 : r.renderPos.distanceTo(cam) * (r.voice ? 0.8 : 1) })).sort((a, b) => a.d - b.d);
    const keep = new Set(ranked.slice(0, this.voices.length).map((x) => x.r));
    for (const r of this.racers) if (r.voice && !keep.has(r)) r.voice = null;
    const held = new Set(this.racers.map((r) => r.voice));
    const free = this.voices.filter((v) => !held.has(v));
    for (const r of keep) {
      if (r.voice) continue;
      const v = free.pop();
      if (!v) break;
      v.handover(r.renderPos.x, r.renderPos.y + 0.3, r.renderPos.z);
      r.voice = v;
    }
  }

  // ------------------------------------------------------------ main loop
  update(dt: number, input: Input) {
    this.stateTime += dt;
    if (this.state === 'replay') {
      this.updateReplay(dt, input);
      return;
    }
    // state machine
    if (this.state === 'intro') {
      this.lights = 0;
      if (this.stateTime > 4.2 || input.consume('confirm')) this.toCountdown();
    } else if (this.state === 'countdown') {
      const n = Math.min(5, Math.floor(this.stateTime / 0.9) + 1);
      if (n !== this.lights && this.stateTime < 4.5) {
        this.lights = n;
        this.world.visuals.startLights.set(n);
        audio.beep(520, 0.16, 0.2);
      }
      if (this.stateTime > 4.5 + this.holdTime) {
        this.lights = 0;
        this.world.visuals.startLights.set(0);
        this.state = 'running';
        this.stateTime = 0;
        this.raceTime = 0;
        this.racers.forEach((r) => (r.lapStart = 0));
        audio.beep(1040, 0.5, 0.28);
        this.excitement = 1;
        this.events.message('GO!', 'big', 1.2);
        input.rumble(0.3, 0.6, 250);
      }
    }

    // player input
    if (this.player && !this.player.finished) {
      const c = input.controls;
      this.player.controls.steer = c.steer;
      this.player.controls.throttle = c.throttle;
      this.player.controls.brake = c.brake;
      if (input.consume('reset') && (this.state === 'running' || this.state === 'finished')) {
        this.player.resetToTrack(this.world.track);
        this.events.message('Marshal assist — back on track', 'info', 1.6);
      }
    }
    if (input.consume('camera') && this.player && this.state !== 'finished') {
      const order: RigMode[] = ['chase', 'far', 'cockpit', 'bumper', 'tv'];
      this.userCam = order[(order.indexOf(this.userCam) + 1) % order.length];
      this.rig.setMode(this.userCam);
      this.events.message(RIG_LABELS[this.userCam], 'info', 1);
    }
    this.rig.lookBack = input.lookBack && !!this.player;

    // fixed-step simulation
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= FIXED) {
      this.fixedStep(FIXED);
      this.acc -= FIXED;
    }
    const alpha = this.acc / FIXED;
    for (const r of this.racers) r.syncVisual(alpha, dt);
    this.updateGhost(dt);
    this.fx(dt, input);
    this.director(dt);
    this.rig.update(dt, this.focus);
    this.world.env.follow(this.focus.renderPos);
    this.updateAudio();
    this.excitement = Math.max(0.15, this.excitement - dt * 0.25);

    // player hints
    if (this.player && this.state === 'running' && !this.player.finished) {
      const P = this.player.phys;
      if (this.player.wrongWay > 1.2) this.events.message('WRONG WAY', 'bad', 0.3);
      if (Math.abs(P.speed) < 0.6 && this.player.controls.throttle > 0.5) this.player.stuckTime += dt;
      else this.player.stuckTime = 0;
      if (this.player.stuckTime > 2.5 && performance.now() - this.stuckHintShown > 4000) {
        this.stuckHintShown = performance.now();
        this.events.message('Stuck? Press R to reset', 'info', 2.5);
      }
    }
    if (this.state === 'finished') {
      this.finishTimer += dt;
      const allDone = this.racers.every((r) => r.finished);
      if (!this.finishShown && (this.finishTimer > 3.2 || (allDone && this.finishTimer > 1.5))) {
        this.finishShown = true;
        this.results = this.buildResults();
        this.events.finished(this.results);
      }
    }
  }

  private toCountdown() {
    this.state = 'countdown';
    this.stateTime = 0;
    this.holdTime = 0.4 + Math.random() * 1.1;
    this.rig.setMode(this.userCam);
    this.racers.forEach((r) => r.ai?.resetStart());
    if (this.mode === 'timetrial') {
      this.state = 'running';
      this.raceTime = 0;
      this.events.message('Time Trial — the clock starts at the line', 'info', 2.5);
    }
  }

  skipIntro() {
    if (this.state === 'intro') this.toCountdown();
  }

  private fixedStep(dt: number) {
    const track = this.world.track;
    const racing = this.state === 'running' || this.state === 'finished';
    if (racing) this.raceTime += dt;
    for (const r of this.racers) {
      if (r.ai) {
        r.controls = r.ai.update(dt, r, this.racers, track, this.world.line, racing);
        if (r.ai.needsReset) {
          r.ai.needsReset = false;
          r.resetToTrack(track);
        }
      }
      r.phys.frozen = !racing;
      r.phys.step(dt, r.controls, track);
    }
    this.contacts.length = 0;
    collideKarts(
      this.racers.map((r) => r.phys),
      this.contacts,
    );
    if (!racing) return;
    for (const r of this.racers) {
      const completed = r.trackProgress(track);
      if (completed >= 0) this.onLine(r, completed);
      this.updateMarkers(r);
    }
    this.recorder?.step(dt, this.racers);
    if (this.mode === 'timetrial' && this.player && this.player.dist >= 0) {
      const lapDist = this.player.dist - this.player.lap * track.length;
      this.ghostRec.record(dt, this.raceTime - this.player.lapStart, this.player, lapDist);
      this.sectorCheck(this.player, lapDist);
    }
    // catch-up tuning for AI relative to the player
    if (this.opts.catchup && this.player && this.mode === 'race') {
      for (const r of this.racers) {
        if (!r.ai || r === this.player) continue;
        const gap = r.dist - this.player.dist;
        r.ai.catchup = clamp(1 - gap * 0.0006, 0.955, 1.035);
      }
    }
  }

  private onLine(r: Racer, completed: number) {
    const prev = this.lapEvent.get(r) ?? -1;
    if (completed <= prev) return;
    this.lapEvent.set(r, completed);
    if (this.mode === 'timetrial') {
      if (!r.isPlayer) return;
      if (completed === 0) {
        r.lapStart = this.raceTime;
        this.ghostRec.reset();
        this.curSectors = [];
        this.events.message('Lap started', 'info', 1);
        return;
      }
      const lapTime = this.raceTime - r.lapStart;
      r.lapTimes.push(lapTime);
      r.lapStart = this.raceTime;
      const prevBest = this.ghost?.time ?? Infinity;
      if (lapTime < prevBest) {
        this.ghostRec.time = lapTime;
        this.ghostRec.save();
        this.ghost = this.ghostRec;
        this.ghostRec = new GhostLap();
        this.bestSectors = this.curSectors.slice();
        this.spawnGhost();
        this.events.message(`NEW BEST  ${fmt(lapTime)}`, 'purple', 3);
      } else {
        this.events.message(`LAP  ${fmt(lapTime)}   (+${(lapTime - prevBest).toFixed(3)})`, 'info', 2.5);
        this.ghostRec.reset();
      }
      r.bestLap = Math.min(r.bestLap, lapTime);
      this.curSectors = [];
      return;
    }
    if (completed === 0) return; // crossing the line at the start
    const lapTime = this.raceTime - r.lapStart;
    r.lapTimes.push(lapTime);
    r.lapStart = this.raceTime;
    const wasBest = lapTime < r.bestLap;
    r.bestLap = Math.min(r.bestLap, lapTime);
    const overallBest = Math.min(...this.racers.map((x) => x.bestLap));
    if (this.mode === 'attract') return;
    if (completed >= this.opts.laps && !r.finished) {
      r.finished = true;
      r.finishTime = this.raceTime;
      if (r.isPlayer) {
        this.state = 'finished';
        this.finishTimer = 0;
        this.excitement = 1;
        const pos = this.positionOf(r);
        this.events.message(pos === 1 ? 'WINNER!' : `FINISHED  P${pos}`, 'big', 3);
        // hand the player's kart to an AI for the cool-down lap
        r.ai = new AIDriver({ skill: 0.7, aggression: 0, consistency: 1, reaction: 0 });
        this.rig.setMode('tv');
      }
      return;
    }
    if (r.isPlayer) {
      const lapNo = completed + 1;
      const tag = lapTime <= overallBest + 1e-6 ? 'purple' : wasBest ? 'good' : 'info';
      this.events.lapSplit?.(`Lap ${completed}  ${fmt(lapTime)}`, tag === 'info' ? 'good' : tag);
      if (lapNo === this.opts.laps) this.events.message('FINAL LAP', 'big', 2);
      else this.events.message(`LAP ${lapNo} / ${this.opts.laps}`, 'info', 1.6);
    }
  }

  private sectorCheck(r: Racer, lapDist: number) {
    const L = this.world.track.length;
    const idx = this.curSectors.length;
    if (idx >= 2) return;
    const boundary = ((idx + 1) * L) / 3;
    if (lapDist >= boundary) {
      const t = this.raceTime - r.lapStart;
      this.curSectors.push(t);
      const ref = this.bestSectors[idx];
      if (ref !== undefined) {
        const d = t - ref;
        this.events.lapSplit?.(`S${idx + 1}  ${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(3)}`, d < 0 ? 'good' : 'bad');
      }
    }
  }

  private updateMarkers(r: Racer) {
    const m = Math.floor(r.dist / 10);
    if (m <= r.lastMarker) return;
    // markers behind the line are only ever crossed by karts further back on the grid, so timing starts at the line
    for (let k = Math.max(0, r.lastMarker + 1); k <= m; k++) {
      if (!this.markerTimes.has(k)) this.markerTimes.set(k, this.raceTime);
    }
    r.lastMarker = m;
    if (m >= 0) r.gap = this.raceTime - (this.markerTimes.get(m) ?? this.raceTime);
  }

  positionOf(r: Racer) {
    return this.order().indexOf(r) + 1;
  }

  order() {
    return this.racers
      .filter((r) => !r.isGhost)
      .slice()
      .sort((a, b) => {
        if (a.finished && b.finished) return a.finishTime - b.finishTime;
        if (a.finished) return -1;
        if (b.finished) return 1;
        return b.dist - a.dist;
      });
  }

  standings(): Standing[] {
    const ord = this.order();
    return ord.map((r, i) => ({
      code: r.isPlayer ? 'YOU' : r.code,
      name: r.name,
      color: r.livery.accent,
      gap: i === 0 ? 0 : r.finished ? r.finishTime - ord[0].finishTime : r.gap,
      isPlayer: r.isPlayer,
      finished: r.finished,
      lap: Math.max(1, Math.min(this.opts.laps, r.lap + 1)),
    }));
  }

  private buildResults(): ResultRow[] {
    const ord = this.order();
    const leader = ord[0];
    const avgSpeed = leader.dist / Math.max(1, this.raceTime);
    const total = this.opts.laps * this.world.track.length;
    return ord.map((r, i) => {
      let time = r.finishTime;
      let est = false;
      if (!r.finished) {
        // estimate remaining time at the leader's average pace
        time = this.raceTime + (total - r.dist) / Math.max(5, avgSpeed * 0.98);
        est = true;
      }
      const gap = i === 0 ? fmt(time) : `+${(time - (leader.finished ? leader.finishTime : time)).toFixed(3)}`;
      return {
        pos: i + 1,
        name: r.isPlayer ? 'You' : r.name,
        code: r.code,
        color: r.livery.accent,
        time,
        bestLap: r.bestLap,
        isPlayer: r.isPlayer,
        gapText: est ? gap + '*' : gap,
      };
    });
  }

  // ------------------------------------------------------------- effects
  private fx(dt: number, input: Input) {
    for (const r of this.racers) {
      this.fxFor(r, dt, r.phys.rearSliding, r.phys.onGrass, r.phys.wheelLocked);
      const P = r.phys;
      if (P.impact > 1.2) {
        this.spark(P.impactX, P.y + 0.3, P.impactZ, P.impact);
        audio.impact(P.impact, P.impactX, P.y, P.impactZ);
        if (r === this.focus) {
          this.rig.addShake(Math.min(1.2, P.impact * 0.18));
          if (r.isPlayer) input.rumble(Math.min(1, P.impact * 0.12), 0.4, 180);
        }
      }
      P.impact = 0;
    }
    for (const c of this.contacts) {
      if (c.strength < 0.8) continue;
      this.spark(c.x, c.y, c.z, c.strength);
      audio.impact(c.strength * 0.8, c.x, c.y, c.z);
      const ra = this.racers[c.a];
      const rb = this.racers[c.b];
      if (ra === this.focus || rb === this.focus) {
        this.rig.addShake(Math.min(0.8, c.strength * 0.15));
        if (ra.isPlayer || rb.isPlayer) input.rumble(0.5, 0.3, 120);
      }
    }
  }

  private fxFor(r: Racer, dt: number, sliding: number, grass: number, locked: boolean) {
    const w = this.world;
    const speed = Math.abs(r.visual.speed);
    const wheels = r.rearWheels(this.wheelTmp);
    const acc = (this.fxAcc.get(r) ?? 0) + dt;
    this.fxAcc.set(r, acc);
    const smokeOn = (sliding > 0.35 || locked) && speed > 4 && grass < 0.5;
    if (smokeOn) {
      const intensity = clamp(sliding, 0.3, 1);
      for (let k = 0; k < 2; k++) {
        w.skids.add(`${r.id}:${k}`, wheels[k].x, wheels[k].y, wheels[k].z, r.renderHeading, 0.17, intensity);
      }
      if (acc > 0.035) {
        for (let k = 0; k < 2; k++) {
          w.smoke.emit(
            wheels[k].x,
            wheels[k].y + 0.12,
            wheels[k].z,
            r.phys.vx * 0.25 + (Math.random() - 0.5) * 1.2,
            0.5 + Math.random() * 0.6,
            r.phys.vz * 0.25 + (Math.random() - 0.5) * 1.2,
            { life: 1.4 + Math.random() * 1.2, size0: 0.5, size1: 2.6 + intensity * 1.5, color: 0xdedede, alpha: 0.28 * intensity, drag: 1.4, gravity: -0.15 },
          );
        }
        this.fxAcc.set(r, 0);
      }
    } else {
      w.skids.lift(`${r.id}:0`);
      w.skids.lift(`${r.id}:1`);
    }
    if (grass > 0.2 && speed > 3 && acc > 0.02) {
      for (let k = 0; k < 2; k++) {
        const col = Math.random() < 0.5 ? 0x6b5a3a : 0x4f7a32;
        w.dirt.emit(
          wheels[k].x,
          wheels[k].y + 0.05,
          wheels[k].z,
          -r.phys.vx * 0.15 + (Math.random() - 0.5) * 2,
          1.5 + Math.random() * 2.5,
          -r.phys.vz * 0.15 + (Math.random() - 0.5) * 2,
          { life: 0.6 + Math.random() * 0.5, size0: 0.14, size1: 0.1, color: col, alpha: 0.95, gravity: 9, drag: 0.6 },
        );
        w.smoke.emit(wheels[k].x, wheels[k].y + 0.1, wheels[k].z, (Math.random() - 0.5) * 0.8, 0.5, (Math.random() - 0.5) * 0.8, {
          life: 1.2,
          size0: 0.4,
          size1: 1.8,
          color: 0xb8a784,
          alpha: 0.22,
          drag: 1.5,
        });
      }
      this.fxAcc.set(r, 0);
    }
  }

  private spark(x: number, y: number, z: number, strength: number) {
    const n = Math.min(40, Math.floor(strength * 5));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 5;
      this.world.sparks.emit(x, y, z, Math.cos(a) * sp, 1 + Math.random() * 4, Math.sin(a) * sp, {
        life: 0.25 + Math.random() * 0.35,
        size0: 0.07,
        size1: 0.02,
        color: Math.random() < 0.5 ? 0xffb347 : 0xffe28a,
        alpha: 1,
        gravity: 9.8,
        drag: 0.8,
      });
    }
  }

  // ------------------------------------------------------------- ghost
  private updateGhost(dt: number) {
    const g = this.ghostRacer;
    if (!g || !this.ghost || !this.player) return;
    const t = this.raceTime - this.player.lapStart;
    const onLap = this.player.dist >= 0 && this.state === 'running';
    const s = onLap ? this.ghost.sample(t) : null;
    if (!s || s.done) {
      g.model.root.visible = false;
      this.lastDelta = NaN;
      return;
    }
    g.model.root.visible = true;
    g.applyVisual(s.x, s.y, s.z, s.heading, { steerAngle: s.steer, speed: s.speed, throttle: 0.5, brake: 0, latG: 0, longG: 0, pitch: 0, roll: 0, rpm: 4000 }, dt);
    const lapDist = this.player.dist - this.player.lap * this.world.track.length;
    const gt = this.ghost.timeAtDist(lapDist);
    this.lastDelta = isNaN(gt) ? NaN : t - gt;
  }

  // ------------------------------------------------------------- camera director
  private director(dt: number) {
    if (this.state === 'intro') {
      this.focus = this.player ?? this.racers[0];
      if (this.stateTime < 2.2) this.rig.setMode('heli');
      else this.rig.setMode('orbit');
      return;
    }
    if (this.mode !== 'attract') return;
    this.directorTime -= dt;
    if (this.directorTime <= 0) {
      this.directorTime = 6 + Math.random() * 5;
      const ord = this.order();
      this.focus = ord[Math.floor(Math.pow(Math.random(), 1.6) * ord.length)];
      const shots: RigMode[] = ['tv', 'tv', 'heli', 'chase', 'bumper', 'tv', 'far', 'cockpit'];
      this.rig.setMode(shots[Math.floor(Math.random() * shots.length)]);
      this.rig.cut();
    }
  }

  // ------------------------------------------------------------- audio
  private updateAudio() {
    if (!audio.ready) return;
    this.attachAudio();
    this.assignVoices();
    const cockpit = this.rig.mode === 'cockpit';
    for (const r of this.racers) {
      if (!r.voice) continue;
      const P = r.phys;
      const isFocus = r === this.focus;
      r.voice.set(P.rpm, P.throttle, P.limiterHit, isFocus ? 0.62 : 0.45, isFocus && cockpit ? 0.55 : 1);
      r.voice.position(r.renderPos.x, r.renderPos.y + 0.3, r.renderPos.z);
    }
    const f = this.focus.phys;
    audio.setDriving({ speed: f.speed, slide: f.rearSliding, kerb: f.onKerb, grass: f.onGrass, locked: f.wheelLocked });
    audio.setCrowd(this.excitement * (this.mode === 'attract' ? 0.5 : 1));
    audio.setListener(this.rig.camera);
  }

  // ------------------------------------------------------------- replay
  startReplay() {
    if (!this.recorder || this.recorder.frames.length < 10) return false;
    this.state = 'replay';
    this.replayTime = 0;
    this.replayPaused = false;
    this.replaySpeed = 1;
    this.replayAuto = true;
    this.replayShotTime = 0;
    this.focus = this.player ?? this.order()[0];
    this.world.clearFx();
    if (this.ghostRacer) this.ghostRacer.model.root.visible = false;
    return true;
  }

  cycleReplayFocus(dir: number) {
    const list = this.racers.filter((r) => !r.isGhost);
    const i = list.indexOf(this.focus);
    this.focus = list[(i + dir + list.length) % list.length];
    this.rig.cut();
  }

  setReplayCamera(mode: RigMode | 'auto') {
    if (mode === 'auto') {
      this.replayAuto = true;
      this.replayShotTime = 0;
    } else {
      this.replayAuto = false;
      this.rig.setMode(mode);
    }
  }

  private updateReplay(dt: number, input: Input) {
    const rec = this.recorder!;
    if (input.consume('replayToggle')) this.replayPaused = !this.replayPaused;
    if (input.consume('replayNext')) this.cycleReplayFocus(1);
    if (input.consume('replayPrev')) this.cycleReplayFocus(-1);
    const step = this.replayPaused ? 0 : dt * this.replaySpeed;
    this.replayTime += step;
    if (this.replayTime > rec.duration) this.replayTime = 0;
    for (let k = 0; k < this.racers.length; k++) {
      const r = this.racers[k];
      const s = rec.sample(k, this.replayTime, this.sample);
      r.applyVisual(s.x, s.y, s.z, s.heading, s.v, step);
      // keep phys in sync for cameras/audio
      r.phys.x = s.x;
      r.phys.z = s.z;
      r.phys.y = s.y;
      r.phys.heading = s.heading;
      r.phys.speed = s.v.speed;
      r.phys.rpm = s.v.rpm;
      r.phys.throttle = s.v.throttle;
      r.phys.latG = s.v.latG;
      r.phys.onGrass = s.grass;
      r.phys.onKerb = s.v.onKerb ?? 0;
      r.phys.rearSliding = s.sliding;
      r.phys.limiterHit = s.limiter;
      r.phys.vx = Math.sin(s.heading) * s.v.speed;
      r.phys.vz = Math.cos(s.heading) * s.v.speed;
      this.world.track.project(s.x, s.z, r.phys.proj.index, r.phys.proj);
      if (step > 0) this.fxFor(r, step, s.sliding, s.grass, false);
    }
    if (this.replayAuto) {
      this.replayShotTime -= dt;
      if (this.replayShotTime <= 0) {
        this.replayShotTime = 4 + Math.random() * 4;
        const shots: RigMode[] = ['tv', 'tv', 'tv', 'chase', 'heli', 'cockpit', 'bumper', 'far'];
        this.rig.setMode(shots[Math.floor(Math.random() * shots.length)]);
        this.rig.cut();
      }
    }
    this.rig.update(dt, this.focus);
    this.world.env.follow(this.focus.renderPos);
    if (this.replayPaused) {
      for (const r of this.racers) r.voice?.set(r.phys.rpm, 0, false, 0);
      audio.quietDriving();
    } else this.updateAudio();
  }

  // ------------------------------------------------------------- HUD data
  hud() {
    const p = this.player;
    const track = this.world.track;
    const lapNo = p ? clamp(p.lap + 1, 1, this.opts.laps) : 1;
    const running = this.state === 'running' || this.state === 'finished';
    let lapTime = 0;
    if (p && running) {
      if (this.mode === 'timetrial') lapTime = p.dist >= 0 ? this.raceTime - p.lapStart : 0;
      else lapTime = p.finished ? p.lapTimes[p.lapTimes.length - 1] ?? 0 : this.raceTime - p.lapStart;
    }
    return {
      lapNo,
      laps: this.opts.laps,
      position: p ? this.positionOf(p) : 1,
      count: this.racers.filter((r) => !r.isGhost).length,
      lapTime,
      lastLap: p?.lapTimes[p.lapTimes.length - 1] ?? NaN,
      bestLap: this.mode === 'timetrial' ? this.ghost?.time ?? NaN : p?.bestLap ?? NaN,
      raceTime: this.raceTime,
      speed: p ? Math.abs(p.phys.speed) : 0,
      rpm: p ? p.phys.rpm : 0,
      throttle: p?.phys.throttle ?? 0,
      brake: p?.phys.brake ?? 0,
      latG: p?.phys.latG ?? 0,
      longG: p?.phys.longG ?? 0,
      limiter: p?.phys.limiterHit ?? false,
      delta: this.lastDelta,
      lights: this.state === 'countdown' ? this.lights : 0,
      trackLength: track.length,
    };
  }

  dispose() {
    for (const r of this.racers) {
      this.world.scene.remove(r.model.root);
      r.dispose();
    }
    if (this.ghostRacer) {
      this.world.scene.remove(this.ghostRacer.model.root);
      this.ghostRacer.dispose();
    }
    this.racers = [];
    for (const v of this.voices) v.dispose();
    this.voices = [];
    audio.quietDriving();
  }
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

