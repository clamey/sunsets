import { defineConfig } from 'vite';

// Relative base so the build works at any GitHub Pages path (e.g. /sunsets/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
});
