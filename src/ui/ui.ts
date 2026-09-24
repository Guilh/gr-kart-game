import { settings, Settings } from '../core/settings';
import { formatTime, clamp } from '../core/math';
import { GR_KART_SPEC } from '../kart/kartSpecs';
import type { ResultRow, Standing } from '../game/race';
import type { Input } from '../core/input';
import { Minimap, MapDot } from './minimap';
import type { Track } from '../track/track';
import { audio } from '../audio/audio';

// DOM overlay: loading, menus, HUD, results, replay controls, touch controls.

export interface UIHandlers {
  race(): void;
  timeTrial(): void;
  showroom(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  replay(): void;
  replayExit(): void;
  replayCam(mode: string): void;
  replaySpeed(v: number): void;
  replaySeek(t: number): void;
  replayFocus(dir: number): void;
  replayPause(): void;
  settingChanged(k: keyof Settings): void;
}

type HudData = {
  lapNo: number;
  laps: number;
  position: number;
  count: number;
  lapTime: number;
  lastLap: number;
  bestLap: number;
  speed: number;
  rpm: number;
  throttle: number;
  brake: number;
  latG: number;
  longG: number;
  limiter: boolean;
  delta: number;
  lights: number;
};

const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

const WORDMARK = `<div class="wordmark"><span class="gr"><span>GR</span></span><span>KART</span></div>`;

export class UI {
  root = document.getElementById('ui')!;
  loading: HTMLElement;
  menu: HTMLElement;
  hud: HTMLElement;
  sheet: HTMLElement | null = null;
  pause: HTMLElement | null = null;
  results: HTMLElement | null = null;
  replayBar: HTMLElement | null = null;
  touch: HTMLElement | null = null;
  private msgEl: HTMLElement;
  private msgTimer = 0;
  private splitsEl: HTMLElement;
  private minimap: Minimap | null = null;
  private els: Record<string, HTMLElement> = {};
  private gCanvas: HTMLCanvasElement;
  private gTrail: [number, number][] = [];
  private last: Record<string, string> = {};
  private menuIndex = 0;
  private fpsEl: HTMLElement;
  private frames = 0;
  private fpsTime = 0;

  constructor(private handlers: UIHandlers, private input: Input) {
    this.loading = h(`
      <div id="loading">
        <div class="inner">
          <div class="eyebrow" style="margin-bottom:16px">Fan-made tech demo · 2026 GR KART</div>
          ${WORDMARK}
          <div class="sub">Sakura Circuit · Racing Demo</div>
          <div class="bar"><i></i></div>
          <div class="status"><span class="label">Warming up</span><span class="pct num">0%</span></div>
          <div class="credit">Everything you are about to see — the kart, the driver, the circuit, Mt. Fuji,<br/>every texture and every sound — is generated in code at runtime. No assets.<br/>Built with Claude Opus 5.5 · Three.js</div>
        </div>
      </div>`);
    document.body.appendChild(this.loading);

    this.menu = this.buildMenu();
    this.menu.classList.add('hidden');
    this.root.appendChild(this.menu);

    this.hud = this.buildHud();
    this.hud.classList.add('hidden');
    this.root.appendChild(this.hud);
    this.msgEl = this.hud.querySelector('.msg')!;
    this.splitsEl = this.hud.querySelector('.splits')!;
    this.gCanvas = this.hud.querySelector('.gmeter canvas') as HTMLCanvasElement;
    this.fpsEl = h(`<div class="fps num hidden"></div>`);
    this.root.appendChild(this.fpsEl);
    window.addEventListener('keydown', (e) => this.menuKeys(e));
  }

