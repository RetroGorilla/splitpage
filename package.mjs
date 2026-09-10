#!/usr/bin/env node
/* Splitpage release packager.
 *
 *   node package.mjs              build dist/splitpage-<version>/ and the .zip
 *   node package.mjs --installer  ...and compile the Windows setup.exe
 *
 * The zip IS the portable app: unzip it anywhere and run start.bat (Windows)
 * or ./start.sh (macOS/Linux). Nothing is compiled and nothing is installed,
 * so this also serves as the "no build tools" path for people who do not want
 * installer/splitpage.iss and a real setup.exe.
 *
 * Deliberately excluded: src/ and build.mjs (a release ships the built page,
 * not the parts), and the hosting files (Dockerfile, DEPLOY.md), which are a
 * different job with a different audience.
 *
 * The zip is written here rather than shelled out to, because this has to
 * produce the same bytes on the Windows machine that cuts releases as on a
 * Linux CI box, and neither `zip` nor Compress-Archive is on both.
 */

import { deflateRawSync } from "node:zlib";
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

/* ---------- build first ---------- */

const built = spawnSync(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, stdio: "inherit" });
if (built.status !== 0) {
  console.error("Build failed — not packaging.");
  process.exit(1);
}

/* ---------- stage ---------- */

/* Executable bits matter: start.sh has to stay runnable after a round trip
   through the zip, or macOS and Linux users get "permission denied". */
const FILES = [
  ["index.html", 0o644],
  ["manifest.webmanifest", 0o644],
  ["icon.svg", 0o644],
  ["sw.js", 0o644],
  ["server/server.js", 0o644],
  ["start.mjs", 0o644],
  ["start.bat", 0o644],
  ["start.ps1", 0o644],
  ["start.sh", 0o755],
  ["README.md", 0o644],
  ["VERSION", 0o644]
];

const NAME = `splitpage-${VERSION}`;
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, NAME);

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const [rel] of FILES) {
  const from = join(ROOT, rel);
  if (!existsSync(from)) {
    console.error(`missing: ${rel}`);
    process.exit(1);
  }
  const to = join(STAGE, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

/* ---------- zip ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* MS-DOS date/time. Fixed, not "now": a release built twice from the same
   commit should be the same file, and a timestamp is the one thing that would
   stop it. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const locals = [];
const central = [];
let offset = 0;

for (const [rel, mode] of FILES) {
  /* Zip paths are always forward-slashed, whatever the host OS. */
  const nameBuf = Buffer.from(`${NAME}/${rel.split(/[\\/]/).join("/")}`, "utf8");
  const raw = readFileSync(join(STAGE, rel));
  const deflated = deflateRawSync(raw, { level: 9 });
  /* Only claim compression if it actually helped. */
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          /* version needed */
  local.writeUInt16LE(0, 6);           /* flags */
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);          /* extra */
  locals.push(local, nameBuf, data);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  /* 3 = Unix in the upper byte, so the permission bits below are honoured. */
  dir.writeUInt16LE((3 << 8) | 20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0, 8);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt16LE(DOS_TIME, 12);
  dir.writeUInt16LE(DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(data.length, 20);
  dir.writeUInt32LE(raw.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt16LE(0, 30);            /* extra */
  dir.writeUInt16LE(0, 32);            /* comment */
  dir.writeUInt16LE(0, 34);            /* disk */
  dir.writeUInt16LE(0, 36);            /* internal attrs */
  dir.writeUInt32LE(((0o100000 | mode) >>> 0) * 0x10000, 38); /* external attrs */
  dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(FILES.length, 8);
eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zipPath = join(DIST, `${NAME}.zip`);
writeFileSync(zipPath, Buffer.concat([...locals, centralBuf, eocd]));

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`\n  ${STAGE}`);
console.log(`  ${zipPath}  (${kb(statSync(zipPath).size)})`);

/* ---------- optional: the Windows installer ---------- */

if (process.argv.includes("--installer")) {
  /* Inno Setup's compiler. Present only on Windows, and only once someone has
     installed it — so this is opt-in rather than part of every package run. */
  const iss = join(ROOT, "installer", "splitpage.iss");
  const res = spawnSync("iscc", [iss], { cwd: ROOT, stdio: "inherit" });
  if (res.error && res.error.code === "ENOENT") {
    console.error(`
  iscc was not found, so no setup.exe was built.

  The Inno Setup compiler is Windows-only and needs installing once:
      https://jrsoftware.org/isdl.php
  Then either re-run this with --installer, or open installer/splitpage.iss
  in the Inno Setup IDE and press F9.

  The zip above is a complete portable copy either way.`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error("\n  Inno Setup failed — see the output above.");
    process.exit(1);
  }
  console.log(`  ${join(DIST, `SplitpageSetup-${VERSION}.exe`)}`);
}

console.log(`\n  Unzip and run start.bat (Windows) or ./start.sh (macOS/Linux).\n`);
