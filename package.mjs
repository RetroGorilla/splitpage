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

// Child process: build.mjs calls process.exit at top level.
const built = spawnSync(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, stdio: "inherit" });
if (built.status !== 0) {
  console.error("Build failed — not packaging.");
  process.exit(1);
}

const FILES = [
  ["index.html", 0o644],
  ["manifest.webmanifest", 0o644],
  ["icon.svg", 0o644],
  ["icon-maskable.svg", 0o644],
  ["sw.js", 0o644],
  ["server/server.js", 0o644],
  // Needed so server.js loads as CommonJS under root "type":"module".
  ["server/package.json", 0o644],
  ["start.mjs", 0o644],
  ["start.bat", 0o644],
  ["start.sh", 0o755],
  ["update.mjs", 0o644],
  ["README.md", 0o644],
  ["docs/help.md", 0o644],
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

const ENTRIES = [...FILES, [MANIFEST_NAME, 0o644]];

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

// Fixed timestamp keeps releases reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function makeZip(prefix, entries, read) {
const locals = [];
const central = [];
let offset = 0;

for (const [rel, mode] of entries) {
  const nameBuf = Buffer.from(`${prefix}/${rel.split(/[\\/]/).join("/")}`, "utf8");
  const raw = read(rel);
  const deflated = deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, data);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
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
  dir.writeUInt16LE(0, 30);
  dir.writeUInt16LE(0, 32);
  dir.writeUInt16LE(0, 34);
  dir.writeUInt16LE(0, 36);
  dir.writeUInt32LE(((0o100000 | mode) >>> 0) * 0x10000, 38);
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
