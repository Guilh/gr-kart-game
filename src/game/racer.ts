import * as THREE from 'three';
import type { DriveControls } from '../core/input';
import { lerp, lerpAngle } from '../core/math';
import { KartModel, KartLivery, KartVisualState } from '../kart/kartModel';
import { CG_OFFSET, KartPhysics } from '../kart/kartPhysics';
import { DIM } from '../kart/kartSpecs';
import type { Track } from '../track/track';
import type { AIDriver } from './ai';
import type { EngineVoice } from '../audio/audio';

// A competitor: physics body + visual model + (optional) AI brain + timing.

export class Racer {
  id: number;
  name: string;
  code: string;
  livery: KartLivery;
  isPlayer: boolean;
  isGhost = false;
  phys = new KartPhysics();
  model: KartModel;
  ai: AIDriver | null;
  controls: DriveControls = { steer: 0, throttle: 0, brake: 0 };
  voice: EngineVoice | null = null;

  // timing
  dist = 0; // continuous progress along the track (m), 0 = start line
  private lastS = 0;
  lapStart = 0;
  lapTimes: number[] = [];
  bestLap = Infinity;
  finished = false;
  finishTime = Infinity;
  position = 1;
  gap = NaN; // seconds behind the leader at the last 10 m marker; NaN until the first one past the line
  wrongWay = 0;
  stuckTime = 0;
  lastMarker = -1;
  sectorTimes: number[] = [];

  // visuals
  visual: KartVisualState = { steerAngle: 0, speed: 0, throttle: 0, brake: 0, latG: 0, longG: 0, pitch: 0, roll: 0, rpm: 0, onKerb: 0 };
  renderPos = new THREE.Vector3();
  renderHeading = 0;

  constructor(id: number, livery: KartLivery, isPlayer: boolean, ai: AIDriver | null, detail: 'race' | 'ghost' = 'race') {
    this.id = id;
    this.livery = livery;
    this.name = livery.name;
    this.code = livery.code;
    this.isPlayer = isPlayer;
    this.ai = ai;
    this.model = new KartModel(livery, detail, true);
    if (detail === 'ghost') this.isGhost = true;
  }

  get lap() {
    return Math.floor(this.dist / this.trackLength);
  }
  trackLength = 1;

  placeOnTrack(track: Track, s: number, lateral: number) {
    this.trackLength = track.length;
    const p = track.pointAt(s, lateral);
    const h = track.headingAt(s);
    // physics position is the CG, which sits CG_OFFSET behind the model origin
    this.phys.setPose(p.x - Math.sin(h) * CG_OFFSET, p.z - Math.cos(h) * CG_OFFSET, h, track);
    this.lastS = this.phys.proj.s;
    this.dist = track.deltaS(0, this.lastS);
    this.lastMarker = Math.floor(this.dist / 10);
    this.syncVisual(1, 0);
  }

  /** Called after each physics step: continuous progress + lap events. Returns completed lap index or -1. */
  trackProgress(track: Track): number {
    const s = this.phys.proj.s;
    const d = track.deltaS(this.lastS, s);
    this.lastS = s;
    const before = Math.floor(this.dist / track.length);
    this.dist += d;
    const after = Math.floor(this.dist / track.length);
    // wrong-way detection
    const rel = Math.abs(Math.atan2(Math.sin(this.phys.heading - track.headingAt(s)), Math.cos(this.phys.heading - track.headingAt(s))));
    if (rel > 1.9 && Math.abs(this.phys.speed) > 2) this.wrongWay += 1 / 240;
    else this.wrongWay = Math.max(0, this.wrongWay - 2 / 240);
    return after > before ? after : -1;
  }

  resetToTrack(track: Track) {
    const pr = this.phys.proj;
    const s = pr.s;
    const lat = Math.max(-pr.halfWidth + 1.5, Math.min(pr.halfWidth - 1.5, pr.lateral));
    const p = track.pointAt(s, lat);
    const h = track.headingAt(s);
    const keepDist = this.dist;
    this.phys.setPose(p.x, p.z, h, track);
    this.dist = keepDist;
    this.lastS = this.phys.proj.s;
    this.stuckTime = 0;
    this.wrongWay = 0;
  }

  /** Interpolates the physics state into the visual model. */
  syncVisual(alpha: number, dt: number) {
    const P = this.phys;
    const h = lerpAngle(P.prevHeading, P.heading, alpha);
    const x = lerp(P.prevX, P.x, alpha);
    const y = lerp(P.prevY, P.y, alpha);
    const z = lerp(P.prevZ, P.z, alpha);
    this.renderHeading = h;
    this.renderPos.set(x + Math.sin(h) * CG_OFFSET, y, z + Math.cos(h) * CG_OFFSET);
    this.model.root.position.copy(this.renderPos);
    this.model.root.rotation.y = h;
    const v = this.visual;
    v.steerAngle = P.steer;
    v.speed = P.speed;
    v.throttle = P.throttle;
    v.brake = P.brake;
    v.latG = P.latG;
    v.longG = P.longG;
    v.pitch = P.pitch;
    v.roll = P.roll;
    v.rpm = P.rpm;
    v.onKerb = P.onKerb;
    this.model.update(v, dt);
  }

  /** Applies a recorded replay/ghost state to the visual model. */
  applyVisual(x: number, y: number, z: number, h: number, v: KartVisualState, dt: number) {
    this.renderHeading = h;
    this.renderPos.set(x + Math.sin(h) * CG_OFFSET, y, z + Math.cos(h) * CG_OFFSET);
    this.model.root.position.copy(this.renderPos);
    this.model.root.rotation.y = h;
    Object.assign(this.visual, v);
    this.model.update(this.visual, dt);
  }

  /** World positions of the two rear contact patches. */
  rearWheels(out: [THREE.Vector3, THREE.Vector3]) {
    const h = this.renderHeading;
    const s = Math.sin(h);
    const c = Math.cos(h);
    const z = DIM.rearAxleZ;
    for (let k = 0; k < 2; k++) {
      const x = k === 0 ? DIM.rearTrackHalf : -DIM.rearTrackHalf;
      out[k].set(this.renderPos.x + z * s + x * c, this.renderPos.y, this.renderPos.z + z * c - x * s);
    }
    return out;
  }

  dispose() {
    this.model.dispose();
    this.voice = null; // borrowed from the race's voice pool, which disposes it
  }
}
