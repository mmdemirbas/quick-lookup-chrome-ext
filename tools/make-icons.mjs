/**
 * Generates the extension icons as real PNGs, with no image library.
 *
 * The old build shipped 1x1 placeholders. Drawing them here keeps the
 * repository free of binary assets while still producing something
 * recognisable in the toolbar: a rounded square with a magnifier on it.
 */
import { deflateSync } from 'node:zlib';

const BG = [99, 91, 255]; // indigo, the extension accent
const FG = [255, 255, 255];

/** Signed distance from a point to a rounded square centred on the canvas. */
function roundedSquareDistance(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to a line segment, used for the magnifier handle. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Linear blend of two colours; `a` is the coverage of `over` in 0..1. */
function blend(under, over, a) {
  return [
    Math.round(under[0] + (over[0] - under[0]) * a),
    Math.round(under[1] + (over[1] - under[1]) * a),
    Math.round(under[2] + (over[2] - under[2]) * a),
  ];
}

/**
 * Renders one icon into a raw RGBA buffer.
 *
 * Coverage is computed from the signed distance so edges are antialiased
 * without supersampling: a pixel one unit inside the shape is fully
 * covered, one unit outside is empty, and the band between is a ramp.
 */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const ring = size * 0.3; // magnifier lens radius
  const cx = size * 0.42;
  const cy = size * 0.42;
  const stroke = Math.max(1, size * 0.09);
  const handleFrom = [cx + ring * 0.72, cy + ring * 0.72];
  const handleTo = [size * 0.82, size * 0.82];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x + 0.5;
      const sy = y + 0.5;

      const plateCoverage = clamp01(0.5 - roundedSquareDistance(sx, sy, size, size * 0.22));
      if (plateCoverage <= 0) continue;

      // Lens: a ring, so the distance is to the circle outline, not the disc.
      const lens = Math.abs(Math.hypot(sx - cx, sy - cy) - ring) - stroke / 2;
      const handle =
        segmentDistance(sx, sy, handleFrom[0], handleFrom[1], handleTo[0], handleTo[1]) -
        stroke / 2;
      const glyphCoverage = clamp01(0.5 - Math.min(lens, handle));

      const rgb = blend(BG, FG, glyphCoverage);
      const i = (y * size + x) * 4;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = Math.round(plateCoverage * 255);
    }
  }
  return px;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes an RGBA buffer as a PNG. Filter type 0 on every scanline. */
export function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function iconPng(size) {
  return encodePng(size, render(size));
}
