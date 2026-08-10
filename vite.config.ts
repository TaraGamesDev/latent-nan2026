import { defineConfig } from 'vite';

// Built output goes to docs/ so GitHub Pages can serve it straight off the
// default branch with no Actions workflow and no gh-pages branch to drift.
// base './' keeps every asset path relative, which is what Pages needs when
// the site is served from /<repo>/ rather than the domain root.
export default defineConfig({
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    host: true,
  },
});
