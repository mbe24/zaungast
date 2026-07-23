// Client-only app: it reads the user's local Teams cache in the browser, so no server rendering
// (ssr=false). prerender=true bakes each route to a static HTML shell that hydrates client-side (a real
// index.html for GitHub Pages); the adapter's 404.html fallback covers deep links / client-only routes.
export const ssr = false;
export const prerender = true;
