import * as THREE from 'three';

// Lightweight CPU particle pool rendered as a single Points draw call, plus a
// ring-buffered skid-mark ribbon renderer.

export interface EmitOpts {
  life: number;
  size0: number;
  size1: number;
  color: THREE.Color | number;
  alpha: number;
  gravity?: number;
  drag?: number;
}

export class Particles {
  points: THREE.Points;
  private max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private alpha0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private sizeAttr: THREE.BufferAttribute;
  private alphaAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private rotAttr: THREE.BufferAttribute;
  private cursor = 0;
  material: THREE.ShaderMaterial;
  private tmpC = new THREE.Color();

  constructor(max: number, texture: THREE.Texture, additive = false) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.rotAttr = new THREE.BufferAttribute(new Float32Array(max), 1);
    for (let i = 0; i < max; i++) this.rotAttr.setX(i, Math.random() * Math.PI * 2);
    g.setAttribute('aSize', this.sizeAttr);
    g.setAttribute('aAlpha', this.alphaAttr);
    g.setAttribute('aColor', this.colAttr);
    g.setAttribute('aRot', this.rotAttr);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        uScale: { value: 600 },
        fogColor: { value: new THREE.Color() },
        fogDensity: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        attribute float aRot;
        uniform float uScale;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vRot;
        varying float vDepth;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(0.1, -mv.z);
          vAlpha = aAlpha;
          vColor = aColor;
          vRot = aRot;
          vDepth = -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 fogColor;
        uniform float fogDensity;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vRot;
        varying float vDepth;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float c = cos(vRot), s = sin(vRot);
          p = mat2(c, -s, s, c) * p + 0.5;
          vec4 t = texture2D(map, p);
          float fog = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
          vec3 col = mix(vColor, fogColor, fog);
          gl_FragColor = vec4(col * t.rgb, t.a * vAlpha);
          if (gl_FragColor.a < 0.004) discard;
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, o: EmitOpts) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = o.life;
    this.maxLife[i] = o.life;
    this.size0[i] = o.size0;
    this.size1[i] = o.size1;
    this.alpha0[i] = o.alpha;
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 1.5;
    const c = typeof o.color === 'number' ? this.tmpC.setHex(o.color) : o.color;
    this.colAttr.setXYZ(i, c.r, c.g, c.b);
  }

  update(dt: number, camera: THREE.PerspectiveCamera, viewportH: number, fog?: THREE.FogExp2) {
    this.material.uniforms.uScale.value = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    if (fog) {
      this.material.uniforms.fogColor.value.copy(fog.color);
      this.material.uniforms.fogDensity.value = fog.density;
    }
    const sizes = this.sizeAttr.array as Float32Array;
    const alphas = this.alphaAttr.array as Float32Array;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        alphas[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      sizes[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      alphas[i] = this.alpha0[i] * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
  }
}

export class SkidMarks {
  mesh: THREE.Mesh;
  private max: number;
  private pos: Float32Array;
  private alpha: Float32Array;
  private birth: Float32Array;
  private cursor = 0;
  private last = new Map<string, { x: number; y: number; z: number; lx: number; lz: number; a: number }>();
  private time = 0;
  private posAttr: THREE.BufferAttribute;
  private alphaAttr: THREE.BufferAttribute;
  private birthAttr: THREE.BufferAttribute;
  private dirty = false;

  constructor(max = 4000) {
    this.max = max;
    this.pos = new Float32Array(max * 4 * 3);
    this.alpha = new Float32Array(max * 4);
    this.birth = new Float32Array(max * 4).fill(-1000);
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) {
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.birthAttr = new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aAlpha', this.alphaAttr);
    g.setAttribute('aBirth', this.birthAttr);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        attribute float aBirth;
        uniform float uTime;
        varying float vA;
        void main() {
          float age = uTime - aBirth;
          vA = aAlpha * (1.0 - smoothstep(25.0, 60.0, age));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() { gl_FragColor = vec4(0.03, 0.03, 0.035, vA * 0.75); }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Adds a skid segment for a wheel identified by `key`. */
  add(key: string, x: number, y: number, z: number, heading: number, width: number, intensity: number) {
    const lx = Math.cos(heading) * width * 0.5;
    const lz = -Math.sin(heading) * width * 0.5;
    const prev = this.last.get(key);
    if (!prev) {
      this.last.set(key, { x, y, z, lx, lz, a: intensity });
      return;
    }
    const d = Math.hypot(x - prev.x, z - prev.z);
    if (d < 0.18) return;
    if (d > 2) {
      this.last.set(key, { x, y, z, lx, lz, a: intensity });
      return;
    }
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const o = i * 12;
    const yy = y + 0.012;
    const py = prev.y + 0.012;
    this.pos.set([prev.x - prev.lx, py, prev.z - prev.lz, prev.x + prev.lx, py, prev.z + prev.lz, x - lx, yy, z - lz, x + lx, yy, z + lz], o);
    this.alpha.set([prev.a, prev.a, intensity, intensity], i * 4);
    this.birth.fill(this.time, i * 4, i * 4 + 4);
    this.last.set(key, { x, y, z, lx, lz, a: intensity });
    this.dirty = true;
  }

  lift(key: string) {
    this.last.delete(key);
  }

  update(dt: number) {
    this.time += dt;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time;
    if (this.dirty) {
      this.posAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.birthAttr.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear() {
    this.alpha.fill(0);
    this.alphaAttr.needsUpdate = true;
    this.last.clear();
  }
}
