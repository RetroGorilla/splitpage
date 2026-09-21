#!/usr/bin/env node
// Rasterises icon.svg into the Windows icon.ico that electron-builder, the
// NSIS installer and the dev-mode BrowserWindow all point at.
//
// The committed .ico used to hold RGB PNGs with the area outside the rounded
// square painted opaque white, so every dark surface Windows draws the icon on
// — taskbar, dark-theme Explorer, Alt+Tab — showed four white corners. The
// frames written here are RGBA, and anything the SVG leaves uncovered stays
// transparent.
//
//   node tools/make-icon.mjs          rewrite the .ico files from icon.svg
//   node tools/make-icon.mjs --check  fail if they are stale or opaque
//
// No dependencies: icon.svg is nothing but rounded rectangles, so the few
// hundred lines of scanline work below beat pulling in a renderer.

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "icon.svg");
const TARGETS = [join(ROOT, "installer", "icon.ico"), join(ROOT, "desktop", "build", "icon.ico")];

// The sizes the previous icon carried. Windows picks per surface: 16 in the
// title bar, 32 on the taskbar, 256 for Explorer's extra-large view.
const SIZES = [16, 32, 48, 64, 128, 256];
// Samples per axis when rasterising. 4 is enough to keep the 16px corners from
// looking chewed without making the 256px frame slow.
const SUPERSAMPLE = 4;

function parseSvg(svg) {
  const viewBox = /viewBox="([\d.\s-]+)"/.exec(svg);
  if (!viewBox) throw new Error("icon.svg has no viewBox");
  const [minX, minY, width, height] = viewBox[1].trim().split(/\s+/).map(Number);

  const rects = [];
  for (const tag of svg.matchAll(/<rect\b([^>]*)\/?>/g)) {
    const attr = (name) => {
      // The leading boundary matters: a bare /x="/ also matches inside rx="96".
      const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag[1]);
      return m ? m[1] : null;
    };
    const num = (name, fallback = 0) => {
      const v = attr(name);
      return v === null ? fallback : Number(v);
    };
    const fill = attr("fill");
    if (!fill || fill === "none") continue;
    const rx = num("rx", 0);
    rects.push({
      x: num("x"),
      y: num("y"),
      w: num("width"),
      h: num("height"),
      rx,
      ry: num("ry", rx),
      color: parseHex(fill),
    });
  }
  if (!rects.length) throw new Error("icon.svg has no filled rects");
  return { minX, minY, width, height, rects };
}

function parseHex(fill) {
  let hex = fill.trim().replace(/^#/, "");
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`unsupported fill: ${fill}`);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

// Point-in-rounded-rect. Outside the corner quadrants this is a plain box
// test; inside one it is the ellipse the corner radius describes.
function covers(rect, px, py) {
  const { x, y, w, h } = rect;
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const rx = Math.min(rect.rx, w / 2);
  const ry = Math.min(rect.ry, h / 2);
  if (rx <= 0 || ry <= 0) return true;
  const cx = px < x + rx ? x + rx : px > x + w - rx ? x + w - rx : null;
  const cy = py < y + ry ? y + ry : py > y + h - ry ? y + h - ry : null;
  if (cx === null || cy === null) return true; // edge band, not a corner
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

// Renders one frame as straight (non-premultiplied) RGBA. Each sample is either
// fully covered by the topmost rect under it or fully transparent; averaging
// the samples is what produces the anti-aliased edge and the partial alpha
// along the rounded corners.
function render(doc, size) {
  const px = new Uint8Array(size * size * 4);
  const step = doc.width / (size * SUPERSAMPLE);
  const half = step / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const uy = doc.minY + (y * SUPERSAMPLE + sy) * step + half;
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const ux = doc.minX + (x * SUPERSAMPLE + sx) * step + half;
          let hit = null;
          for (const rect of doc.rects) if (covers(rect, ux, uy)) hit = rect; // last wins: painter's order
          if (!hit) continue;
          r += hit.color[0];
          g += hit.color[1];
          b += hit.color[2];
          hits++;
        }
      }
      const o = (y * size + x) * 4;
      const total = SUPERSAMPLE * SUPERSAMPLE;
      if (!hits) continue; // leave it transparent black
      // Average over the covered samples only, so an edge pixel keeps the
      // shape's colour and carries the coverage in alpha instead of bleeding
      // toward transparent black.
      px[o] = Math.round(r / hits);
      px[o + 1] = Math.round(g / hits);
      px[o + 2] = Math.round(b / hits);
      px[o + 3] = Math.round((hits / total) * 255);
    }
  }
  return px;
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
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA. Colour type 2 is the bug this fixes.

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 1; // Sub filter: cheap and good on flat colour
    const row = Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride);
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = (row[x] - (x >= 4 ? row[x - 4] : 0)) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);

  const dir = Buffer.alloc(16 * frames.length);
  let offset = header.length + dir.length;
  frames.forEach((frame, i) => {
    const o = i * 16;
    dir[o] = frame.size === 256 ? 0 : frame.size; // 0 means 256 in an ICO
    dir[o + 1] = frame.size === 256 ? 0 : frame.size;
    dir[o + 2] = 0; // palette size: 0 for true colour
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel, now honestly RGBA
    dir.writeUInt32LE(frame.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += frame.png.length;
  });

  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

const doc = parseSvg(readFileSync(SOURCE, "utf8"));
const ico = buildIco(SIZES.map((size) => ({ size, png: encodePng(render(doc, size), size) })));

if (process.argv.includes("--check")) {
  let stale = false;
  for (const target of TARGETS) {
    const current = readFileSync(target);
    const ok = current.equals(ico);
    console.log(`${ok ? "ok  " : "STALE"} ${target}`);
    if (!ok) stale = true;
  }
  if (stale) {
    console.error("icon.ico does not match icon.svg — run: node tools/make-icon.mjs");
    process.exit(1);
  }
} else {
  for (const target of TARGETS) {
    writeFileSync(target, ico);
    console.log(`wrote ${target} (${ico.length} bytes, ${SIZES.join("/")})`);
  }
}
