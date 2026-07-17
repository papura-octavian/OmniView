// Generates build/icon.png (512x512) — the app icon, converted to .ico by electron-builder.
// Pure Node, no dependencies: draws a rounded-square gradient with a camera-lens motif.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const px = Buffer.alloc(S * S * 4);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// signed distance to rounded rectangle centered at (cx,cy)
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;

    // rounded-square silhouette with 1.5px anti-aliased edge
    const d = sdRoundRect(x + 0.5, y + 0.5, S / 2, S / 2, 236, 236, 110);
    const alpha = clamp(0.5 - d / 1.5, 0, 1);
    if (alpha === 0) continue;

    // diagonal gradient: blue -> violet
    const t = clamp((x + y) / (2 * S), 0, 1);
    let r = 38 + t * (139 - 38);
    let g = 108 + t * (76 - 108);
    let b = 255 - t * (255 - 246);

    // lens: outer white ring + dark iris + highlight
    const dc = Math.hypot(x - S / 2, y - S / 2);
    const ring = clamp(0.5 - (Math.abs(dc - 128) - 22) / 1.5, 0, 1); // white ring, r 106..150
    const iris = clamp(0.5 - (dc - 106) / 1.5, 0, 1);                // filled iris r<106
    if (iris > 0) {
      const ti = clamp(dc / 106, 0, 1);
      const ir = 18 + ti * 18, ig = 22 + ti * 26, ib = 34 + ti * 52;
      r = r * (1 - iris) + ir * iris;
      g = g * (1 - iris) + ig * iris;
      b = b * (1 - iris) + ib * iris;
      // specular highlight in upper-left of iris
      const dh = Math.hypot(x - (S / 2 - 38), y - (S / 2 - 42));
      const hl = clamp(0.5 - (dh - 30) / 18, 0, 1) * 0.85;
      r = r * (1 - hl) + 235 * hl;
      g = g * (1 - hl) + 240 * hl;
      b = b * (1 - hl) + 255 * hl;
    }
    if (ring > 0) {
      r = r * (1 - ring) + 245 * ring;
      g = g * (1 - ring) + 247 * ring;
      b = b * (1 - ring) + 252 * ring;
    }

    px[i] = Math.round(r);
    px[i + 1] = Math.round(g);
    px[i + 2] = Math.round(b);
    px[i + 3] = Math.round(alpha * 255);
  }
}

// --- minimal PNG encoder ---
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('Wrote', out, png.length, 'bytes');
