// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  // Baked in by vite.config.ts `define` — the short commit hash (or 'dev' locally). MUST live inside
  // `declare global` because this file is a module (`export {}` below) — a top-level `declare const`
  // would be module-scoped, not visible to +layout.svelte.
  const __COMMIT__: string;

  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