  // ------------------------------------------------------------- loading
  setLoading(p: number, label: string) {
    (this.loading.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
    this.loading.querySelector('.label')!.textContent = label;
    this.loading.querySelector('.pct')!.textContent = `${Math.round(p * 100)}%`;
  }

  hideLoading() {
    this.loading.classList.add('fade');
    setTimeout(() => this.loading.remove(), 700);
  }

  // ---------------------------------------------------------------- menu
  private buildMenu() {
    const el = h(`
      <div id="menu">
        <div class="left">
          <div>
            <div class="eyebrow" style="margin-bottom:14px">New for 2026 · Entry-level racing kart</div>
            ${WORDMARK}
            <div class="stripes" style="margin:18px 0 16px"></div>
            <div class="tagline">A 215 cc four-stroke you can fit in a family minivan. Take it to the fictional Sakura Kart Circuit in the shadow of Mt. Fuji.</div>
          </div>
          <div class="menu-list">
            <button class="menu-item" data-act="race"><span class="n">01</span>Race<span class="d">Up to 8 karts, AI rivals</span></button>
            <button class="menu-item" data-act="tt"><span class="n">02</span>Time Trial<span class="d">Chase your ghost</span></button>
            <button class="menu-item" data-act="showroom"><span class="n">03</span>Showroom<span class="d">Explore the GR KART</span></button>
            <button class="menu-item" data-act="settings"><span class="n">04</span>Settings<span class="d">Graphics, audio, assists</span></button>
            <button class="menu-item" data-act="controls"><span class="n">05</span>How to drive<span class="d">Keyboard, gamepad, touch</span></button>
          </div>
        </div>
        <div class="foot">
          <div class="spec-ticker">
            <div>Engine<b>${GR_KART_SPEC.displacementCc} cc</b></div>
            <div>Weight<b>${GR_KART_SPEC.weightKg} kg</b></div>
            <div>Length<b>${GR_KART_SPEC.lengthMm.toLocaleString()} mm</b></div>
            <div>Wheelbase<b>${GR_KART_SPEC.wheelbaseMm.toLocaleString()} mm</b></div>
            <div>Price<b>¥${GR_KART_SPEC.priceYen.toLocaleString()}</b></div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
            <span class="live-tag"><span class="live-label">Live · AI exhibition race</span></span>
            <span>Fan-made tech demo · not affiliated with Toyota · built with Claude Opus 5.5</span>
          </div>
        </div>
      </div>`);
    el.querySelectorAll<HTMLButtonElement>('.menu-item').forEach((b, i) => {
      b.addEventListener('mouseenter', () => this.selectMenu(i));
      b.addEventListener('click', () => this.menuAction(b.dataset.act!));
    });
    return el;
  }

  private selectMenu(i: number) {
    const items = this.menu.querySelectorAll<HTMLElement>('.menu-item');
    this.menuIndex = (i + items.length) % items.length;
    items.forEach((it, k) => it.classList.toggle('sel', k === this.menuIndex));
  }

  private menuKeys(e: KeyboardEvent) {
    if (this.menu.classList.contains('hidden') || this.sheet) return;
    const items = this.menu.querySelectorAll<HTMLButtonElement>('.menu-item');
    if (e.code === 'ArrowDown' || e.code === 'KeyS') this.selectMenu(this.menuIndex + 1);
    else if (e.code === 'ArrowUp' || e.code === 'KeyW') this.selectMenu(this.menuIndex - 1);
    else if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      this.menuAction(items[this.menuIndex].dataset.act!);
    }
  }

  private menuAction(act: string) {
    audio.init();
    audio.click();
    if (act === 'race') this.showRaceSetup();
    else if (act === 'tt') this.handlers.timeTrial();
    else if (act === 'showroom') this.handlers.showroom();
    else if (act === 'settings') this.showSettings();
    else if (act === 'controls') this.showControls();
  }

  showMenu(on: boolean) {
    this.menu.classList.toggle('hidden', !on);
    if (on) this.selectMenu(this.menuIndex);
    if (!on) this.closeSheet();
  }

  setLiveLabel(text: string) {
    const el = this.menu.querySelector('.live-label');
    if (el && el.textContent !== text) el.textContent = text;
  }

  // -------------------------------------------------------------- sheets
  closeSheet() {
    this.sheet?.remove();
    this.sheet = null;
  }

  private openSheet(el: HTMLElement) {
    this.closeSheet();
    this.sheet = el;
    this.root.appendChild(el);
    el.querySelector<HTMLElement>('.btn.primary, button')?.focus();
  }

  private seg<K extends keyof Settings>(key: K, options: [Settings[K], string][]) {
    const wrap = h(`<div class="seg"></div>`);
    for (const [v, label] of options) {
      const b = h(`<button>${label}</button>`) as HTMLButtonElement;
      b.classList.toggle('on', settings.get(key) === v);
      b.onclick = () => {
        settings.set(key, v);
        wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        audio.click();
        this.handlers.settingChanged(key);
      };
      wrap.appendChild(b);
    }
    return wrap;
  }

  private stepper(key: 'laps' | 'opponents', min: number, max: number) {
    const wrap = h(`<div class="stepper"><button aria-label="less">−</button><span class="num"></span><button aria-label="more">+</button></div>`);
    const span = wrap.querySelector('span')!;
    const upd = () => (span.textContent = String(settings.get(key)));
    upd();
    const [dec, inc] = wrap.querySelectorAll('button');
    dec.addEventListener('click', () => {
      settings.set(key, clamp(settings.get(key) - 1, min, max));
      upd();
      audio.click();
    });
    inc.addEventListener('click', () => {
      settings.set(key, clamp(settings.get(key) + 1, min, max));
      upd();
      audio.click();
    });
    return wrap;
  }

