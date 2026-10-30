import './style.css';
import * as THREE from 'three';
import {
  BIRDS, DEFAULT_SETTINGS, MOONS, PACE_SECONDS, SWELLS, WAVES, WINDS, type CloudStyle, type Settings,
  settingsFromQuery, settingsToQuery,
} from './config';
import { Post } from './post';
import { makeRng, pick, randomSeed } from './rng';
import { SunsetScene } from './scene';
import { UI } from './ui';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const root = document.getElementById('ui') as HTMLElement;

function phaseName(sunDeg: number): string {
  if (sunDeg > 5) return 'Golden hour';
  if (sunDeg > -0.9) return 'Sunset';
  if (sunDeg > -5) return 'Afterglow';
  if (sunDeg > -11) return 'Blue hour';
  if (sunDeg > -17.5) return 'Last light';
  return 'Night';
}

function surprise(current: Settings): Settings {
  const rng = makeRng(randomSeed());
  const clouds: CloudStyle = pick(rng, ['clear', 'wispy', 'wispy', 'puffy', 'mackerel', 'mackerel', 'dramatic', 'dramatic', 'moody'] as const);
  return {
    ...current,
    waves: pick(rng, WAVES).value,
    swell: pick(rng, SWELLS).value,
    wind: pick(rng, WINDS).value,
    clouds,
    birds: pick(rng, BIRDS).value,
    moon: pick(rng, MOONS).value,
    seed: randomSeed(),
  };
}

function start() {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    root.innerHTML = '<div class="webgl-error">This sunset needs WebGL 2, which this browser doesn’t seem to offer.</div>';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const params = new URLSearchParams(location.search);
  const fixedT = params.has('t') ? Number(params.get('t')) : null;
  let settings = settingsFromQuery(location.search, { ...DEFAULT_SETTINGS, seed: randomSeed() });

  let world = new SunsetScene(settings);
  const post = new Post(renderer, world.scene, world.camera);

  let mode: 'setup' | 'play' = 'setup';
  let progress = 0;
  let paused = false;
  let lastPhase = '';
  let rebuildTimer = 0;

  const writeUrl = () => history.replaceState(null, '', `${location.pathname}?${settingsToQuery(settings)}`);

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    post.setSize(w, h);
    world.setAspect(w / h);
  };

  const rebuild = (next: Settings) => {
    settings = next;
    world.dispose();
    world = new SunsetScene(settings);
    post.setScene(world.scene, world.camera);
    resize();
    writeUrl();
    ui.sync(settings);
  };

  /** Fade to dark, rebuild, fade back in. */
  const transition = (next: Settings, then?: () => void) => {
    ui.fade(false);
    window.setTimeout(() => {
      rebuild(next);
      then?.();
      requestAnimationFrame(() => ui.fade(true));
    }, 700);
  };

  const ui = new UI(root, settings, {
    onChange: (s) => {
      settings = s;
      window.clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => rebuild(settings), 90);
    },
    onReroll: () => transition({ ...settings, seed: randomSeed() }),
    onSurprise: () => transition(surprise(settings)),
    onGo: () => {
      mode = 'play';
      progress = 0;
      paused = false;
      lastPhase = '';
      ui.setPaused(false);
      ui.showPlayback();
    },
    onTogglePause: () => {
      paused = !paused;
      ui.setPaused(paused);
    },
    onAgain: () =>
      transition({ ...settings, seed: randomSeed() }, () => {
        progress = 0;
        paused = false;
        lastPhase = '';
        ui.setPaused(false);
      }),
    onSettings: () => {
      mode = 'setup';
      progress = 0;
      ui.showSetup();
    },
    onShare: () => {
      writeUrl();
      navigator.clipboard?.writeText(location.href).then(
        () => ui.toast('Link copied. It will make this exact sunset.'),
        () => ui.toast('Couldn’t copy. The address bar has the link.'),
      );
    },
    onScrub: (p) => {
      progress = p;
      lastPhase = phaseName(world.sunElevationDeg(p));
    },
  });
  ui.sync(settings);
  writeUrl();

  if (fixedT !== null && Number.isFinite(fixedT)) {
    // Debug/screenshot mode: ?t=0.5 shows that moment, paused, with no UI.
    mode = 'play';
    progress = fixedT;
    paused = true;
    ui.hideAll();
  }

  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  let time = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;
    if (mode === 'play' && !paused) {
      progress = Math.min(progress + dt / PACE_SECONDS[settings.pace], 1.3);
    }
    world.update(progress, time, dt);
    if (fixedT !== null) (window as unknown as { world: SunsetScene }).world = world;
    world.render(renderer);
    post.render(time);

    const sunDeg = world.sunElevationDeg(progress);
    const phase = phaseName(sunDeg);
    if (mode === 'play') {
      ui.setTime(progress, phase, sunDeg);
      if (phase !== lastPhase && fixedT === null) {
        if (lastPhase) ui.showCaption(phase);
        lastPhase = phase;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
    requestAnimationFrame(() => ui.fade(true));
  });
}

start();
