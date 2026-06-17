// Generates a 1024x1024 source PNG for the app icon, with no dependencies.
// Run `node gen-icon.js app-icon.png`, then `cargo tauri icon app-icon.png`
// to expand it into the platform icon set under icons/.
const zlib = require('zlib');
const fs = require('fs');

const W = 1024, H = 1024;
const out = process.argv[2] || 'app-icon.png';

// Palette: dark slate background, indigo rounded tile, off-white nav chevron.
const BG = [17, 18, 26];
const TILE = [99, 102, 241];
const MARK = [240, 242, 255];

const raw = Buffer.alloc(H * (1 + W * 4));

function rounded(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r ||
    (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}

// A thick right-pointing chevron ">" centered in the tile.
function chevron(x, y) {
  const cx = W * 0.46, cy = H / 2;
  const half = H * 0.18, thick = W * 0.07;
  const dx = x - cx;
  const dy = Math.abs(y - cy);
  if (dy > half) return false;
  const edge = cx + (half - dy);
  return x <= edge && x >= edge - thick && dx > -thick;
}

for (let y = 0; y < H; y++) {
  const off = y * (1 + W * 4);
  raw[off] = 0; // filter byte: none
  for (let x = 0; x < W; x++) {
    let c = BG;
    if (rounded(x, y, W * 0.16, H * 0.16, W * 0.84, H * 0.84, W * 0.14)) c = TILE;
    if (chevron(x, y)) c = MARK;
    const p = off + 1 + x * 4;
    raw[p] = c[0]; raw[p + 1] = c[1]; raw[p + 2] = c[2]; raw[p + 3] = 255;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type: RGBA
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
