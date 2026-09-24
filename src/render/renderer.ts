import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Quality } from '../core/settings';

export type Tier = 'low' | 'medium' | 'high';

// Renderer + post-processing chain with adaptive resolution.
//   RenderPass (MSAA, HDR) → UnrealBloom → OutputPass (ACES + sRGB) → SpeedFX

const SpeedFXShader = {
  name: 'SpeedFX',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSpeed: { value: 0 },
    uVignette: { value: 0.55 },
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.52) },
    uFlash: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSpeed;
    uniform float uVignette;
    uniform float uTime;
    uniform vec2 uCenter;
    uniform float uFlash;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
      vec2 dir = uv - uCenter;
      float dist = length(dir);
      vec3 col = texture2D(tDiffuse, uv).rgb;
      float strength = uSpeed * 0.045 * smoothstep(0.18, 0.75, dist);
      if (strength > 0.0005) {
        vec3 acc = col;
        for (int i = 1; i < 8; i++) {
          float t = float(i) / 8.0;
          acc += texture2D(tDiffuse, uv - dir * strength * t).rgb;
        }
        col = acc / 8.0;
      }
      float ca = 0.0022 * dist * dist * (1.0 + uSpeed * 2.0);
      col.r = mix(col.r, texture2D(tDiffuse, uv + dir * ca).r, 0.5);
      col.b = mix(col.b, texture2D(tDiffuse, uv - dir * ca).b, 0.5);
      float v = smoothstep(0.95, 0.3, dist);
      col *= mix(1.0, v, uVignette);
      float n = fract(sin(dot(uv * (fract(uTime) + 1.0), vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * 0.012;
      col = mix(col, vec3(1.0), uFlash);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Renderer {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  renderPass: RenderPass;
  bloom: UnrealBloomPass;
  fx: ShaderPass;
  output: OutputPass;
  /** Geometry/particle tier the world is built at. */
  quality: Tier = 'high';
  auto = true;
  resScale = 1;
  /** Sun shadow-map size for the current preset. */
  shadowSize = 4096;
  /** Frame-rate ceiling the preset imposes (0 = none). */
  presetFps = 0;
  /** Frame cap the app loop is running at (0 = uncapped); set by the app, read by dynamic resolution. */
  targetFps = 0;
  private maxRes = 1;
  private frameTimes: number[] = [];
  private lastAdjust = 0;
  onQualityChange?: (q: Tier) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.85;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, rt);
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.4, 1.6);
    // cap what feeds the blur: the sun disc and the halo round a low sun run far above 1 in HDR
    // and would otherwise wash out Mt. Fuji and half the frame at golden hour
    const hp = this.bloom.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace('vec4 texel = texture2D( tDiffuse, vUv );', 'vec4 texel = min( texture2D( tDiffuse, vUv ), vec4( 3.0 ) );');
    this.composer.addPass(this.bloom);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
    this.fx = new ShaderPass(SpeedFXShader);
    this.composer.addPass(this.fx);
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(q: Quality) {
    this.auto = q === 'auto';
    const dpr = window.devicePixelRatio || 1;
    let eff: Tier = q === 'auto' ? (dpr > 1.5 ? 'medium' : 'high') : q === 'battery' ? 'medium' : q;
    // iPadOS Safari reports a Mac user agent; a "Mac" with multi-touch is an iPad
    const ua = navigator.userAgent;
    const mobile = /Mobi|Android|iPhone|iPad/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (q === 'auto' && mobile) eff = 'low';
    this.quality = eff;
    const battery = q === 'battery';
    // High stops at 1.5× — above that the extra pixels cost far more heat than they show
    this.maxRes = battery || eff === 'low' ? Math.min(dpr, 1) : Math.min(dpr, 1.5);
    this.resScale = this.maxRes;
    this.shadowSize = battery || eff === 'low' ? 1024 : eff === 'medium' ? 2048 : 4096;
    this.presetFps = battery ? 60 : 0;
    const post = !battery && eff !== 'low';
    this.bloom.enabled = post;
    this.fx.enabled = eff !== 'low';
    const samples = post ? 4 : 0;
    (this.composer.renderTarget1 as THREE.WebGLRenderTarget).samples = samples;
    (this.composer.renderTarget2 as THREE.WebGLRenderTarget).samples = samples;
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.frameTimes.length = 0;
    this.resize();
    this.onQualityChange?.(eff);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.resScale);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.resScale);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    const cam = this.renderPass.camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number) {
    this.renderPass.scene = scene;
    if (this.renderPass.camera !== camera) {
      this.renderPass.camera = camera;
      const pc = camera as THREE.PerspectiveCamera;
      if (pc.isPerspectiveCamera) {
        pc.aspect = window.innerWidth / window.innerHeight;
        pc.updateProjectionMatrix();
      }
    }
    this.fx.uniforms.uTime.value += dt;
    this.composer.render(dt);
    if (this.auto) this.adapt(dt);
  }

  /** Dynamic resolution: trade pixels for a steady frame rate. */
  private adapt(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    this.frameTimes.length = 0;
    const now = performance.now();
    if (now - this.lastAdjust < 1500) return;
    // With a frame cap, dt sits at the cap interval whenever the GPU keeps up, so "keeping up" is the
    // cue to step back up (more slowly, as it can't see how much headroom is left).
    const cap = this.targetFps > 0 ? 1 / this.targetFps : 0;
    const slow = cap ? Math.max(1 / 50, cap * 1.2) : 1 / 50;
    const fast = cap ? cap * 1.05 : 1 / 75;
    let next = this.resScale;
    if (p75 > slow) next = Math.max(0.6, this.resScale - 0.15);
    else if (p75 < fast && this.resScale < this.maxRes && (!cap || now - this.lastAdjust > 4000)) next = Math.min(this.maxRes, this.resScale + 0.1);
    if (Math.abs(next - this.resScale) > 0.01) {
      this.resScale = next;
      this.lastAdjust = now;
      this.resize();
    }
  }

  setSpeedFx(speed01: number, vignette: number) {
    this.fx.uniforms.uSpeed.value = speed01;
    this.fx.uniforms.uVignette.value = vignette;
  }

  flash(v: number) {
    this.fx.uniforms.uFlash.value = v;
  }
}
