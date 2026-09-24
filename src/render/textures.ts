import * as THREE from 'three';
import { fbm, rng, valueNoise } from '../core/math';

// Every texture in the demo is generated at runtime on a canvas — no image assets.

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { c, ctx };
}

function toTexture(c: HTMLCanvasElement, opts: { repeat?: boolean; srgb?: boolean; aniso?: number } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  }
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso ?? 8;
  t.needsUpdate = true;
  return t;
}

/** Converts a height field (0..1) into a tangent-space normal map. */
function heightToNormal(height: Float32Array, w: number, h: number, strength: number) {
  const { c, ctx } = canvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = height[y * w + ((x - 1 + w) % w)];
      const r = height[y * w + ((x + 1) % w)];
      const u = height[((y - 1 + h) % h) * w + x];
      const d = height[((y + 1) % h) * w + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * w + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { repeat: true, srgb: false });
}

const cache = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/** Fine-grained race asphalt with aggregate speckles, tileable. */
export function asphalt(): PBRSet {
  return cached('asphalt', () => {
    const S = 512;
    const { c, ctx } = canvas(S, S);
    const rough = canvas(S, S);
    const img = ctx.createImageData(S, S);
    const rimg = rough.ctx.createImageData(S, S);
    const height = new Float32Array(S * S);
    const rand = rng(1337);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        // tileable noise via wrapping coordinates on a torus-like sampling
        const nx = x / S;
        const ny = y / S;
        const n1 = tileNoise(nx, ny, 8);
        const n2 = tileNoise(nx, ny, 32);
        const n3 = tileNoise(nx, ny, 96);
        const speck = rand();
        let v = 0.2 + n1 * 0.05 + n2 * 0.05 + n3 * 0.08;
        let hgt = n3 * 0.5 + n2 * 0.3;
        if (speck > 0.93) {
          v += 0.12 * rand();
          hgt += 0.5;
        } else if (speck < 0.05) {
          v -= 0.07;
          hgt -= 0.3;
        }
        const i = (y * S + x) * 4;
        const g = Math.max(0, Math.min(1, v));
        img.data[i] = g * 255 * 0.98;
        img.data[i + 1] = g * 255;
        img.data[i + 2] = g * 255 * 1.04;
        img.data[i + 3] = 255;
        height[y * S + x] = hgt;
        const r = 0.78 + (speck > 0.93 ? -0.25 : 0) + n2 * 0.1;
        rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = Math.min(255, r * 255);
        rimg.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    rough.ctx.putImageData(rimg, 0, 0);
    return {
      map: toTexture(c, { repeat: true }),
      normalMap: heightToNormal(height, S, S, 2.2),
      roughnessMap: toTexture(rough.c, { repeat: true, srgb: false }),
    };
  });
}

function tileNoise(x: number, y: number, period: number) {
  // Bilinear blend of 4 shifted samples to make value noise tile at `period`.
  const a = valueNoise(x * period, y * period);
  const b = valueNoise((x - 1) * period, y * period);
  const c = valueNoise(x * period, (y - 1) * period);
  const d = valueNoise((x - 1) * period, (y - 1) * period);
  return a * (1 - x) * (1 - y) + b * x * (1 - y) + c * (1 - x) * y + d * x * y;
}

/** Tileable grass detail — multiplied with terrain vertex colours. */
export function grassDetail(): THREE.Texture {
  return cached('grass', () => {
    const S = 512;
    const { c, ctx } = canvas(S, S);
    const img = ctx.createImageData(S, S);
    const rand = rng(99);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const nx = x / S;
        const ny = y / S;
        const n = tileNoise(nx, ny, 16) * 0.5 + tileNoise(nx, ny, 64) * 0.5;
        const blade = rand();
        let v = 0.78 + n * 0.3 + (blade - 0.5) * 0.22;
        const i = (y * S + x) * 4;
        v = Math.max(0, Math.min(1.2, v));
        img.data[i] = Math.min(255, v * 205);
        img.data[i + 1] = Math.min(255, v * 225);
        img.data[i + 2] = Math.min(255, v * 190);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { repeat: true });
  });
}

