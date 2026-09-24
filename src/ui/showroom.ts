import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { KartModel, LIVERIES } from '../kart/kartModel';
import { DIM, FEATURES, GR_KART_SPEC, KartFeature } from '../kart/kartSpecs';
import { contactShadow } from '../render/textures';
import { damp, lerp, smoothstep } from '../core/math';
import { audio } from '../audio/audio';

// Studio showroom: orbit the GR KART on a blurred mirror floor, explode it into
// parts, overlay the official dimensions, tour the key features and try the
// driver-fit adjustment (135–185 cm) that slides the pedals and tilts the wheel.

const FloorShader = {
  name: 'StudioFloor',
  uniforms: {
    color: { value: null as THREE.Color | null },
    tDiffuse: { value: null as THREE.Texture | null },
    textureMatrix: { value: null as THREE.Matrix4 | null },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      vec3 refl = vec3(0.0);
      float tot = 0.0;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          float w = 1.0 / (1.0 + float(x * x + y * y));
          refl += texture2D(tDiffuse, uv + vec2(float(x), float(y)) * 0.0022).rgb * w;
          tot += w;
        }
      }
      refl /= tot;
      float d = length(vWorld.xz);
      float fade = smoothstep(4.5, 0.6, d);
      vec3 base = mix(vec3(0.012), vec3(0.05, 0.05, 0.055), smoothstep(7.0, 0.0, d));
      // faint grid + a red ring under the kart
      vec2 g = abs(fract(vWorld.xz * 2.0) - 0.5);
      float grid = smoothstep(0.49, 0.5, max(g.x, g.y)) * 0.018 * smoothstep(6.0, 1.0, d);
      float ring = smoothstep(0.02, 0.0, abs(d - 1.55)) * 0.8;
      vec3 col = base + grid + vec3(0.88, 0.0, 0.1) * ring * 0.35 + refl * 0.32 * fade;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

