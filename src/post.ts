// HDR render -> bloom -> filmic tone map, vignette and dithering (no banding in gradients).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;

    // ACES fitted (Stephen Hill).
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 c) {
      const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
      const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
      return clamp(outM * RRTAndODTFit(inM * c), 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 q = vUv - 0.5;
      q.x *= uResolution.x / uResolution.y;
      c *= 1.0 - 0.28 * dot(q, q);
      c = toSRGB(aces(c * 1.1));
      vec2 px = vUv * uResolution;
      float n = hash(px + fract(uTime) * 61.0) + hash(px * 1.37 - fract(uTime) * 17.0) - 1.0;
      c += n / 255.0;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export class Post {
  readonly composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private final: ShaderPass;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.45, 1.6);
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.final);
  }

  setScene(scene: THREE.Scene, camera: THREE.Camera) {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    (this.final.uniforms.uResolution.value as THREE.Vector2).set(w * pr, h * pr);
  }

  render(time: number) {
    this.final.uniforms.uTime.value = time;
    this.composer.render();
  }
}
