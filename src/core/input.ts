import { clamp, moveTowards } from './math';
import { TiltSteer } from './tilt';

export interface DriveControls {
  steer: number; // -1 (left) .. +1 (right)
  throttle: number; // 0..1
  brake: number; // 0..1
}

export type Action =
  | 'pause'
  | 'camera'
  | 'reset'
  | 'hud'
  | 'mute'
  | 'confirm'
  | 'back'
  | 'replayPrev'
  | 'replayNext'
  | 'replayToggle';

const KEY_ACTIONS: Record<string, Action[]> = {
  Escape: ['pause', 'back'],
  KeyP: ['pause'],
  KeyC: ['camera'],
  KeyR: ['reset'],
  KeyH: ['hud'],
  KeyM: ['mute'],
  Enter: ['confirm'],
  Space: ['replayToggle'],
  BracketLeft: ['replayPrev'],
  BracketRight: ['replayNext'],
};

// Standard gamepad mapping
const PAD_ACTIONS: Record<number, Action[]> = {
  9: ['pause'], // start
  3: ['camera'], // Y
  8: ['reset'], // back/select
  0: ['confirm', 'replayToggle'], // A
  1: ['back'], // B
  4: ['replayPrev'], // LB
  5: ['replayNext'], // RB
};

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';

export class Input {
  private keys = new Set<string>();
  private actionQueue = new Set<Action>();
  private padPrev: boolean[] = [];
  lastDevice: InputDevice = 'keyboard';

  /** Final smoothed controls consumed by the player's kart. */
  controls: DriveControls = { steer: 0, throttle: 0, brake: 0 };
  lookBack = false;

  touch = { steer: 0, throttle: 0, brake: 0, active: false, autoGas: false };
  tilt = new TiltSteer();

  private kbSteer = 0;
  private kbThrottle = 0;
  private kbBrake = 0;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) {
        const acts = KEY_ACTIONS[e.code];
        if (acts) acts.forEach((a) => this.actionQueue.add(a));
      }
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private key(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  /** Returns true once per press. */
  consume(a: Action) {
    if (this.actionQueue.has(a)) {
      this.actionQueue.delete(a);
      return true;
    }
    return false;
  }

  clearActions() {
    this.actionQueue.clear();
  }

  pushAction(a: Action) {
    this.actionQueue.add(a);
  }

  update(dt: number) {
    // Keyboard: ramp inputs so digital keys behave like a thumb on a stick.
    const left = this.key('KeyA', 'ArrowLeft');
    const right = this.key('KeyD', 'ArrowRight');
    const targetSteer = (right ? 1 : 0) - (left ? 1 : 0);
    const returning = targetSteer === 0 || Math.sign(targetSteer) !== Math.sign(this.kbSteer);
    this.kbSteer = moveTowards(this.kbSteer, targetSteer, dt * (returning ? 7.5 : 4.2));
    this.kbThrottle = moveTowards(this.kbThrottle, this.key('KeyW', 'ArrowUp') ? 1 : 0, dt * 6);
    this.kbBrake = moveTowards(this.kbBrake, this.key('KeyS', 'ArrowDown') ? 1 : 0, dt * 5);

    let steer = this.kbSteer;
    let throttle = this.kbThrottle;
    let brake = this.kbBrake;
    this.lookBack = this.key('KeyB');

    // Gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const ax = pad.axes[0] ?? 0;
      const dead = 0.08;
      const sx = Math.abs(ax) < dead ? 0 : (ax - Math.sign(ax) * dead) / (1 - dead);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (Math.abs(sx) > 0.01 || rt > 0.02 || lt > 0.02) this.lastDevice = 'gamepad';
      if (this.lastDevice === 'gamepad') {
        // Slight non-linear curve for finer control near centre
        steer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.35);
        throttle = rt;
        brake = lt;
      }
      if (pad.buttons[2]?.pressed) this.lookBack = true;
      pad.buttons.forEach((b, i) => {
        const was = this.padPrev[i] ?? false;
        if (b.pressed && !was) {
          const acts = PAD_ACTIONS[i];
          if (acts) acts.forEach((a) => this.actionQueue.add(a));
          if (i === 14) this.actionQueue.add('replayPrev');
          if (i === 15) this.actionQueue.add('replayNext');
        }
        this.padPrev[i] = b.pressed;
      });
      break;
    }

    // Touch drives only while it's the last device used, so a keyboard or pad paired to a tablet still works.
    this.tilt.update(dt);
    if (this.touch.active && this.lastDevice === 'touch') {
      steer = this.tilt.enabled ? this.tilt.steer : this.touch.steer;
      throttle = this.touch.autoGas ? (this.touch.brake > 0 ? 0 : 1) : this.touch.throttle;
      brake = this.touch.brake;
    }

    this.controls.steer = clamp(steer, -1, 1);
    this.controls.throttle = clamp(throttle, 0, 1);
    this.controls.brake = clamp(brake, 0, 1);
  }

  rumble(strong: number, weak: number, ms: number) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      const act = (pad as Gamepad | null)?.vibrationActuator as
        | { playEffect?: (t: string, p: object) => Promise<unknown> }
        | undefined;
      act?.playEffect?.('dual-rumble', {
        duration: ms,
        strongMagnitude: clamp(strong, 0, 1),
        weakMagnitude: clamp(weak, 0, 1),
      })?.catch(() => {});
    }
  }
}
