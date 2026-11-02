// DOM for the setup panel, playback controls, captions and toasts.
import {
  BIRDS, CLOUDS, MOONS, PACES, SWELLS, WAVES, WINDS, type Option, type Settings,
} from './config';

const ICONS = {
  dice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>',
  again: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
};

export interface UIHandlers {
  onChange: (s: Settings) => void;
  onReroll: () => void;
  onSurprise: () => void;
  onGo: () => void;
  onTogglePause: () => void;
  onAgain: () => void;
  onSettings: () => void;
  onShare: () => void;
  onScrub: (p: number) => void;
}

type Key = keyof Omit<Settings, 'seed'>;

export class UI {
  private panel: HTMLElement;
  private hud: HTMLElement;
  private caption: HTMLElement;
  private toastEl: HTMLElement;
  private veil: HTMLElement;
  private slider: HTMLInputElement;
  private phaseLabel: HTMLElement;
  private timeLabel: HTMLElement;
  private pauseBtn: HTMLButtonElement;
  private cta: HTMLButtonElement;
  private groups = new Map<Key, HTMLElement>();
  private idleTimer = 0;
  private captionTimer = 0;
  private toastTimer = 0;
  playing = false;

  constructor(root: HTMLElement, private settings: Settings, private h: UIHandlers) {
    this.veil = el('div', 'veil');
    this.panel = el('section', 'panel');
    this.panel.setAttribute('aria-label', 'Set the scene');
    this.panel.innerHTML = `
      <header>
        <h1>Sunsets</h1>
        <p class="tagline">The scene is set: press play, or change it first.</p>
      </header>
      <div class="options"></div>
      <footer>
        <button class="btn icon" data-act="reroll" title="New variation of this scene" aria-label="New variation">${ICONS.dice}</button>
        <button class="btn icon" data-act="surprise" title="Surprise me" aria-label="Surprise me">${ICONS.sparkle}</button>
        <button class="btn go" data-act="go">${ICONS.play}<span>Watch the sunset</span></button>
      </footer>`;
    const opts = this.panel.querySelector('.options') as HTMLElement;
    this.addGroup(opts, 'Waves', 'waves', WAVES, true);
    this.addGroup(opts, 'Swell', 'swell', SWELLS, true);
    this.addGroup(opts, 'Wind', 'wind', WINDS, true);
    this.addGroup(opts, 'Clouds', 'clouds', CLOUDS, true);
    this.addGroup(opts, 'Birds', 'birds', BIRDS);
    this.addGroup(opts, 'Moon', 'moon', MOONS);
    this.addGroup(opts, 'Pace', 'pace', PACES, true);

    this.panel.querySelector('[data-act=reroll]')!.addEventListener('click', () => h.onReroll());
    this.panel.querySelector('[data-act=surprise]')!.addEventListener('click', () => h.onSurprise());
    this.panel.querySelector('[data-act=go]')!.addEventListener('click', () => h.onGo());

    // A big play button over the scene itself, so it's obvious the settings are optional.
    this.cta = document.createElement('button');
    this.cta.className = 'cta';
    this.cta.innerHTML = `<span class="ring">${ICONS.play}</span><span class="label">Watch the sunset</span>`;
    this.cta.addEventListener('click', () => h.onGo());

    this.hud = el('div', 'hud hidden');
    this.hud.innerHTML = `
      <button data-act="pause" aria-label="Pause">${ICONS.pause}</button>
      <div class="time">
        <div class="label"><b class="phase">Golden hour</b><span class="sun"></span></div>
        <input type="range" min="0" max="1" step="0.0005" value="0" aria-label="Time" />
      </div>
      <button data-act="again" title="Another sunset, same settings" aria-label="Another sunset">${ICONS.again}</button>
      <button data-act="settings" title="Change the scene" aria-label="Change the scene">${ICONS.settings}</button>
      <button data-act="share" title="Copy a link to this sunset" aria-label="Copy link">${ICONS.share}</button>
      <button data-act="full" title="Fullscreen" aria-label="Fullscreen">${ICONS.full}</button>`;
    this.pauseBtn = this.hud.querySelector('[data-act=pause]') as HTMLButtonElement;
    this.slider = this.hud.querySelector('input') as HTMLInputElement;
    this.phaseLabel = this.hud.querySelector('.phase') as HTMLElement;
    this.timeLabel = this.hud.querySelector('.sun') as HTMLElement;
    this.pauseBtn.addEventListener('click', () => h.onTogglePause());
    this.hud.querySelector('[data-act=again]')!.addEventListener('click', () => h.onAgain());
    this.hud.querySelector('[data-act=settings]')!.addEventListener('click', () => h.onSettings());
    this.hud.querySelector('[data-act=share]')!.addEventListener('click', () => h.onShare());
    this.hud.querySelector('[data-act=full]')!.addEventListener('click', () => toggleFullscreen());
    this.slider.addEventListener('input', () => h.onScrub(Number(this.slider.value)));

    this.caption = el('div', 'caption');
    this.toastEl = el('div', 'toast');
    this.toastEl.setAttribute('role', 'status');
    root.append(this.veil, this.caption, this.cta, this.panel, this.hud, this.toastEl);

    const wake = () => this.wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', (e) => {
      if (!this.playing) {
        // Enter starts the sunset from the setup screen (unless it's activating a button).
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !this.panel.inert) h.onGo();
        return;
      }
      if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        h.onTogglePause();
      } else if (e.key === 'f') toggleFullscreen();
      else if (e.key === 'r') h.onAgain();
      else if (e.key === 'Escape' && !document.fullscreenElement) h.onSettings();
      wake();
    });
  }

  private addGroup(parent: HTMLElement, title: string, key: Key, options: Option<string>[], cards = false) {
    const g = el('div', 'group');
    const id = `g-${key}`;
    g.innerHTML = `<h2 id="${id}">${title}</h2>`;
    const chips = el('div', cards ? 'chips cards' : 'chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-labelledby', id);
    for (const o of options) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.value = o.value;
      b.innerHTML = cards && o.hint ? `${o.label}<small>${o.hint}</small>` : o.label;
      b.addEventListener('click', () => {
        this.settings = { ...this.settings, [key]: o.value };
        this.sync(this.settings);
        this.h.onChange(this.settings);
      });
      chips.append(b);
    }
    g.append(chips);
    parent.append(g);
    this.groups.set(key, chips);
  }

  sync(s: Settings) {
    this.settings = s;
    for (const [key, chips] of this.groups) {
      for (const b of chips.querySelectorAll<HTMLButtonElement>('.chip')) {
        b.setAttribute('aria-pressed', String(b.dataset.value === s[key]));
      }
    }
  }

  showSetup() {
    this.playing = false;
    this.panel.classList.remove('hidden');
    this.panel.inert = false;
    this.cta.classList.remove('hidden');
    this.hud.classList.add('hidden');
    document.body.classList.remove('idle');
    window.clearTimeout(this.idleTimer);
  }

  showPlayback() {
    this.playing = true;
    this.panel.classList.add('hidden');
    this.panel.inert = true;
    this.cta.classList.add('hidden');
    this.wake();
  }

  hideAll() {
    this.panel.classList.add('hidden');
    this.panel.inert = true;
    this.cta.classList.add('hidden');
    this.hud.classList.add('hidden');
  }

  private wake() {
    if (!this.playing) return;
    this.hud.classList.remove('hidden');
    document.body.classList.remove('idle');
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (!this.playing || this.hud.matches(':hover') || this.hud.contains(document.activeElement)) return this.wake();
      this.hud.classList.add('hidden');
      document.body.classList.add('idle');
    }, 3200);
  }

  setPaused(paused: boolean) {
    this.pauseBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
    this.pauseBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }

  setTime(progress: number, phase: string, sunDeg: number) {
    if (document.activeElement !== this.slider) this.slider.value = String(Math.min(progress, 1));
    this.phaseLabel.textContent = phase;
    this.timeLabel.textContent = `sun ${sunDeg >= 0 ? '+' : '−'}${Math.abs(sunDeg).toFixed(1)}°`;
  }

  showCaption(text: string) {
    this.caption.textContent = text;
    this.caption.classList.add('show');
    window.clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => this.caption.classList.remove('show'), 4200);
  }

  toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  fade(clear: boolean) {
    this.veil.classList.toggle('clear', clear);
  }
}

function el(tag: string, cls: string) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}
