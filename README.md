# Sunsets

A calm, customizable sunset over the sea. Choose the waves, swell, wind, clouds, birds, moon and pace, press **Watch the sunset**, and watch golden hour fade through blue hour into a starry night. Every play is generated from a seed, so each one is different, and the share link recreates the exact sunset.

## How it works

Everything is procedural and rendered with Three.js (WebGL 2). Nothing is downloaded but the code.

| Piece | File | Approach |
|---|---|---|
| Sky | `src/sky.ts`, `src/atmosphere.ts` | Physically based Rayleigh/Mie/ozone scattering, recomputed every frame into a small lookup table. Sunset colours come from the physics, not hand-made gradients. |
| Clouds | `src/clouds.ts`, `src/cloudpass.ts`, `src/noise.ts` | Volumetric cumulus, altocumulus and stratus raymarched at reduced resolution (plus thin cirrus sheets), lit by sunlight filtered through the atmosphere at their altitude, so undersides glow after the ground is in shadow. They drift with the wind and slowly change shape. |
| Sun, moon, stars | `src/astro.ts` | Real sun path for a seeded latitude/season, atmospheric refraction, moon phases, procedural stars and Milky Way that rotate with the sky. |
| Beach | `src/terrain.ts` | An equilibrium (Dean) beach profile with a curving shoreline, dunes, a headland, wet sand that mirrors the sky where the swash just receded. |
| Ocean | `src/ocean.ts` | Swell trains refracted over the seabed (Snell's law plus shoaling, precomputed per component), which steepen, lean forward and break where they get too tall for the depth; wind chop; whitewater that forms at the break and trails shoreward; a thin swash film running up the sand; sky, cloud, sun and moon reflections per wave facet; light glowing through backlit crests. |
| Birds | `src/birds.ts` | Flocks in V formation, loose flocks and lone gliders. |
| Finish | `src/post.ts` | Bloom, ACES tone mapping, vignette and dithering. |

## Develop

```sh
npm install
npm run dev
```

Add `&t=0.4` to a URL to freeze the scene at that point in the sunset (0 = golden hour, 1 = night) with the UI hidden. Handy for screenshots.

Keys while watching: <kbd>Space</kbd> pause, <kbd>F</kbd> fullscreen, <kbd>R</kbd> another sunset, <kbd>Esc</kbd> back to the scene setup.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which typechecks, builds and publishes `dist/` to GitHub Pages. One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**. The Vite `base` is relative, so the site works at `https://<user>.github.io/sunsets/` without changes.
