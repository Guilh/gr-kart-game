import * as THREE from 'three';
import { Track } from '../track/track';
import { SAKURA_CIRCUIT } from '../track/trackData';
import { computeRacingLine, RacingLine } from '../track/racingLine';
import { buildTrack, TrackVisuals } from '../track/trackBuilder';
import { buildScenery, Scenery } from '../track/scenery';
import { Environment } from '../render/environment';
import { Particles, SkidMarks } from '../render/particles';
import * as TX from '../render/textures';
import type { TimeOfDay } from '../core/settings';
import { DEBUG } from '../core/debug';

// The persistent 3D world: circuit, scenery, sky/lighting and shared FX.

export class World {
  scene = new THREE.Scene();
  track!: Track;
  line!: RacingLine;
  visuals!: TrackVisuals;
  scenery!: Scenery;
  env!: Environment;
  smoke!: Particles;
  sparks!: Particles;
  dirt!: Particles;
  skids!: SkidMarks;
  /** Tall structures (grandstand, pit building, tower, gantry, bridge) for camera checks. */
  obstacles: THREE.Box3[] = [];
  time = 0;

  timings: Record<string, number> = {};

  async build(renderer: THREE.WebGLRenderer, quality: 'low' | 'medium' | 'high', shadowSize: number, tod: TimeOfDay, progress0: (p: number, label: string) => Promise<void>) {
    let t0 = performance.now();
    let lastLabel = 'start';
    const progress = async (p: number, label: string) => {
      const now = performance.now();
      this.timings[lastLabel] = Math.round(now - t0);
      t0 = now;
      lastLabel = label;
      await progress0(p, label);
    };
    await progress(0.05, 'Sampling the Sakura circuit');
    this.track = new Track(SAKURA_CIRCUIT.name, SAKURA_CIRCUIT.points);
    await progress(0.12, 'Optimising the racing line');
    this.line = computeRacingLine(this.track);
    await progress(0.22, 'Paving asphalt, kerbs and terrain');
    this.visuals = buildTrack(this.track, this.line, quality);
    this.scene.add(this.visuals.group);
    await progress(0.5, 'Planting sakura and pines');
    this.scenery = buildScenery(this.track, this.visuals.terrainHeightAt, quality);
    this.scene.add(this.scenery.group);
    this.obstacles = tallBoxes(this.visuals.group, this.scenery.group);
    await progress(0.72, 'Lighting the sky over Mt. Fuji');
    this.env = new Environment(renderer, this.scene);
    this.env.setShadowQuality(shadowSize);
    this.env.apply(tod);
    await progress(0.8, 'Mixing tyre smoke');
    this.smoke = new Particles(quality === 'low' ? 600 : 1600, TX.smokePuff());
    this.dirt = new Particles(600, TX.softDot());
    this.sparks = new Particles(400, TX.softDot(), true);
    this.skids = new SkidMarks(quality === 'low' ? 1500 : 4000);
    this.scene.add(this.smoke.points, this.dirt.points, this.sparks.points, this.skids.mesh);
    await progress(0.84, 'Tuning 215 cc engines');
    if (DEBUG) console.info('[world] build timings (ms)', this.timings);
  }

  setTimeOfDay(tod: TimeOfDay) {
    this.env.apply(tod);
  }

  update(dt: number, camera: THREE.PerspectiveCamera, excitement: number, viewportH: number) {
    this.time += dt;
    this.scenery.update(this.time, excitement);
    this.env.update(this.time);
    this.smoke.update(dt, camera, viewportH, this.env.fog);
    this.dirt.update(dt, camera, viewportH, this.env.fog);
    this.sparks.update(dt, camera, viewportH);
    this.skids.update(dt);
  }

  clearFx() {
    this.smoke.clear();
    this.dirt.clear();
    this.sparks.clear();
    this.skids.clear();
  }
}

/** World boxes of the non-instanced meshes that rise above 5 m but aren't landscape-sized. */
function tallBoxes(...groups: THREE.Object3D[]) {
  const out: THREE.Box3[] = [];
  const size = new THREE.Vector3();
  for (const g of groups) {
    g.updateMatrixWorld(true);
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
      const b = new THREE.Box3().setFromObject(m);
      if (b.max.y > 5 && b.getSize(size).length() < 150) out.push(b);
    });
  }
  return out;
}
