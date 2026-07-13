// Dev-only: rasterize the SVG brand assets to PNG with @resvg/resvg-js.
// Usage: npm run assets
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const jobs = [
  { src: 'assets/logo.svg', out: 'assets/logo.png', width: 512 },
  { src: 'assets/logo.svg', out: 'assets/logo-1024.png', width: 1024 },
  { src: '.github/social-preview.svg', out: '.github/social-preview.png', width: 1280 },
]

for (const { src, out, width } of jobs) {
  const svg = await readFile(path.join(root, src), 'utf8')
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true },
    background: 'rgba(0,0,0,0)',
  })
  const rendered = resvg.render()
  await writeFile(path.join(root, out), rendered.asPng())
  console.log(`${out}: ${rendered.width}x${rendered.height}`)
}
