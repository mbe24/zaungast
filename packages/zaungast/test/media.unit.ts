// Unit tests for get_attachments' building blocks: attachment-reference parsing (media/refs.ts) and
// the Chromium blockfile HTTP-cache reader (media/httpCache.ts), against synthetic cache dirs.
// Run: npx vitest run packages/zaungast/test/media.unit.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, afterAll } from 'vitest';
import { attachmentRefs, cardRefs, imageRefs } from 'zaungast/media/refs.js';
import { HttpCache, sniffImage } from 'zaungast/media/httpCache.js';

const AMS = '0-weu-d7-0123456789abcdef0123456789abcdef';

test('imageRefs: AMS image, emoji skipped, entities decoded', () => {
  const html =
    `<p>ciao <img itemtype="http://schema.skype.com/Emoji" itemid="smile" src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/emoticons/smile/default/20_f.png" alt="🙂"></p>` +
    `<p><img itemtype="http://schema.skype.com/AMSImage" itemid="${AMS}" src="https://us-api.asm.skype.com/v1/objects/${AMS}/views/imgo" alt="perch&egrave; &amp; &#8364;" width="735.29" height="250" /></p>` +
    `<p><img src="https://eu-api.asm.skype.com/v1/objects/${AMS}/views/imgo"></p>`; // duplicate
  const refs = imageRefs(html);
  expect(refs).toHaveLength(1);
  expect(refs[0]).toMatchObject({ objectId: AMS, alt: 'perchè & €', width: 735, height: 250 });
});

test('attachmentRefs: files from properties.files JSON', () => {
  const files = JSON.stringify([
    { fileName: 'DDT.pdf', fileType: 'pdf', fileInfo: { shareUrl: 'https://x.sharepoint.com/s' } },
  ]);
  const refs = attachmentRefs('<p>no images</p>', files);
  expect(refs).toEqual([
    { kind: 'file', name: 'DDT.pdf', type: 'pdf', url: 'https://x.sharepoint.com/s' },
  ]);
  expect(attachmentRefs('', '[]', '[]')).toEqual([]);
  expect(attachmentRefs('', 'not json')).toEqual([]);
});

test('cardRefs: type + title from an adaptive card (string or object content)', () => {
  const cards = JSON.stringify([
    {
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: JSON.stringify({
        type: 'AdaptiveCard',
        body: [
          { type: 'Container', items: [{ type: 'TextBlock', text: 'Ordine  2393\napprovato' }] },
        ],
      }),
    },
    { contentType: 'application/vnd.microsoft.card.hero', content: { title: 'Hero' } },
  ]);
  expect(cardRefs(cards)).toEqual([
    {
      kind: 'card',
      type: 'application/vnd.microsoft.card.adaptive',
      title: 'Ordine 2393 approvato',
    },
    { kind: 'card', type: 'application/vnd.microsoft.card.hero', title: 'Hero' },
  ]);
});

// ---- synthetic blockfile cache: data_1 (256B entries), data_2 (1 KiB blocks), f_000001 ----
const HDR = 8192;
const addr = (type: number, file: number, start: number) =>
  (0x80000000 | (type << 28) | (file << 16) | start) >>> 0;
const blockFile = (entrySize: number, blocks: number) => {
  const b = Buffer.alloc(HDR + entrySize * blocks);
  b.writeUInt32LE(0xc104cac3, 0);
  b.writeInt32LE(entrySize, 12);
  return b;
};
// Mark a block in use in the header's allocation bitmap (@80, one bit per block).
const alloc = (b: Buffer, block: number) => {
  const w = 80 + (block >>> 5) * 4;
  b.writeUInt32LE((b.readUInt32LE(w) | (1 << (block & 31))) >>> 0, w);
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
const THUMB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10)]);
const headers = (ct: string, len: number) =>
  Buffer.from(`\0\0\0\0HTTP/1.1 200\0content-type: ${ct}\0content-length: ${len}\0\0`, 'latin1');
