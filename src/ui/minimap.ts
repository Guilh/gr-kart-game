import type { Track } from '../track/track';

// Track map with live kart positions (rotated so the main straight runs left→right).

export interface MapDot {
  x: number;
  z: number;
  heading: number;
  color: number;
  isPlayer: boolean;
  isGhost?: boolean;
}

export class Minimap {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private scale = 1;
  private cx = 0;
  private cz = 0;
  private size = 200;
  private dpr = 1;

  constructor(private track: Track) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.resize(200);
  }

  resize(size: number) {
    this.size = size;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * this.dpr);
    this.canvas.width = this.canvas.height = px;
    this.base.width = this.base.height = px;
    const b = this.track.bounds;
    this.cx = (b.minX + b.maxX) / 2;
    this.cz = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 24;
    this.scale = px / span;
    this.drawBase();
  }

  /** World → canvas. Map is mirrored so it reads like a top-down view (x right, z down). */
  private map(x: number, z: number): [number, number] {
    const px = this.canvas.width;
    return [px / 2 + (x - this.cx) * this.scale, px / 2 + (z - this.cz) * this.scale];
  }

  private drawBase() {
    const ctx = this.base.getContext('2d')!;
    const t = this.track;
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    const path = () => {
      ctx.beginPath();
      for (let i = 0; i <= t.N; i++) {
        const k = i % t.N;
        const [x, y] = this.map(t.px[k], t.pz[k]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    ctx.lineJoin = 'round';
    path();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 11 * this.dpr;
    ctx.stroke();
    path();
    ctx.strokeStyle = 'rgba(245,244,240,0.92)';
    ctx.lineWidth = 5.5 * this.dpr;
    ctx.stroke();
    path();
    ctx.strokeStyle = 'rgba(40,40,44,0.95)';
    ctx.lineWidth = 3 * this.dpr;
    ctx.stroke();
    // start/finish
    const [sx, sy] = this.map(t.px[0], t.pz[0]);
    const nx = t.nx[0];
    const nz = t.nz[0];
    ctx.strokeStyle = '#e0001b';
    ctx.lineWidth = 3 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(sx - nx * 9 * this.dpr, sy - nz * 9 * this.dpr);
    ctx.lineTo(sx + nx * 9 * this.dpr, sy + nz * 9 * this.dpr);
    ctx.stroke();
  }

  draw(dots: MapDot[]) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    const d = this.dpr;
    // others first, player on top
    const sorted = [...dots].sort((a, b) => Number(a.isPlayer) - Number(b.isPlayer));
    for (const k of sorted) {
      const [x, y] = this.map(k.x, k.z);
      const hex = '#' + k.color.toString(16).padStart(6, '0');
      if (k.isPlayer) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-k.heading);
        ctx.beginPath();
        ctx.moveTo(0, 7 * d);
        ctx.lineTo(5 * d, -5 * d);
        ctx.lineTo(0, -2.5 * d);
        ctx.lineTo(-5 * d, -5 * d);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#e0001b';
        ctx.lineWidth = 2 * d;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, (k.isGhost ? 3.5 : 4.2) * d, 0, Math.PI * 2);
        ctx.fillStyle = k.isGhost ? 'rgba(127,212,255,0.8)' : hex;
        ctx.fill();
        ctx.lineWidth = 1.5 * d;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.stroke();
      }
    }
  }
}
