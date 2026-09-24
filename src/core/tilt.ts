import { clamp, moveTowards } from './math';

/** Phones and tablets: coarse pointer or multi-touch (iPadOS reports a Mac user agent, so don't sniff it). */
export const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

const DEAD_DEG = 2.5; // ignore hand tremor around centre
const FULL_DEG = 28; // rotation for full lock
const MIN_G = 2.5; // m/s² of gravity in the screen plane; below this the device is too flat to read

/**
 * Tilt steering: hold the device like a wheel and rotate it in the screen plane.
 * The steering angle is the rotation of gravity within the device's x–y plane relative to a neutral pose
 * captured during the countdown. Being relative and in-plane, it reads the same in either landscape
 * direction or portrait, at any backward tilt, and whether the platform reports gravity or its reaction.
 */
export class TiltSteer {
  enabled = false;
  /** −1 (left) … 1 (right). */
  steer = 0;
  /** Enough gravity in the screen plane to steer (false when the device is held flat). */
  holding = true;
  private gx = 0;
  private gy = 0;
  private have = false;
  private neutral: number | null = null;
  private enabledAt = 0;
  private listening = false;

  static get supported() {
    return IS_TOUCH && typeof DeviceMotionEvent !== 'undefined';
  }

  /** Call from a user gesture: iOS shows its motion-access prompt here. Resolves false if declined. */
  async enable(): Promise<boolean> {
    const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> };
    if (DME.requestPermission) {
      try {
        if ((await DME.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    this.listen();
    if (!this.enabled) this.enabledAt = performance.now();
    this.enabled = true;
    this.neutral = null;
    return true;
  }

  disable() {
    this.enabled = false;
    this.steer = 0;
  }

  /** Take the current pose as straight ahead (on the next update). */
  recenter() {
    this.neutral = null;
  }

  /** Enabled, but no motion data has arrived: no accelerometer (e.g. a touch-screen laptop). */
  get noSensor() {
    return this.enabled && !this.have && performance.now() - this.enabledAt > 1500;
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null) return;
      // light low-pass (~40 ms at 60 Hz) against sensor noise
      const k = this.have ? 0.35 : 1;
      this.gx += (a.x - this.gx) * k;
      this.gy += (a.y - this.gy) * k;
      this.have = true;
    });
  }

  update(dt: number) {
    if (!this.enabled || !this.have) {
      this.steer = 0;
      return;
    }
    this.holding = Math.hypot(this.gx, this.gy) > MIN_G;
    if (!this.holding) {
      this.steer = moveTowards(this.steer, 0, dt * 4);
      return;
    }
    const ang = Math.atan2(this.gy, this.gx);
    if (this.neutral === null) this.neutral = ang;
    // turning the device clockwise (like a wheel to the right) turns gravity anticlockwise in device axes
    let d = ang - this.neutral;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const deg = Math.abs(d) * (180 / Math.PI);
    const v = clamp((deg - DEAD_DEG) / (FULL_DEG - DEAD_DEG), 0, 1);
    this.steer = Math.sign(d) * Math.pow(v, 1.2);
  }
}
