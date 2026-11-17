// Generates the PNG app icons (PWA manifest, apple-touch-icon, favicon) from a procedural copy of
// assets/icon.svg. No npm deps: a tiny scanline-free rasterizer (supersampled point-in-shape tests) and a
// PNG encoder on node:zlib. Run: node tools/build-icons.mjs  (writes assets/icon-*.png, deterministic).
//
// Variants:
//   icon-192.png / icon-512.png            purpose "any": rounded square, transparent corners (like the SVG)
//   icon-maskable-192.png / -512.png       purpose "maskable": full-bleed background, moon + rocket pulled
//                                          inside the 80% safe circle so Android's circle/squircle masks keep them
//   apple-touch-icon.png (180)             full-bleed square (iOS rounds it itself, transparency turns black)
//   favicon-32.png                         small favicon for browsers without SVG icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'assets');

// ------------------------------------------------------------------ PNG encoder

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** rgba: Uint8Array(w*h*4) → PNG file bytes (8-bit RGBA, filter "none" per row). */
export function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ geometry (512-unit icon space)

const hex = (s, a = 1) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), a];

/** Quadratic Bézier flattened to points (excluding p0). */
function quad(p0, c, p1, n = 16) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return out;
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
const poly = (pts, color) => ({ kind: 'poly', pts, color, bbox: bboxOf(pts) });
const circle = (cx, cy, r, color) => ({ kind: 'circle', cx, cy, r, color, bbox: [cx - r, cy - r, cx + r, cy + r] });
const rect = (x, y, w, h, color) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color);

function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inShape(s, x, y) {
  if (x < s.bbox[0] || x > s.bbox[2] || y < s.bbox[1] || y > s.bbox[3]) return false;
  if (s.kind === 'circle') return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
  return inPoly(s.pts, x, y);
}

/** Affine transform of a shape: scale k around (ox, oy), then rotate/translate. */
function mapShape(s, fn, k = 1) {
  if (s.kind === 'circle') {
    const [cx, cy] = fn([s.cx, s.cy]);
    return circle(cx, cy, s.r * k, s.color);
  }
  return poly(s.pts.map(fn), s.color);
}

function rocket() {
  // local coordinates of <g transform="translate(232 120) rotate(14)"> in icon.svg
  const body = [[24, 0], ...quad([24, 0], [54, 40], [54, 120]), [54, 230], [-6, 230], [-6, 120], ...quad([-6, 120], [-6, 40], [24, 0])];
  const flame = [[8, 234], ...quad([8, 234], [24, 330], [40, 234])];
  return [
    poly(flame, hex('#e8b23a')),
    poly([[-6, 180], [-36, 240], [-6, 240]], hex('#e2553a')),
    poly([[54, 180], [84, 240], [54, 240]], hex('#e2553a')),
    poly(body, hex('#f7f1e3')),
    rect(-6, 140, 60, 16, hex('#e2553a')),
    // the window's 5px stroke drawn as two discs
    circle(24, 86, 15.5, hex('#0b1020')),
    circle(24, 86, 10.5, hex('#28628f')),
  ];
}

/**
 * Layers of the icon in 512-space. fg = scale of the foreground (moon + rocket) around the centre; full =
 * background covers the whole square (maskable / apple) instead of the rounded rect.
 */
function scene({ fg = 1, full = false } = {}) {
  const bg = hex('#0b1020');
  const layers = [];
  const rays = [
    [[256, 470], [-30, 250], [0, 200]], [[256, 470], [40, 120], [90, 90]], [[256, 470], [180, 40], [240, 34]],
    [[256, 470], [330, 36], [390, 50]], [[256, 470], [450, 110], [490, 150]], [[256, 470], [540, 240], [530, 300]],
  ];
  const grid = [];
  for (const v of [128, 256, 384]) {
    grid.push(rect(0, v - 1.5, 512, 3, hex('#4fb3d9', 0.14)));
    grid.push(rect(v - 1.5, 0, 3, 512, hex('#4fb3d9', 0.14)));
  }
  layers.push(...grid);
  for (const r of rays) layers.push(poly(r, hex('#e2553a', 0.85)));
  const about = (p) => [256 + (p[0] - 256) * fg, 256 + (p[1] - 256) * fg];
  for (const c of [circle(370, 150, 70, hex('#e6dcc2')), circle(348, 132, 13, hex('#b9a988')), circle(392, 172, 9, hex('#b9a988'))]) {
    layers.push(mapShape(c, about, fg));
  }
  const ground = [[0, 512], [0, 430], ...quad([0, 430], [128, 392], [256, 410]), ...quad([256, 410], [384, 392], [512, 430]), [512, 512]];
  layers.push(poly(ground, bg));
  const a = (14 * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const toWorld = ([x, y]) => about([232 + x * ca - y * sa, 120 + x * sa + y * ca]);
  for (const s of rocket()) layers.push(mapShape(s, toWorld, fg));
  return { bg, layers, clip: full ? null : { r: 96 } };
}

function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 512 - r), cy = Math.min(Math.max(y, r), 512 - r);
  return x >= 0 && y >= 0 && x <= 512 && y <= 512 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Rasterize a scene to size×size RGBA with ss×ss supersampling. */
export function rasterize(size, sc, ss = 4) {
  const out = new Uint8Array(size * size * 4);
  const k = 512 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * k, y = (py + (sy + 0.5) / ss) * k;
          if (sc.clip && !inRoundRect(x, y, sc.clip.r)) continue;
          let [r, g, b] = sc.bg;
          for (const s of sc.layers) {
            if (!inShape(s, x, y)) continue;
            const [cr, cg, cb, ca] = s.color;
            r += (cr - r) * ca; g += (cg - g) * ca; b += (cb - b) * ca;
          }
          R += r; G += g; B += b; A += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (A) { out[i] = Math.round(R / A); out[i + 1] = Math.round(G / A); out[i + 2] = Math.round(B / A); }
      out[i + 3] = Math.round((A / (ss * ss)) * 255);
    }
  }
  return out;
}

export const ICONS = [
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  { file: 'icon-maskable-192.png', size: 192, opts: { full: true, fg: 0.84 } },
  { file: 'icon-maskable-512.png', size: 512, opts: { full: true, fg: 0.84 } },
  { file: 'apple-touch-icon.png', size: 180, opts: { full: true } },
  { file: 'favicon-32.png', size: 32, opts: {} },
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const ic of ICONS) {
    const t0 = Date.now();
    const png = encodePNG(ic.size, ic.size, rasterize(ic.size, scene(ic.opts), ic.size <= 64 ? 8 : 4));
    fs.writeFileSync(path.join(OUT, ic.file), png);
    console.log(`${ic.file}: ${ic.size}x${ic.size}, ${(png.length / 1024).toFixed(1)} KB (${Date.now() - t0} ms)`);
  }
}
