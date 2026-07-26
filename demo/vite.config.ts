import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// Short commit hash, baked in at build time (static site → no runtime lookup). CI: GitHub sets
// GITHUB_SHA automatically. Local: the working-tree HEAD. Fallback: 'dev'.
function commitHash(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: { __COMMIT__: JSON.stringify(commitHash()) },
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      adapter: adapter({ fallback: '404.html' }),
      // GitHub Pages serves a project site under /<repo>/. CI sets BASE_PATH=/zaungast; dev = ''.
      paths: { base: (process.env.BASE_PATH || '') as '' | `/${string}` },
    }),
  ],
  // sqlite-wasm ships its own wasm glue; excluding it from Vite's dep pre-bundling keeps that intact.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
});
