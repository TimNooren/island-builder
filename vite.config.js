import { defineConfig } from 'vite';

// Relative base so the built assets resolve under GitHub Pages
// (https://<user>.github.io/island-builder/) and local `vite preview`.
export default defineConfig({
  base: './',
});
