// SPA mode: the app is fully client-side (it reads the user's local Teams cache in the browser), so
// there's no server rendering. adapter-static emits a 200.html fallback that hydrates on any route.
export const ssr = false;
export const prerender = false;
