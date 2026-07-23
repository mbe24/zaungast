import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: '404.html' }),
			// GitHub Pages serves a project site under /<repo>/. CI sets BASE_PATH=/zaungast; dev = ''.
			paths: { base: process.env.BASE_PATH || '' }
		})
	],
	// sqlite-wasm ships its own wasm glue; excluding it from Vite's dep pre-bundling keeps that intact.
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] }
});
