// Builds one sunset from settings and drives its lighting through the timeline.
import * as THREE from 'three';
import { Astro, type SkyState } from './astro';
import { NIGHT_SKY, SUN_INTENSITY, buildTransmittanceTexture, luminance, skyRadiance, transmittance } from './atmosphere';
import { BirdSystem } from './birds';
import { CloudPass } from './cloudpass';
import { CIRRUS, makeClouds } from './clouds';
import { SWELL_PERIOD, type Settings, WAVE_HEIGHT, WIND_SEA } from './config';
import { Ocean, type SeaState, maxRunup } from './ocean';
import { makeRng, range } from './rng';
import { shared } from './shared';
import { SkyLUT, makeSkyDome } from './sky';
import { Terrain } from './terrain';

const EYE_HEIGHT = 1.7;

export class SunsetScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly astro: Astro;
  private terrain: Terrain;
  private ocean: Ocean;
  private cloudSpeed: number;
  /** 0..1: how much cloud there is to catch the low sun. */
  private cloudiness = 0;
  private birds: BirdSystem;
  private skyLUT: SkyLUT;
  private dome: ReturnType<typeof makeSkyDome>;
  private clouds: CloudPass;
  private transLUT: THREE.DataTexture;
  private mieScale: number;
  private pitch: number;
  private cameraSunVis = 1;
  private cameraHorizon: number;
  private moonOn: boolean;

  constructor(readonly settings: Settings) {
    const rng = makeRng(settings.seed);
    // Independent streams so changing one setting doesn't reshuffle everything else.
    const sub = (k: number) => makeRng((settings.seed * 2654435761 + k * 40503) >>> 0);

    this.astro = new Astro(sub(1), settings.moon);
    this.moonOn = settings.moon !== 'none';
    const sunset = this.astro.state(this.astro.progressAt(0)).sunDir;
    const sunAz = new THREE.Vector2(sunset.x, sunset.z).normalize();

    const wind = WIND_SEA[settings.wind];
    const sea: SeaState = {
      height: WAVE_HEIGHT[settings.waves],
      period: SWELL_PERIOD[settings.swell],
      windHeight: wind.height,
      whitecaps: wind.whitecaps,
    };
    this.cloudSpeed = wind.clouds;
    this.terrain = new Terrain(sub(2), sunAz, maxRunup(sea));
    const hazeK = this.terrain.haze;
    this.mieScale = 0.35 + hazeK * 0.3;
    shared.uHaze.value = 1.2e-5 * hazeK;
    shared.uFogHeight.value = range(rng, 700, 1400);

    this.transLUT = buildTransmittanceTexture(this.mieScale);
    shared.uTransLUT.value = this.transLUT;
    this.skyLUT = new SkyLUT();
    this.skyLUT.material.uniforms.uMieScale.value = this.mieScale;
    shared.uSkyLUT.value = this.skyLUT.target.texture;

    this.dome = makeSkyDome();
    this.dome.uniforms.uGalPole.value = this.astro.galacticPole;
    this.dome.uniforms.uStarSeed.value = (settings.seed % 997) * 0.37;
    this.dome.uniforms.uMoonOn.value = this.moonOn ? 1 : 0;
    this.scene.add(this.dome.mesh);
    this.scene.add(this.terrain.mesh);

    this.ocean = new Ocean(sub(6), this.terrain.shore, sea);
    this.scene.add(this.ocean.mesh);
    this.terrain.setSwash(this.ocean.swash);

    this.birds = new BirdSystem(sub(5), settings.birds);
    this.scene.add(this.birds.mesh);

    const eye = this.terrain.cameraGround + EYE_HEIGHT;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 200000);
    this.camera.position.set(0, eye, 0);
    this.pitch = range(rng, 0, 2.5);
    this.cameraHorizon = this.terrain.horizonAngle(0, eye, 0);
    this.dome.mesh.position.copy(this.camera.position);
    this.dome.uniforms.uCamAlt.value = Math.max(eye, 2) / 1000;
    this.skyLUT.material.uniforms.uCamAlt.value = Math.max(eye, 2) / 1000;

    const layers = makeClouds(settings.clouds, sub(3));
    this.cloudiness = layers.reduce((m, l) => Math.max(m, l.coverage * (l.type === CIRRUS ? 0.5 : 1)), 0);
    this.clouds = new CloudPass(layers, Math.max(eye, 2) / 1000, sunAz);
    shared.uClouds.value = this.clouds.target.texture;
    shared.uCloudVP.value = this.clouds.viewProj;
    shared.uCloudsOn.value = this.clouds.hasClouds ? 1 : 0;
  }

  setAspect(aspect: number) {
    const cam = this.camera;
    cam.aspect = aspect;
    // About a 50mm-lens view on wide screens (how sunset surf is usually seen in photos),
    // widening on tall screens to keep at least ~50° across.
    const minH = (50 * Math.PI) / 180;
    const vForH = (2 * Math.atan(Math.tan(minH / 2) / aspect) * 180) / Math.PI;
    cam.fov = Math.max(34, Math.min(vForH, 85));
    cam.rotation.set((this.pitch * Math.PI) / 180, 0, 0, 'YXZ');
    cam.updateProjectionMatrix();
    const pr = Math.min(devicePixelRatio, 1.5);
    this.clouds.configure(cam, window.innerWidth * pr, 0.5);
  }

  /** progress: timeline position; time: real seconds; dt: real seconds since last frame. */
  update(progress: number, time: number, dt: number) {
    const s = this.astro.state(progress);
    shared.uTime.value = time;
    shared.uSunDir.value.copy(s.sunDir);
    this.updateLight(s);
    this.dome.uniforms.uCelestial.value = s.celestial;
    shared.uMoonDir.value.copy(s.moonDir);
    const lit = 0.5 + 0.5 * s.moonDir.clone().negate().dot(s.moonLight);
    shared.uMoonBright.value = this.moonOn ? lit * THREE.MathUtils.smoothstep(s.moonDir.y, -0.01, 0.05) : 0;
    this.dome.uniforms.uMoonLight.value = s.moonLight;
    // Clouds drift and slowly change shape: faster than real time (it's a time-lapse,
    // after all), but never frantically.
    // Wind pushes the clouds along faster.
    this.clouds.update((time * 3 + progress * 500) * this.cloudSpeed);

    const daylight = THREE.MathUtils.smoothstep(Math.asin(s.sunDir.y), -0.14, -0.02);
    this.birds.update(dt, 0.15 + 0.85 * daylight);
  }

  private updateLight(s: SkyState) {
    const sun = s.sunDir;
    const elev = Math.asin(sun.y);
    const camKm = this.camera.position.y / 1000;

    const sunVis = THREE.MathUtils.smoothstep(elev, this.cameraHorizon - 0.004, this.cameraHorizon + 0.006);
    this.cameraSunVis = sunVis;
    const T = transmittance(camKm, Math.max(elev, -0.2), this.mieScale, 24);
    shared.uSunColor.value.set(T[0], T[1], T[2]).multiplyScalar(SUN_INTENSITY);
    this.ocean.setSunVisibility(sunVis);

    // Ambient light from a handful of sky samples.
    const az = Math.atan2(sun.x, -sun.z);
    const dirAt = (a: number, e: number) => new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
    const sample = (a: number, e: number) => skyRadiance(dirAt(a, e), sun, this.mieScale, camKm, 16);
    const zen = sample(0, Math.PI / 2);
    const h = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((o) => sample(az + o, 0.12));
    const m = [0, Math.PI].map((o) => sample(az + o, 0.6));
    const avg = (arr: number[][], c: number) => arr.reduce((t, v) => t + v[c], 0) / arr.length;
    const top = new THREE.Vector3();
    const side = new THREE.Vector3();
    const groundAlbedo = 0.18;
    for (let c = 0; c < 3; c++) {
      const hz = avg(h, c);
      const mid = avg(m, c);
      const sunC = shared.uSunColor.value.getComponent(c) * sunVis;
      const t = Math.PI * (0.35 * zen[c] + 0.35 * mid + 0.3 * hz) + NIGHT_SKY[c] * Math.PI;
      const bounce = groundAlbedo * (sunC * Math.max(sun.y, 0) + t) * 0.5;
      top.setComponent(c, t);
      side.setComponent(c, Math.PI * 0.5 * (0.7 * hz + 0.3 * mid) + bounce + NIGHT_SKY[c] * Math.PI * 0.5);
    }
    if (this.moonOn && s.moonDir.y > -0.02) {
      const lit = 0.5 + 0.5 * s.moonDir.clone().negate().dot(s.moonLight);
      const moon = new THREE.Vector3(0.85, 0.9, 1.0).multiplyScalar(0.0012 * lit * THREE.MathUtils.smoothstep(s.moonDir.y, -0.02, 0.15));
      top.add(moon);
      side.add(moon.multiplyScalar(0.6));
    }
    shared.uAmbTop.value.copy(top);
    shared.uAmbSide.value.copy(side);

    // Exposure follows the brightness of the sky, but only partly: night should feel dark.
    // Weighted toward the sunward sky, which dominates the view.
    const mixL = (c: number) => 0.25 * zen[c] + 0.4 * h[0][c] + 0.15 * m[0][c] + 0.2 * avg(h, c);
    const skyL = luminance([mixL(0), mixL(1), mixL(2)]) + luminance(NIGHT_SKY);
    // Clouds right by a low sun glow far brighter than the clear sky the samples see.
    const glow = THREE.MathUtils.smoothstep(elev, -0.06, 0.0) * (1 - THREE.MathUtils.smoothstep(elev, 0.06, 0.14));
    // While the sun is still up, its path on the sea dominates the frame; hold exposure back.
    const highSun = 1 - 0.45 * THREE.MathUtils.smoothstep(elev, 0.02, 0.14);
    shared.uExposure.value = (Math.min(0.55 * Math.pow(skyL, -0.72), 160) * highSun) / (1 + 1.6 * this.cloudiness * glow);
  }

  render(renderer: THREE.WebGLRenderer) {
    this.skyLUT.render(renderer);
    this.clouds.render(renderer);
  }

  /** Approximate sun elevation in degrees (for UI). */
  sunElevationDeg(progress: number) {
    return (Math.asin(this.astro.state(progress).sunDir.y) * 180) / Math.PI;
  }

  get sunVisible() {
    return this.cameraSunVis;
  }

  dispose() {
    this.terrain.dispose();
    this.ocean.dispose();
    this.birds.dispose();
    this.skyLUT.target.dispose();
    this.clouds.dispose();
    (this.dome.mesh.material as THREE.Material).dispose();
    this.dome.mesh.geometry.dispose();
    this.transLUT.dispose();
  }
}