  private toggle(key: 'steeringAssist' | 'catchup' | 'showFps') {
    const b = h(`<button class="toggle" role="switch"></button>`) as HTMLButtonElement;
    const upd = () => {
      b.classList.toggle('on', !!settings.get(key));
      b.setAttribute('aria-checked', String(!!settings.get(key)));
    };
    upd();
    b.onclick = () => {
      settings.set(key, !settings.get(key));
      upd();
      audio.click();
      this.handlers.settingChanged(key);
    };
    return b;
  }

  private row(label: string, hint: string, control: HTMLElement) {
    const r = h(`<div class="row"><label>${label}${hint ? `<span class="hint">${hint}</span>` : ''}</label></div>`);
    r.appendChild(control);
    return r;
  }

  showRaceSetup() {
    const el = h(`<div class="panel sheet"><div class="eyebrow">Race setup</div><h2>Sakura Kart Circuit</h2><p class="lead">A flowing 860 m layout: a fast main straight, climbing esses, a crest under the bridge and a tight hairpin.</p></div>`);
    el.appendChild(this.row('Laps', '', this.stepper('laps', 1, 10)));
    el.appendChild(this.row('Opponents', 'AI rivals on the grid', this.stepper('opponents', 0, 7)));
    el.appendChild(
      this.row(
        'Difficulty',
        '',
        this.seg('difficulty', [
          ['easy', 'Easy'],
          ['medium', 'Medium'],
          ['hard', 'Hard'],
        ]),
      ),
    );
    el.appendChild(
      this.row(
        'Time of day',
        '',
        this.seg('timeOfDay', [
          ['morning', 'Morning'],
          ['noon', 'Noon'],
          ['afternoon', 'Afternoon'],
          ['golden', 'Golden hour'],
        ]),
      ),
    );
    el.appendChild(this.row('Steering assist', 'Speed-sensitive steering, counter-steer help, anti-lock brake cap', this.toggle('steeringAssist')));
    el.appendChild(this.row('Catch-up', 'Keeps the pack close', this.toggle('catchup')));
    const actions = h(`<div class="actions"><button class="btn primary"><span>Start race</span></button><button class="btn ghost"><span>Back</span></button></div>`);
    const [go, back] = actions.querySelectorAll('button');
    go.addEventListener('click', () => {
      audio.click();
      this.closeSheet();
      this.handlers.race();
    });
    back.addEventListener('click', () => {
      audio.click();
      this.closeSheet();
    });
    el.appendChild(actions);
    this.openSheet(el);
  }

  showSettings(inGame = false) {
    const el = h(`<div class="panel sheet"><div class="eyebrow">Settings</div><h2>Settings</h2><p class="lead">Changes save automatically.</p></div>`);
    el.appendChild(
      this.row(
        'Graphics',
        'Auto adapts resolution to hold the frame rate. Battery saver keeps laptops cool.',
        this.seg('quality', [
          ['auto', 'Auto'],
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
          ['battery', 'Battery saver'],
        ]),
      ),
    );
    el.appendChild(
      this.row(
        'Frame rate cap',
        'Lower runs cooler and quieter',
        this.seg('fpsCap', [
          [30, '30'],
          [60, '60'],
          [0, 'Off'],
        ]),
      ),
    );
    el.appendChild(
      this.row(
        'Default camera',
        'Press C in race to cycle',
        this.seg('camera', [
          ['chase', 'Chase'],
          ['far', 'Far'],
          ['cockpit', 'Helmet'],
          ['tv', 'TV'],
        ]),
      ),
    );
    el.appendChild(
      this.row(
        'Time of day',
        '',
        this.seg('timeOfDay', [
          ['morning', 'Morning'],
          ['noon', 'Noon'],
          ['afternoon', 'Afternoon'],
          ['golden', 'Golden'],
        ]),
      ),
    );
    el.appendChild(
      this.row(
        'Speed units',
        '',
        this.seg('units', [
          ['kmh', 'km/h'],
          ['mph', 'mph'],
        ]),
      ),
    );
    const vol = h(`<input type="range" min="0" max="1" step="0.05" aria-label="Volume" />`) as HTMLInputElement;
    vol.value = String(settings.get('volume'));
    vol.oninput = () => {
      settings.set('volume', Number(vol.value));
      audio.setVolume(Number(vol.value));
    };
    el.appendChild(this.row('Volume', '', vol));
    el.appendChild(this.row('Steering assist', '', this.toggle('steeringAssist')));
    el.appendChild(this.row('Show FPS', '', this.toggle('showFps')));
    const actions = h(`<div class="actions"><button class="btn primary"><span>Done</span></button></div>`);
    actions.querySelector('button')!.addEventListener('click', () => {
      audio.click();
      this.closeSheet();
      if (inGame) this.showPause(true);
    });
    el.appendChild(actions);
    this.openSheet(el);
  }