const SITE = '1/0/_dk_https://live.com https://live.com ';
const FULL_KEY = `${SITE}https://experimental-api.asm.skype.com/v1/0a1b2c3d4e5f6a7b/objects/${AMS}/views/imgo`;
const THUMB_KEY = `${SITE}https://a.asm.skype.com/v1/objects/${AMS}/views/imgt1`;

function writeEntry(
  d1: Buffer,
  block: number,
  key: string,
  state: number,
  stream0: [number, number],
  stream1: [number, number],
) {
  const off = HDR + block * 256;
  d1.writeInt32LE(state, off + 20);
  d1.writeInt32LE(key.length, off + 32);
  d1.writeInt32LE(stream0[1], off + 40);
  d1.writeInt32LE(stream1[1], off + 44);
  d1.writeUInt32LE(stream0[0], off + 56);
  d1.writeUInt32LE(stream1[0], off + 60);
  d1.write(key, off + 96, 'latin1');
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// Build a cache with: a doomed full-size entry (block 0), a live thumbnail (block 2, body in data_2
// block 1), and a full-size entry (blocks 4-5, body in f_000001). `fullLive` = whether the full-size
// entry's block is still allocated (false = a freed/stale entry whose bytes are still on disk).
function makeCache(fullLive: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-httpcache-'));
  dirs.push(dir);
  const d1 = blockFile(256, 16);
  const d2 = blockFile(1024, 8);
  const h = headers('image/jpeg', JPEG.length);
  h.copy(d2, HDR + 0 * 1024);
  THUMB.copy(d2, HDR + 1 * 1024);
  alloc(d2, 0);
  alloc(d2, 1);
  fs.writeFileSync(path.join(dir, 'f_000001'), JPEG);
  writeEntry(
    d1,
    0,
    `${SITE}https://a.asm.skype.com/v1/objects/${AMS}/views/imgo?v=1`,
    2,
    [0, 0],
    [0, 0],
  );
  alloc(d1, 0);
  writeEntry(d1, 2, THUMB_KEY, 0, [addr(3, 2, 0), h.length], [addr(3, 2, 1), THUMB.length]);
  alloc(d1, 2);
  writeEntry(d1, 4, FULL_KEY, 0, [addr(3, 2, 0), h.length], [addr(0, 0, 1), JPEG.length]);
  if (fullLive) {
    alloc(d1, 4);
    alloc(d1, 5);
  }
  fs.writeFileSync(path.join(dir, 'data_1'), d1);
  fs.writeFileSync(path.join(dir, 'data_2'), d2);
  fs.writeFileSync(path.join(dir, 'index'), Buffer.alloc(16));
  return dir;
}

test('HttpCache: finds the full-size view of an AMS object, skips doomed/thumbnail entries', () => {
  const dir = makeCache(true);
  expect(HttpCache.exists(dir)).toBe(true);
  const hit = new HttpCache(dir).findObject(AMS);
  expect(hit).not.toBeNull();
  expect(hit!.view).toBe('imgo');
  expect(hit!.mimeType).toBe('image/jpeg');
  expect(hit!.contentType).toBe('image/jpeg');
  expect(hit!.contentLength).toBe(JPEG.length);
  expect(hit!.body.equals(JPEG)).toBe(true);
  expect(new HttpCache(dir).findObject('0-weu-d1-00000000000000000000000000000000')).toBeNull();
});

test('HttpCache: a freed (unallocated) entry is ignored even though its bytes are intact', () => {
  const hit = new HttpCache(makeCache(false)).findObject(AMS);
  expect(hit!.view).toBe('imgt1'); // falls back to the live thumbnail, never the stale full-size
  expect(hit!.body.equals(THUMB)).toBe(true);
});

test('sniffImage: only MCP-supported image types', () => {
  expect(sniffImage(JPEG)).toBe('image/jpeg');
  expect(sniffImage(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('image/png');
  expect(sniffImage(Buffer.from('BM\0\0\0\0'))).toBeNull(); // BMP: not accepted as image content
  expect(sniffImage(Buffer.from('<html>'))).toBeNull();
});
