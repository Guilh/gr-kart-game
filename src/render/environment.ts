import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { TimeOfDay } from '../core/settings';

// Physically-based sky (Preetham + procedural clouds), sun with a shadow
// frustum that follows the action, and an environment map baked from the sky.

interface TODPreset {
  elevation: number; // degrees
  azimuth: number; // degrees
  turbidity: number;
  rayleigh: number;
  mie: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  fog: number;
  fogDensity: number;
  exposure: number;
  clouds: number;
}

const PRESETS: Record<TimeOfDay, TODPreset> = {
  morning: {
    elevation: 16,
    azimuth: 70,
    turbidity: 2.6,
    rayleigh: 1.1,
    mie: 0.0025,
    sunColor: 0xffe2c0,
    sunIntensity: 2.6,
    hemiSky: 0xbfd8ff,
    hemiGround: 0x5a6b3f,
    hemiIntensity: 0.55,
    fog: 0xbfd0e2,
    fogDensity: 0.0007,
    exposure: 0.85,
    clouds: 0.35,
  },
  noon: {
    elevation: 62,
    azimuth: 12,
    turbidity: 2.2,
    rayleigh: 0.9,
    mie: 0.002,
    sunColor: 0xfff6ea,
    sunIntensity: 3.1,
    hemiSky: 0xcfe4ff,
    hemiGround: 0x5f6f40,
    hemiIntensity: 0.6,
    fog: 0xbdd2e6,
    fogDensity: 0.0006,
    exposure: 0.68,
    clouds: 0.3,
  },
  afternoon: {
    elevation: 30,
    azimuth: 322,
    turbidity: 2.4,
    rayleigh: 1.15,
    mie: 0.0022,
    sunColor: 0xfff0dc,
    sunIntensity: 2.9,
    hemiSky: 0xc8dcff,
    hemiGround: 0x5f6b3c,
    hemiIntensity: 0.55,
    fog: 0xb9cde2,
    fogDensity: 0.00065,
    exposure: 0.72,
    clouds: 0.38,
  },
  golden: {
    elevation: 6.5,
    azimuth: 250,
    turbidity: 6,
    rayleigh: 2.2,
    mie: 0.006,
    sunColor: 0xffb070,
    sunIntensity: 2.6,
    hemiSky: 0xa9b8e0,
    hemiGround: 0x5b4a33,
    hemiIntensity: 0.45,
    fog: 0xd9bfa6,
    fogDensity: 0.0009,
    exposure: 0.92,
    clouds: 0.42,
  },
};

export class Environment {
  sky = new Sky();
  sun = new THREE.DirectionalLight(0xffffff, 3);
  hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
  sunDir = new THREE.Vector3();
  fog = new THREE.FogExp2(0xcccccc, 0.001);
  preset!: TODPreset;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private shadowSize = 2048;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    this.sky.scale.setScalar(12000);
    this.sky.name = 'sky';
    scene.add(this.sky);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    const cam = this.sun.shadow.camera;
    cam.left = -36;
    cam.right = 36;
    cam.top = 36;
    cam.bottom = -36;
    cam.near = 1;
    cam.far = 260;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  setShadowQuality(size: number) {
    if (size === this.shadowSize && this.sun.shadow.map) return;
    this.shadowSize = size;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
  }

  apply(tod: TimeOfDay) {
    const p = PRESETS[tod];
    this.preset = p;
    const phi = THREE.MathUtils.degToRad(90 - p.elevation);
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mie;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(this.sunDir);
    if (u.cloudCoverage) {
      u.cloudCoverage.value = p.clouds;
      u.cloudDensity.value = 0.45;
      u.cloudScale.value = 0.00022;
      u.cloudElevation.value = 0.55;
    }
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.fog.color.setHex(p.fog);
    this.fog.density = p.fogDensity;
    this.renderer.toneMappingExposure = p.exposure;
    this.bakeEnvironment();
  }

  /** Renders the sky alone into a PMREM cube for image-based lighting. */
  bakeEnvironment() {
    const envScene = new THREE.Scene();
    const sky2 = new Sky();
    sky2.scale.setScalar(1000);
    const u2 = sky2.material.uniforms;
    const u = this.sky.material.uniforms;
    for (const k of Object.keys(u)) {
      if (u2[k] && u[k].value !== undefined) {
        const v = u[k].value;
        u2[k].value = v && typeof v.clone === 'function' ? v.clone() : v;
      }
    }
    if (u2.showSunDisc) u2.showSunDisc.value = 0;
    envScene.add(sky2);
    // soft ground bounce so undersides aren't pitch black
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(this.preset.hemiGround).multiplyScalar(0.6) }),
    );
    ground.position.y = -5;
    envScene.add(ground);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0.02, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.85;
    sky2.geometry.dispose();
    sky2.material.dispose();
  }

  /** Keep the shadow frustum centred on the focus point (texel-snapped). */
  follow(focus: THREE.Vector3) {
    const d = 120;
    const cam = this.sun.shadow.camera;
    const texel = (cam.right - cam.left) / this.shadowSize;
    // snap in light space to avoid shimmering
    const lightDir = this.sunDir;
    const up = Math.abs(lightDir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, lightDir).normalize();
    const up2 = new THREE.Vector3().crossVectors(lightDir, right).normalize();
    const a = Math.round(focus.dot(right) / texel) * texel;
    const b = Math.round(focus.dot(up2) / texel) * texel;
    const c = focus.dot(lightDir);
    const snapped = right.multiplyScalar(a).add(up2.multiplyScalar(b)).add(lightDir.clone().multiplyScalar(c));
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(this.sunDir, d);
    this.sun.target.updateMatrixWorld();
  }

  update(time: number) {
    const u = this.sky.material.uniforms;
    if (u.time) u.time.value = time;
  }
}