  showControls() {
    const el = h(`
      <div class="panel sheet">
        <div class="eyebrow">How to drive</div>
        <h2>Controls</h2>
        <p class="lead">Karts brake with the rear axle only. Brake in a straight line, turn in, and feed the throttle in smoothly. Stamp on the brakes mid-corner and the rear will step out.</p>
        <div class="keys">
          <span><kbd>W</kbd><kbd>↑</kbd></span><span>Throttle</span>
          <span><kbd>S</kbd><kbd>↓</kbd></span><span>Brake · hold when stopped to push backwards</span>
          <span><kbd>A</kbd><kbd>D</kbd></span><span>Steer</span>
          <span><kbd>C</kbd></span><span>Cycle camera: chase, far, helmet, bumper, TV</span>
          <span><kbd>B</kbd></span><span>Look behind</span>
          <span><kbd>R</kbd></span><span>Marshal reset to the track</span>
          <span><kbd>Esc</kbd><kbd>P</kbd></span><span>Pause</span>
          <span><kbd>M</kbd></span><span>Mute</span>
          <span><kbd>H</kbd></span><span>Hide the HUD (photo mode)</span>
          <span><kbd>Space</kbd><kbd>[</kbd><kbd>]</kbd></span><span>Replay: pause, previous or next kart</span>
        </div>
        <p class="lead" style="margin-top:18px">Gamepad: RT throttle · LT brake · left stick steer · Y camera · X look back · Start pause. On touch screens, controls appear on screen.</p>
        <div class="actions"><button class="btn primary"><span>Got it</span></button></div>
      </div>`);
    el.querySelector('button')!.addEventListener('click', () => {
      audio.click();
      this.closeSheet();
    });
    this.openSheet(el);
  }

  // ------------------------------------------------------------------ HUD
  private buildHud() {
    const el = h(`
      <div id="hud">
        <div class="tower"><div class="head"><span>LAP</span><span class="num lapc">1/3</span></div><ol></ol></div>
        <div class="timing">
          <div class="blk lap"><div class="eyebrow">Lap</div><b class="lapn">1/3</b></div>
          <div class="blk cur"><div class="eyebrow">Time</div><b class="curt num">0:00.000</b></div>
          <div class="blk small"><div class="eyebrow">Last</div><b class="lastt num">--:--.---</b></div>
          <div class="blk small"><div class="eyebrow">Best</div><b class="bestt num">--:--.---</b></div>
        </div>
        <div class="delta hidden num"></div>
        <div class="splits"></div>
        <div class="posbox">
          <div class="pos"><span><span class="posn">1</span><sub class="posc">/8</sub></span></div>
          <div class="ctrl">
            <button class="iconbtn pausebtn" aria-label="Pause"><svg viewBox="0 0 24 24"><rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/></svg></button>
            <button class="iconbtn cambtn" aria-label="Camera"><svg viewBox="0 0 24 24"><path d="M4 7h3l2-2h6l2 2h3v12H4z M12 9a4 4 0 100 8 4 4 0 000-8z"/></svg></button>
          </div>
        </div>
        <div class="lights hidden"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="msg"></div>
        <div class="minimap"></div>
        <div class="gmeter"><canvas width="180" height="180" style="width:90px;height:90px"></canvas></div>
        <div class="pedals"><div class="brk"><i></i></div><div class="thr"><i></i></div></div>
        <div class="dash">
          ${this.tachSvg()}
          <div class="speed">0</div>
          <div class="unit">KM/H</div>
          <div class="rpm">1750 RPM</div>
        </div>
      </div>`);
    const q = (s: string) => el.querySelector(s) as HTMLElement;
    this.els = {
      tower: q('.tower'),
      towerList: q('.tower ol'),
      lapc: q('.lapc'),
      lapn: q('.lapn'),
      curt: q('.curt'),
      lastt: q('.lastt'),
      bestt: q('.bestt'),
      delta: q('.delta'),
      posn: q('.posn'),
      posc: q('.posc'),
      posbox: q('.posbox .pos'),
      lights: q('.lights'),
      speed: q('.dash .speed'),
      unit: q('.dash .unit'),
      rpm: q('.dash .rpm'),
      rpmArc: q('.dash .rpmarc'),
      minimap: q('.minimap'),
      thr: q('.pedals .thr i'),
      brk: q('.pedals .brk i'),
    };
    q('.pausebtn').addEventListener('click', () => this.input.pushAction('pause'));
    q('.cambtn').addEventListener('click', () => this.input.pushAction('camera'));
    return el;
  }