/** 2x2 twill carbon-fibre weave. */
export function carbon(): THREE.Texture {
  return cached('carbon', () => {
    const S = 256;
    const { c, ctx } = canvas(S, S);
    const cell = 16;
    for (let y = 0; y < S / cell; y++) {
      for (let x = 0; x < S / cell; x++) {
        const horizontal = ((x + y) >> 1) % 2 === 0;
        const g = ctx.createLinearGradient(
          x * cell,
          y * cell,
          horizontal ? x * cell : (x + 1) * cell,
          horizontal ? (y + 1) * cell : y * cell,
        );
        g.addColorStop(0, '#0d0d0f');
        g.addColorStop(0.5, horizontal ? '#34353a' : '#26272b');
        g.addColorStop(1, '#0d0d0f');
        ctx.fillStyle = g;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    return toTexture(c, { repeat: true });
  });
}

/** Red/white kerb stripes; v runs along the track. */
export function kerb(): THREE.Texture {
  return cached('kerb', () => {
    const { c, ctx } = canvas(64, 256);
    ctx.fillStyle = '#f3f3f0';
    ctx.fillRect(0, 0, 64, 256);
    ctx.fillStyle = '#d3161e';
    ctx.fillRect(0, 0, 64, 128);
    // grime
    const img = ctx.getImageData(0, 0, 64, 256);
    const rand = rng(5);
    for (let i = 0; i < img.data.length; i += 4) {
      const k = 0.88 + rand() * 0.12;
      img.data[i] *= k;
      img.data[i + 1] *= k;
      img.data[i + 2] *= k;
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { repeat: true });
  });
}

export function checker(cols = 12, rows = 2): THREE.Texture {
  return cached(`checker${cols}x${rows}`, () => {
    const cw = 32;
    const { c, ctx } = canvas(cols * cw, rows * cw);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
        ctx.fillRect(x * cw, y * cw, cw, cw);
      }
    const t = toTexture(c);
    t.magFilter = THREE.NearestFilter;
    return t;
  });
}

/** Sidewall lettering; x maps to angle around the wheel, y to radius. */
export function tireSidewall(): THREE.Texture {
  return cached('sidewall', () => {
    const W = 2048;
    const H = 96;
    const { c, ctx } = canvas(W, H);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(235,235,235,0.92)';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < 2; k++) {
      const x0 = k * (W / 2);
      ctx.font = 'italic 900 64px "Titillium Web", Arial, sans-serif';
      ctx.fillText('GR KART', x0 + 90, H / 2 + 4);
      ctx.font = '600 34px "Titillium Web", Arial, sans-serif';
      ctx.fillText('SLICK · 11x7.10-5', x0 + 470, H / 2 + 4);
      ctx.fillStyle = '#e0001b';
      ctx.fillRect(x0 + 60, 18, 18, H - 36);
      ctx.fillStyle = 'rgba(235,235,235,0.92)';
    }
    const t = toTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  });
}

export function numberPlate(num: number, accent: string): THREE.Texture {
  const { c, ctx } = canvas(256, 256);
  ctx.fillStyle = '#fbfbf9';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(256, 0);
  ctx.lineTo(256, 40);
  ctx.lineTo(0, 64);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.moveTo(0, 64);
  ctx.lineTo(256, 40);
  ctx.lineTo(256, 52);
  ctx.lineTo(0, 76);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.font = 'italic 900 150px "Titillium Web", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), 128, 160);
  return toTexture(c);
}

/** Equirectangular helmet livery: white shell with sweeping accent stripes. */
export function helmet(accent: string, second: string): THREE.Texture {
  const W = 512;
  const H = 256;
  const { c, ctx } = canvas(W, H);
  ctx.fillStyle = '#f7f7f5';
  ctx.fillRect(0, 0, W, H);
  // Sweeping stripes on both sides of the shell (u=0.25 / u=0.75 are the sides)
  for (const side of [0.25, 0.75]) {
    const cx = side * W;
    const dir = side < 0.5 ? 1 : -1;
    ctx.save();
    ctx.translate(cx, H * 0.52);
    ctx.scale(dir, 1);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(-120, 30);
    ctx.quadraticCurveTo(0, -40, 120, -10);
    ctx.lineTo(120, 12);
    ctx.quadraticCurveTo(0, -12, -120, 52);
    ctx.fill();
    ctx.fillStyle = second;
    ctx.beginPath();
    ctx.moveTo(-120, 58);
    ctx.quadraticCurveTo(0, -4, 120, 18);
    ctx.lineTo(120, 26);
    ctx.quadraticCurveTo(0, 8, -120, 68);
    ctx.fill();
    ctx.restore();
  }
  // top centre stripe
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, 10);
  return toTexture(c);
}

