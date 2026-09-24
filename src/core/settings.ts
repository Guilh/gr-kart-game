export type Quality = 'auto' | 'low' | 'medium' | 'high' | 'battery';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type TimeOfDay = 'morning' | 'noon' | 'afternoon' | 'golden';
export type CameraMode = 'chase' | 'far' | 'cockpit' | 'tv';

export interface Settings {
  quality: Quality;
  laps: number;
  opponents: number;
  difficulty: Difficulty;
  timeOfDay: TimeOfDay;
  units: 'kmh' | 'mph';
  volume: number;
  camera: CameraMode;
  steeringAssist: boolean;
  catchup: boolean;
  showFps: boolean;
  /** Frame-rate cap; 0 = uncapped (display refresh rate). */
  fpsCap: number;
  /** Touch devices: steer by rotating the device (needs motion-sensor permission on iOS). */
  tiltSteer: boolean;
  /** Touch devices: throttle is held automatically; the brake still works. */
  autoGas: boolean;
  playerName: string;
}

const DEFAULTS: Settings = {
  quality: 'auto',
  laps: 3,
  opponents: 7,
  difficulty: 'medium',
  timeOfDay: 'afternoon',
  units: 'kmh',
  volume: 0.8,
  camera: 'chase',
  steeringAssist: true,
  catchup: true,
  showFps: false,
  fpsCap: 60,
  tiltSteer: false,
  autoGas: false,
  playerName: 'YOU',
};

const KEY = 'grkart.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

type Listener = (s: Settings, changed: keyof Settings) => void;

class SettingsStore {
  data: Settings = load();
  private listeners: Listener[] = [];

  get<K extends keyof Settings>(k: K): Settings[K] {
    return this.data[k];
  }

  set<K extends keyof Settings>(k: K, v: Settings[K]) {
    if (this.data[k] === v) return;
    this.data[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(this.data, k);
  }

  onChange(l: Listener) {
    this.listeners.push(l);
  }
}

export const settings = new SettingsStore();

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