  private tachSvg() {
    // 270° gauge, 0..7000 rpm
    const cx = 125;
    const cy = 96;
    const r = 84;
    const a0 = (225 * Math.PI) / 180;
    const sweep = (270 * Math.PI) / 180;
    const pt = (a: number, rr = r) => `${cx + Math.cos(a) * rr},${cy - Math.sin(a) * rr}`;
    const arc = (from: number, to: number, rr = r) => {
      const A = a0 - from * sweep;
      const B = a0 - to * sweep;
      const large = (to - from) * 270 > 180 ? 1 : 0;
      return `M${pt(A, rr)} A${rr},${rr} 0 ${large} 1 ${pt(B, rr)}`;
    };
    let ticks = '';
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
      const A = a0 - t * sweep;
      ticks += `<line x1="${pt(A, r - 12).split(',')[0]}" y1="${pt(A, r - 12).split(',')[1]}" x2="${pt(A, r - 4).split(',')[0]}" y2="${pt(A, r - 4).split(',')[1]}" stroke="${i >= 6 ? '#e0001b' : 'rgba(245,244,240,0.7)'}" stroke-width="2"/>`;
      const [lx, ly] = pt(A, r - 22).split(',');
      ticks += `<text x="${lx}" y="${Number(ly) + 4}" fill="${i >= 6 ? '#e0001b' : 'rgba(245,244,240,0.6)'}" font-size="11" font-family="Chakra Petch" text-anchor="middle">${i}</text>`;
    }
    const len = r * sweep;
    return `<svg viewBox="0 0 250 172">
      <path d="${arc(0, 1)}" stroke="rgba(11,11,13,0.55)" stroke-width="14" fill="none"/>
      <path d="${arc(5.8 / 7, 1)}" stroke="rgba(224,0,27,0.45)" stroke-width="14" fill="none"/>
      <path class="rpmarc" d="${arc(0, 1)}" stroke="#f5f4f0" stroke-width="8" fill="none" stroke-dasharray="${len}" stroke-dashoffset="${len}" style="transition:stroke 0.1s"/>
      ${ticks}
    </svg>`;
  }

  attachMinimap(track: Track) {
    this.minimap = new Minimap(track);
    const box = this.els.minimap;
    box.innerHTML = '';
    box.appendChild(this.minimap.canvas);
    const size = box.clientWidth || 200;
    this.minimap.resize(size);
    window.addEventListener('resize', () => this.minimap?.resize(box.clientWidth || 200));
  }

  showHud(on: boolean, mode: 'race' | 'timetrial' = 'race') {
    this.hud.classList.toggle('hidden', !on);
    this.els.tower.classList.toggle('hidden', mode !== 'race');
    this.els.posbox.parentElement!.querySelector('.pos')!.classList.toggle('hidden', mode !== 'race');
    this.last = {};
    if (on && this.minimap) this.minimap.resize(this.els.minimap.clientWidth || 200);
  }

  setHudVisible(v: boolean) {
    this.hud.style.opacity = v ? '1' : '0';
  }

  private set(key: string, el: HTMLElement, text: string) {
    if (this.last[key] === text) return;
    this.last[key] = text;
    el.textContent = text;
  }

