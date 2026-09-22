#!/usr/bin/env node
/* Splitpage release packager.
 *
 *   node package.mjs              build dist/splitpage-<version>/ and the .zip
 *
 * The zip IS the portable app: unzip it anywhere and run start.bat (Windows)
 * or ./start.sh (macOS/Linux). Nothing is compiled and nothing is installed.
 *
 * This used to have a second output behind --installer: SplitpageSetup-
 * <version>-<arch>.exe, a self-extracting archive built by iexpress.exe with
 * its own copy of node.exe, a PowerShell installer and a PowerShell
 * uninstaller inside it. DEPLOY.md had already called it deprecated; it is
 * deleted now (#75), along with the runtime fetcher that only fed it. The
 * Windows installer is desktop/'s Electron one (SplitpageDesktopSetup-
 * <version>-<arch>.exe) — see DEPLOY.md's publishing section.
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
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

/* release.json's `updateApi` used to be copied into the release manifest
   below, so a release could name the API the next update check would use.
   #64 made update.mjs ignore that field — a release naming where the next
   release comes from is a redirect nothing can revoke — and #75 removed the
   self-update path that read it at all. Writing it now would put a field in
   every release that nothing reads and that must never be read, so it is not
   written. release.json is no longer an input to packaging. */

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
  ["start.sh", 0o755],
  ["update.mjs", 0o644],
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

/* ---------- release manifest ----------
 *
 * A record of exactly what this release consists of, shipped inside it: what
 * the release contained, and the hash of each file as shipped, so an unzipped
 * copy can be told apart from one that has been edited or half-overwritten.
 */

const MANIFEST_NAME = ".splitpage-release.json";
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const manifest = {
  name: "Splitpage",
  version: VERSION,
  files: Object.fromEntries(
    FILES.map(([rel, mode]) => [rel, { sha256: sha256(readFileSync(join(STAGE, rel))), mode }])
  )
};
writeFileSync(join(STAGE, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

/* Everything that goes in the zip: the payload plus the manifest describing it. */
const ENTRIES = [...FILES, [MANIFEST_NAME, 0o644]];

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

function makeZip(prefix, entries, read) {
const locals = [];
const central = [];
let offset = 0;

for (const [rel, mode] of entries) {
  /* Zip paths are always forward-slashed, whatever the host OS. */
  const nameBuf = Buffer.from(`${prefix}/${rel.split(/[\\/]/).join("/")}`, "utf8");
  const raw = read(rel);
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
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

return Buffer.concat([...locals, centralBuf, eocd]);
}

const zipPath = join(DIST, `${NAME}.zip`);
writeFileSync(zipPath, makeZip(NAME, ENTRIES, (rel) => readFileSync(join(STAGE, rel))));

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`\n  ${STAGE}`);
console.log(`  ${zipPath}  (${kb(statSync(zipPath).size)})`);

console.log(`\n  Unzip and run start.bat (Windows) or ./start.sh (macOS/Linux).\n`);