export class Showroom {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
  controls: OrbitControls;
  kart: KartModel;
  private pivot = new THREE.Group();
  private ui: HTMLElement;
  private hotspots: { el: HTMLElement; f: KartFeature }[] = [];
  private dimGroup = new THREE.Group();
  private dimLabels: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  private explode = 0;
  private explodeTarget = 0;
  private upright = 0;
  private uprightTarget = 0;
  private showDims = false;
  private height = 175;
  private fitT = 0.8;
  private tween: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; t: number } | null = null;
  private idle = 0;
  private active: KartFeature | null = null;
  private follow: KartFeature | null = null; // the camera aims at this part until the user takes over
  private highlighted: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
  private time = 0;
  private envRT: THREE.WebGLRenderTarget;
  private tmp = new THREE.Vector3();
  private contact!: THREE.Mesh;
  private lowProfile: THREE.Vector2[] = [];
  onDrive: () => void = () => {};
  onExit: () => void = () => {};

  constructor(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) {
    const s = this.scene;
    s.background = new THREE.Color(0x060607);
    s.fog = new THREE.Fog(0x060607, 8, 22);
    const pm = new THREE.PMREMGenerator(renderer);
    this.envRT = pm.fromScene(new RoomEnvironment(), 0.03);
    s.environment = this.envRT.texture;
    s.environmentIntensity = 0.55;

    // Lights: key, two rims (one GR red), soft fill
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(2.5, 5, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -2;
    sc.right = 2;
    sc.top = 2;
    sc.bottom = -2;
    sc.near = 1;
    sc.far = 12;
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.01;
    key.shadow.radius = 4;
    s.add(key);
    const rim1 = new THREE.SpotLight(0xff2436, 30, 12, 0.5, 0.6);
    rim1.position.set(-3.5, 2.2, -3);
    s.add(rim1, rim1.target);
    const rim2 = new THREE.SpotLight(0xdfe8ff, 26, 12, 0.5, 0.6);
    rim2.position.set(3.5, 2.6, -3.2);
    s.add(rim2, rim2.target);
    s.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.35));

    // Reflective floor
    const floorGeo = new THREE.CircleGeometry(14, 96);
    const floor = new Reflector(floorGeo, {
      clipBias: 0.002,
      textureWidth: 1024,
      textureHeight: 1024,
      color: 0x777777,
      shader: FloorShader,
    });
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);
    const shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(4, 64).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.55 }));
    shadowCatcher.position.y = 0.001;
    shadowCatcher.receiveShadow = true;
    s.add(shadowCatcher);
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 2.4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: contactShadow(), transparent: true, depthWrite: false, opacity: 0.9 }),
    );
    contact.position.y = 0.002;
    s.add(contact);
    this.contact = contact;

    // The kart (full detail, separate parts)
    this.kart = new KartModel(LIVERIES[0], 'showroom', true);
    // pivot sits at the rear bumper's bottom edge so the kart can tip up onto its tail
    this.kart.root.position.z = DIM.length / 2;
    this.pivot.position.z = -DIM.length / 2;
    this.pivot.add(this.kart.root);
    s.add(this.pivot);
    this.kart.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
    });
    this.lowProfile = lowProfile(this.kart, this.pivot);
    this.buildDimensions();
    s.add(this.dimGroup);

    this.camera.position.set(2.7, 1.25, 2.9);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.3, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 1.1;
    this.controls.maxDistance = 7;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.enabled = false;
    this.controls.addEventListener('start', () => {
      this.idle = 0;
      this.tween = null;
      this.follow = null;
    });

    this.ui = this.buildUI();
    this.ui.classList.add('hidden');
    document.getElementById('ui')!.appendChild(this.ui);
    this.setHeight(175);
  }

  // ------------------------------------------------------------------ UI
  private buildUI() {
    const el = document.createElement('div');
    el.id = 'showroom-ui';
    el.innerHTML = `
      <div class="panel spec">
        <div class="eyebrow">Toyota GR KART · 2026</div>
        <div class="wordmark" style="margin-top:6px"><span class="gr"><span>GR</span></span><span>KART</span></div>
        <p>An entry-level racing kart built to be easy to own: low maintenance, adjustable for the whole family, and small enough to carry in a minivan.</p>
        <div class="spec-grid">
          <div><small>Length</small><b>${GR_KART_SPEC.lengthMm.toLocaleString()} mm</b></div>
          <div><small>Width</small><b>${GR_KART_SPEC.widthMm.toLocaleString()} mm</b></div>
          <div><small>Height</small><b>${GR_KART_SPEC.heightMm} mm</b></div>
          <div><small>Wheelbase</small><b>${GR_KART_SPEC.wheelbaseMm.toLocaleString()} mm</b></div>
          <div><small>Weight</small><b>${GR_KART_SPEC.weightKg} kg</b></div>
          <div><small>Engine</small><b>${GR_KART_SPEC.displacementCc} cc 4T</b></div>
          <div><small>Drivers</small><b>135–185 cm</b></div>
          <div><small>Price</small><b>¥${GR_KART_SPEC.priceYen.toLocaleString()}</b></div>
        </div>
      </div>
      <div class="panel features"><h3>Key features</h3>${FEATURES.map(
        (f, i) => `<button class="feat" data-i="${i}"><small>${f.tag}</small><b>${f.title}</b></button>`,
      ).join('')}</div>
      <div class="panel feature-card hidden"><small></small><h4></h4><p></p></div>
      <div class="panel toolbar">
        <button class="tool" data-t="explode">Exploded view</button>
        <button class="tool" data-t="dims">Dimensions</button>
        <button class="tool on" data-t="driver">Driver</button>
        <button class="tool" data-t="upright">Stand upright</button>
        <span class="fit">Driver <input type="range" min="135" max="185" step="1" value="175" aria-label="Driver height"/> <b class="num hv">175 cm</b></span>
        <button class="tool go" data-t="drive">Drive it ▸</button>
      </div>
      <button class="btn ghost back interactive"><span>◂ Menu</span></button>`;
    el.querySelectorAll<HTMLButtonElement>('.feat').forEach((b) =>
      b.addEventListener('click', () => {
        audio.click();
        this.focusFeature(FEATURES[Number(b.dataset.i)]);
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) =>
      b.addEventListener('click', () => {
        audio.click();
        const t = b.dataset.t;
        if (t === 'explode') {
          this.explodeTarget = this.explodeTarget > 0.5 ? 0 : 1;
          this.uprightTarget = 0;
          b.classList.toggle('on', this.explodeTarget > 0.5);
          el.querySelector('[data-t="upright"]')!.classList.remove('on');
          if (this.explodeTarget > 0.5) this.flyTo(new THREE.Vector3(3.6, 2.4, 3.6), new THREE.Vector3(0, 0.5, 0));
        } else if (t === 'dims') {
          this.showDims = !this.showDims;
          b.classList.toggle('on', this.showDims);
          if (this.showDims) {
            this.explodeTarget = 0;
            el.querySelector('[data-t="explode"]')!.classList.remove('on');
            // the feature card would sit under the length label
            el.querySelector('.feature-card')!.classList.add('hidden');
            // framed so all four labels clear the side panels and the toolbar at 1280×760
            this.flyTo(new THREE.Vector3(2.05, 1.45, 2.05), new THREE.Vector3(0, 0.1, 0));
          }
        } else if (t === 'driver') {
          const d = this.kart.driver!.group;
          d.visible = !d.visible;
          b.classList.toggle('on', d.visible);
        } else if (t === 'upright') {
          this.uprightTarget = this.uprightTarget > 0.5 ? 0 : 1;
          b.classList.toggle('on', this.uprightTarget > 0.5);
          this.explodeTarget = 0;
          el.querySelector('[data-t="explode"]')!.classList.remove('on');
          if (this.uprightTarget > 0.5) {
            this.kart.driver!.group.visible = false;
            el.querySelector('[data-t="driver"]')!.classList.remove('on');
            this.flyTo(new THREE.Vector3(2.3, 1.25, -3.0), new THREE.Vector3(0, 0.8, -0.95));
            this.showCard('Ownership', 'Upright storage', 'An oil catch tank and a sealed fuel system let the GR KART stand on its tail in a garage corner. At 1,820 mm long it also fits in a Noah or Voxy without being taken apart.');
          }
        } else if (t === 'drive') {
          this.onDrive();
        }
      }),
    );
    const range = el.querySelector('input') as HTMLInputElement;
    range.addEventListener('input', () => {
      this.animateFit = 0;
      this.setHeight(Number(range.value));
    });
    el.querySelector('.back')!.addEventListener('click', () => {
      audio.click();
      this.onExit();
    });

    // hotspots
    FEATURES.forEach((f, i) => {
      const hs = document.createElement('button');
      hs.className = 'hotspot';
      hs.textContent = String(i + 1);
      hs.setAttribute('aria-label', f.title);
      hs.addEventListener('click', () => {
        audio.click();
        this.focusFeature(f);
      });
      el.appendChild(hs);
      this.hotspots.push({ el: hs, f });
    });
    return el;
  }

  private showCard(tag: string, title: string, body: string) {
    const card = this.ui.querySelector('.feature-card') as HTMLElement;
    card.classList.remove('hidden');
    card.querySelector('small')!.textContent = tag;
    card.querySelector('h4')!.textContent = title;
    card.querySelector('p')!.textContent = body;
    // restart the entrance animation
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
  }

  private focusFeature(f: KartFeature) {
    this.active = f;
    this.ui.querySelectorAll('.feat').forEach((b, i) => b.classList.toggle('on', FEATURES[i] === f));
    this.hotspots.forEach((h) => h.el.classList.toggle('on', h.f === f));
    this.showCard(f.tag, f.title, f.body);
    if (this.uprightTarget > 0) {
      this.uprightTarget = 0;
      this.ui.querySelector('[data-t="upright"]')!.classList.remove('on');
    }
    const anchor = this.anchorWorld(f, new THREE.Vector3());
    const view = new THREE.Vector3(...f.view);
    this.flyTo(view, anchor);
    this.follow = f;
    this.highlight(f.part);
    if (f.id === 'pedals' || f.id === 'steering') {
      // demonstrate the adjustment range, starting and ending at the current setting
      if (this.animateFit === 0) this.fitBase = this.height;
      this.animateFit = 1;
    }
  }
  private animateFit = 0;
  private fitBase = 175;

  private highlight(part: string) {
    for (const h of this.highlighted) h.mesh.material = h.mat;
    this.highlighted = [];
    const obj = this.kart.parts[part];
    if (!obj || part === 'body') return;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      const orig = m.material;
      const c = (orig as THREE.MeshStandardMaterial).clone();
      if ('emissive' in c) {
        c.emissive = new THREE.Color(0xe0001b);
        c.emissiveIntensity = 0;
      }
      m.material = c;
      this.highlighted.push({ mesh: m, mat: orig });
    });
  }

  private anchorWorld(f: KartFeature, out: THREE.Vector3) {
    // anchors are authored on the assembled kart; follow the part's explode offset
    const off = this.kart.explodeOffsets[f.part];
    out.set(...f.anchor);
    if (off) out.addScaledVector(off, smoothstep(0, 1, this.explode));
    this.kart.body.updateWorldMatrix(true, false);
    return this.kart.body.localToWorld(out);
  }

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3) {
    this.tween = { p0: this.camera.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: target, t: 0 };
    this.follow = null;
    this.idle = 0;
  }

  private setHeight(cm: number) {
    this.height = cm;
    this.fitT = (cm - 135) / 50;
    this.kart.driver?.setHeight(cm);
    this.kart.pedalSlide = lerp(0.13, 0, this.fitT);
    this.kart.columnTilt = lerp(-0.14, 0.03, this.fitT);
    const hv = this.ui.querySelector('.hv');
    if (hv) hv.textContent = `${cm} cm`;
  }

  // ---------------------------------------------------------- dimensions
  private buildDimensions() {
    const mat = new THREE.LineBasicMaterial({ color: 0xf5f4f0, transparent: true, opacity: 0.85, depthTest: false });
    const pts: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3) => pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const tick = (p: THREE.Vector3, dir: THREE.Vector3) => seg(p.clone().addScaledVector(dir, -0.05), p.clone().addScaledVector(dir, 0.05));
    const y = 0.01;
    const L = DIM.length / 2;
    const W = DIM.width / 2;
    // length along the left side
    const la = new THREE.Vector3(W + 0.25, y, -L);
    const lb = new THREE.Vector3(W + 0.25, y, L);
    seg(la, lb);
    tick(la, new THREE.Vector3(1, 0, 0));
    tick(lb, new THREE.Vector3(1, 0, 0));
    seg(new THREE.Vector3(W, y, -L), la);
    seg(new THREE.Vector3(W, y, L), lb);
    this.dimLabels.push({ el: this.label(`${GR_KART_SPEC.lengthMm.toLocaleString()} mm`, 'LENGTH'), pos: new THREE.Vector3(W + 0.25, y, 0) });
    // width across the rear
    const wa = new THREE.Vector3(-W, y, -L - 0.25);
    const wb = new THREE.Vector3(W, y, -L - 0.25);
    seg(wa, wb);
    tick(wa, new THREE.Vector3(0, 0, 1));
    tick(wb, new THREE.Vector3(0, 0, 1));
    this.dimLabels.push({ el: this.label(`${GR_KART_SPEC.widthMm.toLocaleString()} mm`, 'WIDTH'), pos: new THREE.Vector3(0, y, -L - 0.25) });
    // wheelbase on the right side
    const ba = new THREE.Vector3(-W - 0.2, y, DIM.rearAxleZ);
    const bb = new THREE.Vector3(-W - 0.2, y, DIM.frontAxleZ);
    seg(ba, bb);
    tick(ba, new THREE.Vector3(1, 0, 0));
    tick(bb, new THREE.Vector3(1, 0, 0));
    seg(new THREE.Vector3(-DIM.rearTrackHalf, y, DIM.rearAxleZ), ba);
    seg(new THREE.Vector3(-DIM.frontTrackHalf, y, DIM.frontAxleZ), bb);
    this.dimLabels.push({ el: this.label(`${GR_KART_SPEC.wheelbaseMm.toLocaleString()} mm`, 'WHEELBASE'), pos: new THREE.Vector3(-W - 0.2, y, 0) });
    // height at the front-left corner
    const ha = new THREE.Vector3(W + 0.25, 0, L + 0.15);
    const hb = new THREE.Vector3(W + 0.25, DIM.height, L + 0.15);
    seg(ha, hb);
    tick(hb, new THREE.Vector3(1, 0, 0));
    seg(new THREE.Vector3(0, DIM.height, 0.1), new THREE.Vector3(W + 0.25, DIM.height, L + 0.15));
    this.dimLabels.push({ el: this.label(`${GR_KART_SPEC.heightMm} mm`, 'HEIGHT'), pos: new THREE.Vector3(W + 0.25, DIM.height / 2, L + 0.15) });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(g, mat);
    lines.renderOrder = 10;
    this.dimGroup.add(lines);
    this.dimGroup.visible = false;
  }

  private label(v: string, name: string) {
    const el = document.createElement('div');
    el.className = 'dimlabel hidden';
    el.innerHTML = `${v}<small>${name}</small>`;
    return el;
  }

  // ------------------------------------------------------------- lifecycle
  enter() {
    this.ui.classList.remove('hidden');
    this.dimLabels.forEach((d) => this.ui.appendChild(d.el));
    this.controls.enabled = true;
    this.camera.position.set(3.4, 1.6, 3.8);
    this.controls.target.set(0, 0.3, 0);
    this.flyTo(new THREE.Vector3(2.5, 1.15, 2.7), new THREE.Vector3(0, 0.28, 0));
    this.resize();
  }

  exit() {
    this.ui.classList.add('hidden');
    this.controls.enabled = false;
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number) {
    this.time += dt;
    // explode/upright animation with easing
    this.explode = damp(this.explode, this.explodeTarget, 4, dt);
    this.upright = damp(this.upright, this.uprightTarget, 3, dt);
    const e = smoothstep(0, 1, this.explode);
    this.kart.setExplode(e);
    const u = smoothstep(0, 1, this.upright);
    const a = -u * Math.PI * 0.5;
    this.pivot.rotation.x = a;
    // keep the lowest point on the floor all the way up: the tyres, then the bumper
    let low = Infinity;
    for (const p of this.lowProfile) low = Math.min(low, p.y * Math.cos(a) - p.x * Math.sin(a));
    this.pivot.position.y = -low;
    (this.contact.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - u) * (1 - e * 0.6);
    this.dimGroup.visible = this.showDims && e < 0.05 && u < 0.05;

    // driver-fit demo sweeps the range once when focusing pedals/steering
    if (this.animateFit > 0) {
      this.animateFit = Math.max(0, this.animateFit - dt * 0.45);
      // down to 135 cm and back, then up to 185 cm and back
      const ph = (1 - this.animateFit) * Math.PI * 2;
      const b = this.fitBase;
      const cm = Math.round(ph < Math.PI ? b - (b - 135) * Math.sin(ph) : b + (185 - b) * Math.sin(ph - Math.PI));
      this.setHeight(cm);
      (this.ui.querySelector('.fit input') as HTMLInputElement).value = String(cm);
    }

    // idle wheel wiggle so the steering linkage is visible
    const wig = Math.sin(this.time * 0.9) * 0.25 * (this.active?.id === 'steering' ? 1 : 0.35);
    this.kart.update({ steerAngle: wig, speed: 0, throttle: 0.5 + 0.5 * Math.sin(this.time * 2), brake: 0, latG: 0, longG: 0, pitch: 0, roll: 0, rpm: 0 }, dt);

    // highlight pulse
    const pulse = 0.35 + 0.35 * Math.sin(this.time * 4);
    for (const h of this.highlighted) {
      const m = h.mesh.material as THREE.MeshStandardMaterial;
      if (m.emissive) m.emissiveIntensity = pulse;
    }

    // camera
    this.idle += dt;
    if (this.follow) {
      // the part may still be moving (dropping off the tail, reassembling), so keep aiming at it
      const a = this.anchorWorld(this.follow, this.tmp);
      if (this.tween) this.tween.t1.copy(a);
      else this.controls.target.copy(a);
    }
    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt * 0.9);
      const k = smoothstep(0, 1, this.tween.t);
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, k);
      this.controls.target.lerpVectors(this.tween.t0, this.tween.t1, k);
      if (this.tween.t >= 1) this.tween = null;
    }
    this.controls.autoRotate = this.idle > 8 && !this.tween;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.update(dt);

    this.projectOverlays();
  }

  private projectOverlays() {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    const center = new THREE.Vector3(0, 0.3, 0);
    const hideHotspots = this.upright > 0.1 || this.explode > 0.1 || this.dimGroup.visible;
    for (const h of this.hotspots) {
      const p = this.anchorWorld(h.f, this.tmp);
      const outward = p.clone().sub(center).setY(0).normalize();
      const facing = outward.dot(camDir);
      p.project(this.camera);
      const visible = !hideHotspots && p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      h.el.style.display = visible ? '' : 'none';
      h.el.style.left = `${(p.x * 0.5 + 0.5) * w}px`;
      h.el.style.top = `${(-p.y * 0.5 + 0.5) * hgt}px`;
      h.el.style.opacity = facing > 0.45 ? '0.25' : '1';
    }
    for (const d of this.dimLabels) {
      const p = d.pos.clone().project(this.camera);
      d.el.classList.toggle('hidden', !this.dimGroup.visible || p.z > 1);
      d.el.style.left = `${(p.x * 0.5 + 0.5) * w}px`;
      d.el.style.top = `${(-p.y * 0.5 + 0.5) * hgt}px`;
    }
  }

  dispose() {
    this.envRT.dispose();
  }
}

/** Lowest point of the kart (without the driver) per 5 mm slice along its length, as (z, y) in pivot space. */
function lowProfile(kart: KartModel, pivot: THREE.Object3D) {
  pivot.updateMatrixWorld(true);
  const toPivot = pivot.matrixWorld.clone().invert();
  const low = new Map<number, number>();
  const v = new THREE.Vector3();
  const mtx = new THREE.Matrix4();
  kart.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (kart.driver && isInside(m, kart.driver.group))) return;
    const pos = m.geometry.getAttribute('position');
    mtx.multiplyMatrices(toPivot, m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mtx);
      const k = Math.round(v.z / 0.005);
      const cur = low.get(k);
      if (cur === undefined || v.y < cur) low.set(k, v.y);
    }
  });
  return [...low].map(([k, y]) => new THREE.Vector2(k * 0.005, y));
}

function isInside(o: THREE.Object3D, group: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === group) return true;
  return false;
}
