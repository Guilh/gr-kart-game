import './styles.css';
import * as THREE from 'three';
import { Renderer } from './render/renderer';
import { Input } from './core/input';
import { settings } from './core/settings';
import { DEBUG } from './core/debug';
import { IS_TOUCH } from './core/tilt';
import { World } from './game/world';
import { Race, RaceOptions } from './game/race';
import { UI } from './ui/ui';
import { Showroom } from './ui/showroom';
import { audio } from './audio/audio';
import type { MapDot } from './ui/minimap';
import { RIG_LABELS, type RigMode } from './game/cameras';

// App shell: loading → attract-mode menu → race / time trial / showroom.

type Mode = 'loading' | 'menu' | 'race' | 'showroom';

class App {
  canvas = document.getElementById('game') as HTMLCanvasElement;
  renderer = new Renderer(this.canvas);
  input = new Input();
  world = new World();
  ui: UI;
  race: Race | null = null;
  showroom: Showroom | null = null;
  mode: Mode = 'loading';
  paused = false;
  hudVisible = true;
  lastMode: 'race' | 'timetrial' = 'race';
  private last = performance.now();
  private tiltTipShown = false;
  /** Earliest rAF timestamp the next frame may render at (frame cap). */
  private nextFrame = 0;
  private isTouch = IS_TOUCH;

