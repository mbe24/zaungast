// Optional local static server for the POC (correct application/wasm mime; needed for Workers + module
// loading + wasm fetch, which don't work over file://). Run: node poc/serve.mjs → http://localhost:5599
// In production the same poc/dist/ is served by any static host (e.g. GitHub Pages).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('./dist', import.meta.url));
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
http
  .createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(dist, rel === '/' ? 'index.html' : rel);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  })
  .listen(5599, () => console.log('POC at http://localhost:5599  (Ctrl+C to stop)'));