  updateHud(d: HudData, standings: Standing[], mode: 'race' | 'timetrial', dots: MapDot[]) {
    const e = this.els;
    const units = settings.get('units');
    const spd = units === 'mph' ? d.speed * 2.23694 : d.speed * 3.6;
    this.set('speed', e.speed, String(Math.round(spd)));
    this.set('unit', e.unit, units === 'mph' ? 'MPH' : 'KM/H');
    this.set('rpm', e.rpm, `${Math.round(d.rpm / 50) * 50} RPM`);
    e.rpm.classList.toggle('lim', d.limiter || d.rpm > 5900);
    const frac = clamp(d.rpm / 7000, 0, 1);
    const len = Number(e.rpmArc.getAttribute('stroke-dasharray'));
    e.rpmArc.setAttribute('stroke-dashoffset', String(len * (1 - frac)));
    e.rpmArc.setAttribute('stroke', d.rpm > 5800 ? '#e0001b' : '#f5f4f0');
    e.thr.style.height = `${d.throttle * 100}%`;
    e.brk.style.height = `${d.brake * 100}%`;
    this.set('lapn', e.lapn, mode === 'race' ? `${d.lapNo}/${d.laps}` : `${Math.max(1, d.lapNo)}`);
    this.set('lapc', e.lapc, `${d.lapNo}/${d.laps}`);
    this.set('curt', e.curt, formatTime(d.lapTime));
    this.set('lastt', e.lastt, formatTime(d.lastLap));
    this.set('bestt', e.bestt, formatTime(d.bestLap));
    this.set('posn', e.posn, String(d.position));
    this.set('posc', e.posc, `/${d.count}`);
    // delta
    if (mode === 'timetrial' && isFinite(d.delta)) {
      e.delta.classList.remove('hidden');
      e.delta.classList.toggle('good', d.delta < 0);
      e.delta.classList.toggle('bad', d.delta >= 0);
      this.set('delta', e.delta, `${d.delta < 0 ? '−' : '+'}${Math.abs(d.delta).toFixed(2)}`);
    } else e.delta.classList.add('hidden');
    // lights
    e.lights.classList.toggle('hidden', d.lights === 0);
    e.lights.querySelectorAll('i').forEach((l, i) => l.classList.toggle('on', i < d.lights));
    // tower
    if (mode === 'race') {
      const key = standings.map((s) => s.code + (Number.isNaN(s.gap) ? '—' : Math.max(0, s.gap).toFixed(1))).join('|');
      if (key !== this.last.tower) {
        this.last.tower = key;
        e.towerList.innerHTML = standings
          .map(
            (s, i) =>
              `<li class="${s.isPlayer ? 'me' : ''}"><span class="p">${i + 1}</span><span class="c" style="background:${hex(s.color)}"></span><span class="n">${s.code}</span><span class="g">${
                i === 0 ? (s.finished ? 'FIN' : 'LEADER') : s.finished ? '+' + s.gap.toFixed(1) : Number.isNaN(s.gap) ? '—' : '+' + Math.max(0, s.gap).toFixed(1)
              }</span></li>`,
          )
          .join('');
      }
    }
    this.minimap?.draw(dots);
    this.drawG(d.latG, d.longG);
  }

