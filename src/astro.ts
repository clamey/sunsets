// Sky geometry: where the sun, moon and stars are at a point in the sunset.
// Scene frame: y up, camera looks down -z (roughly toward where the sun sets).
// Astronomical frame: x east, y up, z south.
import * as THREE from 'three';
import type { Moon } from './config';
import { type Rng, range } from './rng';

const DEG = Math.PI / 180;

export const START_ELEV = 8 * DEG;
export const END_ELEV = -18 * DEG;

export interface SkyState {
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** Direction sunlight arrives at the moon from, as seen on the sky (for the phase). */
  moonLight: THREE.Vector3;
  /** Maps a scene direction to fixed celestial coordinates (for stars). */
  celestial: THREE.Matrix3;
}

export class Astro {
  readonly latitude: number;
  readonly declination: number;
  private yaw: THREE.Matrix4;
  private h0: number;
  private h1: number;
  private moonElongation: number;
  private moonDecOffset: number;
  private phaseAngle: number;
  readonly galacticPole = new THREE.Vector3();

  constructor(rng: Rng, moon: Moon) {
    this.latitude = range(rng, 24, 45) * DEG;
    this.declination = range(rng, -18, 23) * DEG;
    this.h0 = this.hourAngleAt(START_ELEV);
    this.h1 = this.hourAngleAt(END_ELEV);

    // Turn the world so the sunset point sits a little off-centre in view.
    const set = this.astroDir(this.hourAngleAt(0), this.declination);
    const from = Math.atan2(set.x, -set.z);
    const to = range(rng, -9, 9) * DEG;
    this.yaw = new THREE.Matrix4().makeRotationY(from - to);

    // Moon: always placed east of the sun so it is in view after sunset. Only a crescent
    // is astronomically honest here; half and full take some artistic license.
    this.moonElongation = range(rng, 20, 34) * DEG;
    this.moonDecOffset = range(rng, -2, 7) * DEG;
    this.phaseAngle = moon === 'crescent' ? range(rng, 118, 140) * DEG : moon === 'half' ? 90 * DEG : 6 * DEG;

    // A Milky Way band that crosses the western sky at nightfall.
    const s = this.state(1.1);
    const look = new THREE.Vector3(range(rng, -0.3, 0.3), 0.55, -1).normalize().applyMatrix3(s.celestial);
    const other = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    this.galacticPole.crossVectors(look, other).normalize();
  }

  private hourAngleAt(elev: number): number {
    const phi = this.latitude;
    const d = this.declination;
    const c = (Math.sin(elev) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d));
    return Math.acos(Math.max(-1, Math.min(1, c)));
  }

  /** Direction in the astronomical frame for hour angle H and declination d. */
  private astroDir(H: number, d: number): THREE.Vector3 {
    const phi = this.latitude;
    const M = new THREE.Vector3(0, Math.cos(phi), Math.sin(phi));
    const W = new THREE.Vector3(-1, 0, 0);
    const P = new THREE.Vector3(0, Math.sin(phi), -Math.cos(phi));
    return M.multiplyScalar(Math.cos(d) * Math.cos(H))
      .addScaledVector(W, Math.cos(d) * Math.sin(H))
      .addScaledVector(P, Math.sin(d));
  }

  /** p = 0 is golden hour (sun at +8°), p = 1 is astronomical night (−18°). */
  state(p: number): SkyState {
    const Hs = this.h0 + p * (this.h1 - this.h0);
    const sunDir = this.astroDir(Hs, this.declination).applyMatrix4(this.yaw).normalize();
    const moonDir = this.astroDir(Hs - this.moonElongation, this.declination + this.moonDecOffset)
      .applyMatrix4(this.yaw)
      .normalize();

    const toSun = sunDir.clone().addScaledVector(moonDir, -sunDir.dot(moonDir)).normalize();
    const toViewer = moonDir.clone().negate();
    const moonLight = toSun.multiplyScalar(Math.sin(this.phaseAngle)).addScaledVector(toViewer, Math.cos(this.phaseAngle));

    // scene -> astro (inverse yaw) -> hour-angle frame -> fixed celestial frame.
    const phi = this.latitude;
    const basis = new THREE.Matrix3().set(
      0, Math.cos(phi), Math.sin(phi),
      -1, 0, 0,
      0, Math.sin(phi), -Math.cos(phi),
    );
    const unyaw = new THREE.Matrix3().setFromMatrix4(this.yaw).transpose();
    const c = Math.cos(Hs);
    const s = Math.sin(Hs);
    const spin = new THREE.Matrix3().set(c, s, 0, -s, c, 0, 0, 0, 1);
    const celestial = spin.multiply(basis).multiply(unyaw);
    return { sunDir, moonDir, moonLight, celestial };
  }

  /** Inverse of the timeline: progress at which the sun reaches an elevation. */
  progressAt(elev: number): number {
    return (this.hourAngleAt(elev) - this.h0) / (this.h1 - this.h0);
  }
}