  constructor() {
    this.ui = new UI(
      {
        race: () => this.startRace('race'),
        timeTrial: () => this.startRace('timetrial'),
        showroom: () => this.enterShowroom(),
        resume: () => this.setPaused(false),
        restart: () => this.startRace(this.lastMode),
        quit: () => this.toMenu(),
        replay: () => this.startReplay(),
        replayExit: () => this.exitReplay(),
        replayCam: (m) => this.race?.setReplayCamera(m as RigMode | 'auto'),
        replaySpeed: (v) => this.race && (this.race.replaySpeed = v),
        replaySeek: (t) => this.race?.recorder && (this.race.replayTime = t * this.race.recorder.duration),
        replayFocus: (d) => this.race?.cycleReplayFocus(d),
        replayPause: () => this.race && (this.race.replayPaused = !this.race.replayPaused),
        settingChanged: (k) => this.onSetting(k),
      },
      this.input,
    );
    const unlock = () => {
      audio.init().then(() => {
        audio.setVolume(settings.get('volume'));
        this.race?.attachAudio();
      });
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    this.renderer.onQualityChange = () => this.world.env?.setShadowQuality(this.renderer.shadowSize);
    // iPad Safari can't lock orientation, so turning the device like a wheel can flip the layout
    const rotated = () => {
      if (this.mode === 'race' && this.input.tilt.enabled) {
        this.ui.message('The screen rotated. Turn on Rotation Lock, then pause and resume to re-centre the steering.', 'info', 5);
      }
    };
    if (screen.orientation) screen.orientation.addEventListener('change', rotated);
    else window.addEventListener('orientationchange', rotated);
    document.addEventListener('visibilitychange', () => {
      audio.setBackground(document.hidden);
      if (!document.hidden) this.last = performance.now();
    });
  }

  async init() {
    const r = this.renderer;
    r.setQuality(settings.get('quality'));
    const progress = async (p: number, label: string) => {
      this.ui.setLoading(p, label);
      // yield so the progress bar can paint; rAF is throttled in hidden tabs, so race it with a timer
      await new Promise<void>((res) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            res();
          }
        };
        requestAnimationFrame(() => setTimeout(finish, 0));
        setTimeout(finish, 40);
      });
    };
    await progress(0.02, 'Loading typefaces');
    await Promise.all([
      document.fonts.load('900 italic 64px "Titillium Web"'),
      document.fonts.load('600 34px "Titillium Web"'),
      document.fonts.load('700 18px "Chakra Petch"'),
    ]).catch(() => {});
    await this.world.build(r.renderer, r.quality, r.shadowSize, settings.get('timeOfDay'), progress);
    await progress(0.86, 'Rolling out the GR KART');
    this.showroom = new Showroom(r.renderer, this.canvas);
    this.showroom.onDrive = () => {
      this.showroom?.exit();
      this.startRace('timetrial');
    };
    this.showroom.onExit = () => this.toMenu();
    this.ui.attachMinimap(this.world.track);
    this.startAttract();
    await progress(0.93, 'Compiling shaders');
    try {
      await r.renderer.compileAsync(this.world.scene, this.race!.rig.camera);
    } catch {
      /* optional */
    }
    await progress(1, 'Ready');
    this.mode = 'menu';
    this.ui.hideLoading();
    this.ui.showMenu(true);
    requestAnimationFrame(this.loop);
  }

  private params = new URLSearchParams(location.search);

  private raceOptions(): RaceOptions {
    const lapsParam = Number(this.params.get('laps'));
    return {
      autopilot: this.params.has('autopilot'),
      laps: lapsParam > 0 ? lapsParam : settings.get('laps'),
      opponents: settings.get('opponents'),
      difficulty: settings.get('difficulty'),
      catchup: settings.get('catchup'),
      assist: settings.get('steeringAssist'),
      camera: settings.get('camera'),
    };
  }

  private events() {
    return {
      message: (t: string, k?: 'big' | 'info' | 'good' | 'bad' | 'purple', s?: number) => this.ui.message(t, k, s),
      finished: (rows: Parameters<UI['showResults']>[0]) => this.ui.showResults(rows, 'race'),
      lapSplit: (t: string, k: 'good' | 'bad' | 'purple') => this.ui.split(t, k),
    };
  }

  startAttract() {
    this.race?.dispose();
    this.race = new Race(this.world, 'attract', { ...this.raceOptions(), laps: 99 }, this.events());
    this.race.attachAudio();
  }

  startRace(mode: 'race' | 'timetrial') {
    audio.init();
    this.lastMode = mode;
    this.showroom?.exit();
    this.race?.dispose();
    this.ui.showResults(null, 'race');
    this.ui.showReplay(false);
    this.ui.showPause(false);
    this.ui.clearMessages();
    this.ui.closeSheet();
    this.paused = false;
    audio.duck(false);
    this.race = new Race(this.world, mode, this.raceOptions(), this.events());
    this.race.attachAudio();
    this.mode = 'race';
    this.ui.showMenu(false);
    this.ui.showHud(true, mode);
    this.ui.enableTouch(this.isTouch);
    if (this.isTouch && settings.get('tiltSteer')) {
      // re-arm inside this tap: iOS only shows (or re-confirms) motion access from a user gesture
      this.input.tilt.enable().then((ok) => {
        if (!ok) {
          settings.set('tiltSteer', false);
          this.ui.message('Tilt steering needs motion access (see Settings). Using the steering pad.', 'bad', 4);
        } else if (!this.tiltTipShown) {
          this.tiltTipShown = true;
          this.ui.message('Tilt steering: hold the screen like a wheel while the lights count down', 'info', 4);
        }
        this.ui.refreshTouch();
      });
    }
    this.input.clearActions();
    this.canvas.focus();
  }

  toMenu() {
    this.ui.showResults(null, 'race');
    this.ui.showReplay(false);
    this.ui.showPause(false);
    this.ui.showHud(false);
    this.ui.enableTouch(false);
    this.ui.clearMessages();
    this.showroom?.exit();
    this.paused = false;
    audio.duck(false);
    this.startAttract();
    this.mode = 'menu';
    this.ui.showMenu(true);
    this.input.clearActions();
  }

  enterShowroom() {
    this.ui.showMenu(false);
    this.mode = 'showroom';
    audio.duck(true);
    audio.quietDriving();
    this.showroom!.enter();
    this.input.clearActions();
  }

  private startReplay() {
    if (!this.race?.startReplay()) return;
    this.ui.showResults(null, 'race');
    this.ui.showHud(false);
    this.ui.showReplay(true);
  }

  private exitReplay() {
    if (!this.race) return;
    this.ui.showReplay(false);
    this.race.state = 'finished';
    this.ui.showResults(this.race.results, 'race');
  }

  setPaused(p: boolean) {
    this.paused = p;
    // resuming re-centres tilt steering on however the device is held now
    if (!p && this.input.tilt.enabled) this.input.tilt.recenter();
    this.ui.showPause(p);
    audio.duck(p);
    if (p) audio.quietDriving();
    else this.ui.closeSheet();
  }

  onSetting(k: string) {
    if (k === 'quality') this.renderer.setQuality(settings.get('quality'));
    if (k === 'timeOfDay') this.world.setTimeOfDay(settings.get('timeOfDay'));
    if (k === 'tiltSteer' || k === 'autoGas') this.ui.refreshTouch();
    if (k === 'steeringAssist' && this.race?.player) this.race.player.phys.assist = settings.get('steeringAssist');
    if (k === 'camera' && this.race && this.mode === 'race') {
      const c = settings.get('camera') as RigMode;
      this.race.userCam = c;
      this.race.rig.setMode(c);
    }
  }

  /** Frames per second to render at: the user's cap, tightened by the quality preset, and 30 behind the menu. 0 = uncapped. */
  private frameCap() {
    let cap = settings.get('fpsCap');
    const limit = (v: number) => (cap = cap ? Math.min(cap, v) : v);
    if (this.renderer.presetFps) limit(this.renderer.presetFps);
    if (this.mode === 'menu') limit(30);
    return cap;
  }

  private loop = (now: number) => {
    requestAnimationFrame(this.loop);
    if (document.hidden) return;
    // rAF fires at the display rate (120 Hz on ProMotion); skip ticks until the cap interval is due.
    // Scheduling against nextFrame rather than the last frame keeps the average right on 144 Hz too.
    const cap = this.frameCap();
    this.renderer.targetFps = cap;
    if (cap) {
      const interval = 1000 / cap;
      if (now < this.nextFrame - 2) return;
      this.nextFrame = now - this.nextFrame > interval ? now + interval : this.nextFrame + interval;
    }
    const dt = Math.min(0.1, Math.max(0.0001, (now - this.last) / 1000));
    this.last = now;
    const input = this.input;
    input.update(dt);
    if (input.consume('mute')) this.ui.message(audio.toggleMute() ? 'Sound off' : 'Sound on', 'info', 1);
    this.ui.tickFps(dt);

    if (this.mode === 'showroom' && this.showroom) {
      if (input.consume('back')) this.toMenu();
      this.showroom.update(dt);
      this.renderer.setSpeedFx(0, 0.75);
      this.renderer.render(this.showroom.scene, this.showroom.camera, dt);
      input.clearActions();
      return;
    }

    const race = this.race;
    if (!race) return;

    if (this.mode === 'race') {
      if (race.state === 'replay') {
        if (input.consume('back')) this.exitReplay();
      } else if (input.consume('pause') && !this.ui.results) {
        this.setPaused(!this.paused);
      }
      if (input.consume('hud')) {
        this.hudVisible = !this.hudVisible;
        this.ui.setHudVisible(this.hudVisible);
      }
    }

    if (!this.paused) race.update(dt, input);
    const cam = race.rig.camera;
    this.world.update(this.paused ? 0 : dt, cam, race.excitement, window.innerHeight * this.renderer.resScale);

    if (this.mode === 'race') {
      if (race.state === 'replay') {
        const f = race.focus;
        this.ui.updateReplay(race.replayTime, race.recorder?.duration ?? 0, race.replayPaused, f.isPlayer ? 'You' : f.name, f.livery.accent);
      } else {
        const dots: MapDot[] = race.racers.map((r) => ({ x: r.renderPos.x, z: r.renderPos.z, heading: r.renderHeading, color: r.livery.accent, isPlayer: r.isPlayer }));
        if (race.ghostRacer?.model.root.visible) {
          const g = race.ghostRacer;
          dots.push({ x: g.renderPos.x, z: g.renderPos.z, heading: g.renderHeading, color: 0x7fd4ff, isPlayer: false, isGhost: true });
        }
        this.ui.updateHud(race.hud(), race.standings(), race.mode === 'timetrial' ? 'timetrial' : 'race', dots);
      }
      const tilt = this.input.tilt;
      if (tilt.enabled) {
        // "straight ahead" is however the player holds the device while the lights count down
        if (race.state === 'intro' || race.state === 'countdown') tilt.recenter();
        if (tilt.noSensor) {
          tilt.disable();
          settings.set('tiltSteer', false);
          this.ui.message('No motion sensor found. Using the steering pad.', 'info', 3);
          this.ui.refreshTouch();
        }
      }
      this.ui.updateTouch();
      const spd = Math.abs(race.focus.phys.speed);
      const cockpit = race.rig.mode === 'cockpit';
      this.renderer.setSpeedFx(race.state === 'replay' ? 0 : Math.max(0, (spd - 12) / 12) * (cockpit ? 0.6 : 1), 0.5);
    } else {
      // attract mode behind the menu
      const f = race.focus;
      this.ui.setLiveLabel(`Live · ${f.name} · ${RIG_LABELS[race.rig.mode]}`);
      this.renderer.setSpeedFx(0, 0.35);
      input.clearActions();
    }
    this.renderer.render(this.world.scene, cam, dt);
  };
}

const app = new App();
app.init().catch((e) => {
  console.error(e);
  const el = document.querySelector('#loading .label');
  if (el) el.textContent = 'Something went wrong: ' + (e?.message ?? e);
});
if (DEBUG) Object.assign(window as unknown as { app: App; THREE: typeof THREE }, { app, THREE });