  private drawG(lat: number, lon: number) {
    const c = this.gCanvas;
    const ctx = c.getContext('2d')!;
    const W = c.width;
    const cx = W / 2;
    const R = W / 2 - 6;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(11,11,13,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cx, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(245,244,240,0.18)';
    ctx.lineWidth = 2;
    for (const g of [0.5, 1, 1.5]) {
      ctx.beginPath();
      ctx.arc(cx, cx, (R * g) / 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cx);
    ctx.lineTo(cx + R, cx);
    ctx.moveTo(cx, cx - R);
    ctx.lineTo(cx, cx + R);
    ctx.stroke();
    // left turn (lat > 0) pushes the dot to the right like the driver feels it
    const x = cx - (clamp(lat, -1.6, 1.6) / 1.6) * R;
    const y = cx + (clamp(lon, -1.6, 1.6) / 1.6) * R;
    this.gTrail.push([x, y]);
    if (this.gTrail.length > 24) this.gTrail.shift();
    this.gTrail.forEach(([tx, ty], i) => {
      ctx.fillStyle = `rgba(224,0,27,${(i / this.gTrail.length) * 0.4})`;
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(245,244,240,0.6)';
    ctx.font = '600 18px Chakra Petch';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.hypot(lat, lon).toFixed(1)}G`, cx, W - 14);
  }

  message(text: string, kind: 'big' | 'info' | 'good' | 'bad' | 'purple' = 'info', seconds = 1.5) {
    const cur = this.msgEl.firstElementChild as HTMLElement | null;
    if (cur && cur.textContent === text && cur.className === kind) {
      clearTimeout(this.msgTimer);
    } else {
      this.msgEl.innerHTML = '';
      const el = document.createElement('div');
      el.className = kind;
      el.textContent = text;
      this.msgEl.appendChild(el);
    }
    clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => (this.msgEl.innerHTML = ''), seconds * 1000);
  }

  split(text: string, kind: 'good' | 'bad' | 'purple') {
    const el = document.createElement('div');
    el.className = kind;
    el.textContent = text;
    this.splitsEl.appendChild(el);
    setTimeout(() => el.remove(), 3500);
    while (this.splitsEl.children.length > 3) this.splitsEl.firstElementChild?.remove();
  }

  clearMessages() {
    this.msgEl.innerHTML = '';
    this.splitsEl.innerHTML = '';
  }

  // ---------------------------------------------------------------- pause
  showPause(on: boolean) {
    this.pause?.remove();
    this.pause = null;
    if (!on) return;
    const el = h(`
      <div class="panel sheet" style="width:min(380px,calc(100vw - 32px))">
        <div class="eyebrow">Paused</div>
        <h2>Pit wall</h2>
        <div class="actions" style="flex-direction:column;align-items:stretch">
          <button class="btn primary" data-a="resume"><span>Resume</span></button>
          <button class="btn" data-a="restart"><span>Restart</span></button>
          <button class="btn" data-a="settings"><span>Settings</span></button>
          <button class="btn ghost" data-a="quit"><span>Quit to menu</span></button>
        </div>
      </div>`);
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        audio.click();
        const a = b.dataset.a;
        if (a === 'resume') this.handlers.resume();
        else if (a === 'restart') this.handlers.restart();
        else if (a === 'quit') this.handlers.quit();
        else if (a === 'settings') {
          this.showPause(false);
          this.showSettings(true);
        }
      }),
    );
    this.pause = el;
    this.root.appendChild(el);
    (el.querySelector('.btn.primary') as HTMLElement).focus();
  }

  // -------------------------------------------------------------- results
  showResults(rows: ResultRow[] | null, mode: 'race' | 'timetrial', ttBest?: number, ttLaps?: number[]) {
    this.results?.remove();
    this.results = null;
    this.hud.classList.remove('results-open');
    if (!rows && mode === 'race') return;
    const el = h(`<div class="panel sheet results"></div>`);
    if (mode === 'race' && rows) {
      const me = rows.find((r) => r.isPlayer);
      el.innerHTML = `
        <div class="eyebrow">Race result · Sakura Kart Circuit</div>
        <h2>${me ? (me.pos === 1 ? 'Victory!' : `You finished P${me.pos}`) : 'Race complete'}</h2>
        <div class="podium">Best lap ${me ? formatTime(me.bestLap) : '--'} · * = projected finish</div>
        <table>${rows
          .map(
            (r) =>
              `<tr class="${r.isPlayer ? 'me' : ''}"><td class="p">${r.pos}</td><td class="c"><i style="background:${hex(r.color)}"></i></td><td>${r.name}</td><td class="t">${r.gapText}</td><td class="b">${formatTime(r.bestLap)}</td></tr>`,
          )
          .join('')}</table>`;
    } else {
      el.innerHTML = `
        <div class="eyebrow">Time trial</div>
        <h2>Session summary</h2>
        <div class="podium">Personal best ${formatTime(ttBest ?? NaN)}</div>
        <table>${(ttLaps ?? []).map((t, i) => `<tr><td class="p">${i + 1}</td><td>Lap ${i + 1}</td><td class="t">${formatTime(t)}</td></tr>`).join('')}</table>`;
    }
    const actions = h(`<div class="actions"></div>`);
    const mk = (label: string, cls: string, fn: () => void) => {
      const b = h(`<button class="btn ${cls}"><span>${label}</span></button>`);
      b.addEventListener('click', () => {
        audio.click();
        fn();
      });
      actions.appendChild(b);
    };
    if (mode === 'race') mk('Watch replay', 'primary', () => this.handlers.replay());
    mk(mode === 'race' ? 'Race again' : 'Keep driving', mode === 'race' ? '' : 'primary', () => this.handlers.restart());
    mk('Main menu', 'ghost', () => this.handlers.quit());
    el.appendChild(actions);
    this.results = el;
    this.hud.classList.add('results-open');
    this.root.appendChild(el);
    (actions.querySelector('button') as HTMLElement).focus();
  }

  // --------------------------------------------------------------- replay
  showReplay(on: boolean) {
    this.replayBar?.remove();
    this.replayBar = null;
    this.root.querySelector('.replay-badge')?.remove();
    if (!on) return;
    const badge = h(`<div class="replay-badge">REPLAY</div>`);
    this.root.appendChild(badge);
    const el = h(`
      <div class="panel replaybar">
        <div class="top">
          <span class="who"><i></i><span class="wn"></span></span>
          <span style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="chip on" data-cam="auto">Director</button>
            <button class="chip" data-cam="tv">TV</button>
            <button class="chip" data-cam="chase">Chase</button>
            <button class="chip" data-cam="cockpit">Helmet</button>
            <button class="chip" data-cam="heli">Heli</button>
          </span>
          <span style="display:flex;gap:4px">
            <button class="chip" data-sp="0.25">¼×</button>
            <button class="chip" data-sp="0.5">½×</button>
            <button class="chip on" data-sp="1">1×</button>
            <button class="chip" data-sp="2">2×</button>
          </span>
        </div>
        <span style="display:flex;gap:4px">
          <button class="chip" data-f="-1" aria-label="Previous kart">◀</button>
          <button class="chip play" aria-label="Play or pause">❚❚</button>
          <button class="chip" data-f="1" aria-label="Next kart">▶</button>
        </span>
        <input type="range" min="0" max="1" step="0.001" value="0" aria-label="Replay position"/>
        <span style="display:flex;gap:8px;align-items:center"><span class="num rt" style="font-size:13px;color:var(--muted)">0:00</span><button class="chip" data-x="1">Exit</button></span>
      </div>`);
    el.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) =>
      b.addEventListener('click', () => {
        el.querySelectorAll('[data-cam]').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        this.handlers.replayCam(b.dataset.cam!);
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-sp]').forEach((b) =>
      b.addEventListener('click', () => {
        el.querySelectorAll('[data-sp]').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        this.handlers.replaySpeed(Number(b.dataset.sp));
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-f]').forEach((b) => b.addEventListener('click', () => this.handlers.replayFocus(Number(b.dataset.f))));
    el.querySelector('.play')!.addEventListener('click', () => this.handlers.replayPause());
    el.querySelector('[data-x]')!.addEventListener('click', () => this.handlers.replayExit());
    const range = el.querySelector('input') as HTMLInputElement;
    range.addEventListener('input', () => this.handlers.replaySeek(Number(range.value)));
    this.replayBar = el;
    this.root.appendChild(el);
  }

  updateReplay(t: number, dur: number, paused: boolean, name: string, color: number) {
    if (!this.replayBar) return;
    const range = this.replayBar.querySelector('input') as HTMLInputElement;
    if (document.activeElement !== range) range.value = String(dur > 0 ? t / dur : 0);
    this.replayBar.querySelector('.rt')!.textContent = formatTime(t).slice(0, -4);
    this.replayBar.querySelector('.play')!.textContent = paused ? '▶' : '❚❚';
    this.replayBar.querySelector('.wn')!.textContent = name;
    (this.replayBar.querySelector('.who i') as HTMLElement).style.background = hex(color);
  }

  // ---------------------------------------------------------------- touch
  enableTouch(on: boolean) {
    if (!on) {
      this.touch?.remove();
      this.touch = null;
      this.input.touch.active = false;
      return;
    }
    if (this.touch) return;
    const el = h(`<div class="touch"><div class="steer"><i></i></div><div class="pad brake" style="right:128px">BRAKE</div><div class="pad gas" style="right:20px;bottom:74px">GAS</div></div>`);
    const steer = el.querySelector('.steer') as HTMLElement;
    const knob = steer.querySelector('i') as HTMLElement;
    const gas = el.querySelector('.gas') as HTMLElement;
    const brake = el.querySelector('.brake') as HTMLElement;
    const t = this.input.touch;
    t.active = true;
    let steerId = -1;
    const steerMove = (x: number) => {
      const r = steer.getBoundingClientRect();
      const v = clamp(((x - r.left) / r.width) * 2 - 1, -1, 1);
      t.steer = v;
      knob.style.transform = `translateX(${v * (r.width / 2 - 40)}px)`;
    };
    steer.addEventListener('pointerdown', (e) => {
      steerId = e.pointerId;
      steer.setPointerCapture(e.pointerId);
      steerMove(e.clientX);
    });
    steer.addEventListener('pointermove', (e) => e.pointerId === steerId && steerMove(e.clientX));
    const endSteer = (e: PointerEvent) => {
      if (e.pointerId !== steerId) return;
      steerId = -1;
      t.steer = 0;
      knob.style.transform = '';
    };
    steer.addEventListener('pointerup', endSteer);
    steer.addEventListener('pointercancel', endSteer);
    const pedal = (elp: HTMLElement, key: 'throttle' | 'brake') => {
      elp.addEventListener('pointerdown', (e) => {
        elp.setPointerCapture(e.pointerId);
        t[key] = 1;
        elp.classList.add('active');
      });
      const up = () => {
        t[key] = 0;
        elp.classList.remove('active');
      };
      elp.addEventListener('pointerup', up);
      elp.addEventListener('pointercancel', up);
    };
    pedal(gas, 'throttle');
    pedal(brake, 'brake');
    this.touch = el;
    this.root.appendChild(el);
  }

  // ------------------------------------------------------------------ fps
  tickFps(dt: number) {
    this.fpsEl.classList.toggle('hidden', !settings.get('showFps'));
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime > 0.5) {
      this.fpsEl.textContent = `${Math.round(this.frames / this.fpsTime)} FPS`;
      this.frames = 0;
      this.fpsTime = 0;
    }
  }
}