export function banner(text: string, bg: string, fg: string, accent?: string, w = 1024, h = 128): THREE.Texture {
  return cached(`banner:${text}:${bg}:${fg}:${accent}:${w}`, () => {
    const { c, ctx } = canvas(w, h);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    if (accent) {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(h * 0.9, 0);
      ctx.lineTo(h * 0.55, h);
      ctx.lineTo(0, h);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(w, 0);
      ctx.lineTo(w - h * 0.55, 0);
      ctx.lineTo(w - h * 0.9, h);
      ctx.lineTo(w, h);
      ctx.fill();
    }
    ctx.fillStyle = fg;
    ctx.font = `italic 900 ${Math.round(h * 0.62)}px "Titillium Web", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + h * 0.04);
    return toTexture(c);
  });
}

/** Soft round particle sprite. */
export function softDot(): THREE.Texture {
  return cached('softdot', () => {
    const S = 64;
    const { c, ctx } = canvas(S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return toTexture(c);
  });
}

/** Wispy smoke puff sprite. */
export function smokePuff(): THREE.Texture {
  return cached('smoke', () => {
    const S = 128;
    const { c, ctx } = canvas(S, S);
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = x / S - 0.5;
        const dy = y / S - 0.5;
        const r = Math.hypot(dx, dy) * 2;
        const n = fbm(x / 22, y / 22, 4);
        const a = Math.max(0, 1 - r) ** 1.6 * (0.55 + n * 0.9);
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.min(255, a * 255);
      }
    ctx.putImageData(img, 0, 0);
    return toTexture(c);
  });
}

/** Chain-link catch fence (alpha tested). */
export function fence(): THREE.Texture {
  return cached('fence', () => {
    const S = 128;
    const { c, ctx } = canvas(S, S);
    ctx.clearRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(200,205,210,1)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(S, S);
    ctx.moveTo(S, 0);
    ctx.lineTo(0, S);
    ctx.stroke();
    const t = toTexture(c, { repeat: true });
    return t;
  });
}

/** Soft dark band used for the rubbered-in racing line. */
export function rubberBand(): THREE.Texture {
  return cached('rubber', () => {
    const W = 64;
    const H = 256;
    const { c, ctx } = canvas(W, H);
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const edge = Math.sin(u * Math.PI) ** 1.5;
        const n = valueNoise(x / 6, y / 10) * 0.5 + valueNoise(x / 2, y / 3) * 0.5;
        const a = edge * (0.55 + n * 0.45);
        const i = (y * W + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 10;
        img.data[i + 3] = a * 255;
      }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { repeat: true });
  });
}

/** Radial vignette used under the showroom kart as a fake contact shadow. */
export function contactShadow(): THREE.Texture {
  return cached('contact', () => {
    const S = 256;
    const { c, ctx } = canvas(S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return toTexture(c);
  });
}

/** Brake disc with drilled holes. */
export function brakeDisc(): THREE.Texture {
  return cached('disc', () => {
    const S = 256;
    const { c, ctx } = canvas(S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S / 2);
    g.addColorStop(0, '#666');
    g.addColorStop(0.3, '#b8b8b8');
    g.addColorStop(0.98, '#9a9a9a');
    g.addColorStop(1, '#555');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    for (let ring = 0; ring < 2; ring++) {
      const r = S * (0.33 + ring * 0.09);
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + ring * 0.17;
        ctx.beginPath();
        ctx.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.18, 0, Math.PI * 2);
    ctx.fill();
    return toTexture(c);
  });
}

/** Floor texture for the showroom: subtle radial gradient + faint grid. */
export function studioFloor(): THREE.Texture {
  return cached('studio', () => {
    const S = 1024;
    const { c, ctx } = canvas(S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, '#2a2a2e');
    g.addColorStop(0.6, '#141416');
    g.addColorStop(1, '#070708');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= S; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, S);
      ctx.moveTo(0, i);
      ctx.lineTo(S, i);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(224,0,27,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    return toTexture(c);
  });
}

/** Painted track text such as "SAKURA" on the run-off, or grid numbers. */
export function paintedText(text: string, w = 512, h = 128): THREE.Texture {
  return cached(`paint:${text}:${w}x${h}`, () => {
    const { c, ctx } = canvas(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(245,245,245,0.9)';
    ctx.font = `italic 900 ${Math.round(h * 0.8)}px "Titillium Web", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
    return toTexture(c);
  });
}
