#!/usr/bin/env node
/* Splitpage updater.
 *
 *   node update.mjs            check, and stage an update if there is one
 *   node update.mjs check      only say what is available
 *   node update.mjs apply      install what was staged (the launcher does this)
 *   node update.mjs --force    stage even over files you have edited
 *
 * HOW IT INSTALLS, AND WHY THAT WAY. Downloading is safe at any time;
 * overwriting the app while a browser has it open is not. So the two are
 * split: this stages a verified copy under .update/, and the files are only
 * swapped in by `apply`, which start.mjs runs at launch before it serves
 * anything. The app therefore updates on restart, and no HTTP endpoint
 * anywhere can overwrite the app — which is the point. A localhost server
 * with no authentication must not have a "replace your files" route on it,
 * because any web page you have open could POST to it.
 *
 * The release is identified by .splitpage-release.json, written by
 * package.mjs. Every staged file is checked against the hashes in the new
 * release's own manifest before anything is replaced, and the copy it
 * replaces is kept under .update/backup/ so a failed apply rolls back.
 */

import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync
} from "node:fs";
import { dirname, join, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UPDATE_DIR = join(ROOT, ".update");
const MANIFEST_NAME = ".splitpage-release.json";

/* Overridable so this can be pointed at a test server — and so anyone running
   their own fork is not stuck fetching someone else's releases. */
const API = process.env.SPLITPAGE_UPDATE_API
  || "https://api.github.com/repos/RetroGorilla/splitpage/releases/latest";

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("-")) || "stage";
const FORCE = argv.includes("--force");
const QUIET = argv.includes("--quiet");
const say = (...a) => { if (!QUIET) console.log(...a); };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/* A zip entry name (or a manifest key, which is release-controlled the same
   way) is untrusted input the moment it can contain "..". join() alone does
   not stop it — join(root, "../../etc/passwd") normalizes right out of root
   — so every path built from one of these names is checked against the
   resolved root before it is used for a read or a write. */
function safeJoin(root, rel) {
  const target = resolve(join(root, rel));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`refusing to touch a path outside ${root}: ${rel}`);
  }
  return target;
}

/* ---------- versions ---------- */

/* Numeric, dotted, longest-wins. Anything non-numeric in a segment sorts as 0,
   so a "1.2.0-beta" never reads as newer than "1.2.0". */
export function compareVersions(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10) || 0;
    const nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

function localVersion() {
  try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return "0.0.0"; }
}

function localManifest() {
  try { return JSON.parse(readFileSync(join(ROOT, MANIFEST_NAME), "utf8")); } catch { return null; }
}

/* ---------- zip reading ---------- */

/* Reads the central directory rather than scanning for local headers, which
   is the only way to get the authoritative list of entries. Store and deflate
   are the only methods package.mjs emits, and the only ones handled. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    /* The local header's own name/extra lengths are what locate the data —
       they can differ from the central directory's. */
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(start, start + compSize);

    let content;
    if (method === 0) content = data;
    else if (method === 8) content = inflateRawSync(data);
    else throw new Error(`unsupported compression (method ${method}) for ${name}`);
    if (content.length !== rawSize) throw new Error(`size mismatch for ${name}`);

    files.set(name, content);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* Releases are zipped with a splitpage-<version>/ top level. Strip it. */
function stripTopLevel(files) {
  const names = [...files.keys()];
  const first = names[0]?.split("/")[0];
  if (!first || !names.every((n) => n.startsWith(first + "/"))) return files;
  return new Map(names.map((n) => [n.slice(first.length + 1), files.get(n)]));
}

/* ---------- the remote release ---------- */

async function latestRelease() {
  const res = await fetch(API, { headers: { "Accept": "application/vnd.github+json", "User-Agent": "splitpage-updater" } });
  if (!res.ok) throw new Error(`update check failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  const version = String(body.tag_name || body.name || "").replace(/^v/, "").trim();
  if (!version) throw new Error("the release has no version tag");
  const asset = (body.assets || []).find((a) => /^splitpage-.*\.zip$/.test(a.name || ""));
  if (!asset) throw new Error(`release ${version} has no splitpage-*.zip attached to it`);
  return { version, url: asset.browser_download_url, notes: body.body || "" };
}

/* ---------- commands ---------- */

async function check() {
  const current = localVersion();
  const release = await latestRelease();
  const newer = compareVersions(release.version, current) > 0;
  say(`  installed: ${current}`);
  say(`  available: ${release.version}${newer ? "" : "  (you are up to date)"}`);
  return { current, release, newer };
}

async function stage() {
  const { current, release, newer } = await check();
  if (!newer && !FORCE) return { staged: false, ...release };

  say(`\n  downloading ${release.version}...`);
  const res = await fetch(release.url, { headers: { "User-Agent": "splitpage-updater" } });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const zip = Buffer.from(await res.arrayBuffer());

  const files = stripTopLevel(readZip(zip));
  const manifestRaw = files.get(MANIFEST_NAME);
  if (!manifestRaw) throw new Error(`that zip has no ${MANIFEST_NAME} — it is not a Splitpage release`);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));

  /* Every file the new release claims must be present and hash correctly.
     A partial or tampered download is caught here, before anything on disk
     has been touched. */
  for (const [rel, meta] of Object.entries(manifest.files || {})) {
    const content = files.get(rel);
    if (!content) throw new Error(`the download is missing ${rel}`);
    if (sha256(content) !== meta.sha256) throw new Error(`${rel} does not match its checksum — download corrupt`);
  }

  /* Anything the user has edited by hand. Overwriting it silently would throw
     away their change with no way back, so it stops instead. */
  const mine = localManifest();
  const edited = [];
  if (mine) {
    for (const [rel, meta] of Object.entries(mine.files || {})) {
      const path = join(ROOT, rel);
      if (!existsSync(path)) continue;
      if (sha256(readFileSync(path)) !== meta.sha256) edited.push(rel);
    }
  }
  if (edited.length && !FORCE) {
    console.error(`
  Not staging: these files differ from the ${current} release, so you have
  edited them and the update would overwrite your changes:
`);
    for (const rel of edited) console.error(`    ${rel}`);
    console.error(`
  Move them aside and run this again, or --force to overwrite them.
`);
    process.exit(1);
  }

  rmSync(UPDATE_DIR, { recursive: true, force: true });
  const stagedDir = join(UPDATE_DIR, "staged");
  mkdirSync(stagedDir, { recursive: true });
  /* Only entries the manifest lists (already checksum-verified above), plus
     the manifest itself. A zip can contain more entries than that — an
     extra, unlisted one skipped the verification loop entirely, so writing
     it here would stage unverified, unaccountable content. */
  const toStage = [...Object.keys(manifest.files || {}), MANIFEST_NAME];
  for (const rel of toStage) {
    const content = files.get(rel);
    if (!content) continue; /* MANIFEST_NAME already required to exist, above */
    const to = safeJoin(stagedDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, content);
  }
  writeFileSync(join(UPDATE_DIR, "pending.json"),
    JSON.stringify({ from: current, to: release.version, stagedAt: new Date().toISOString() }, null, 2) + "\n");

  say(`  staged ${release.version} (${files.size} files, all checksums good)`);
  say(`\n  Restart Splitpage to finish installing it.\n`);
  return { staged: true, ...release };
}

export function pending() {
  try { return JSON.parse(readFileSync(join(UPDATE_DIR, "pending.json"), "utf8")); } catch { return null; }
}

/* Called by start.mjs before it serves anything. Never while running. */
export function apply({ log = console.log } = {}) {
  const info = pending();
  if (!info) return null;

  const stagedDir = join(UPDATE_DIR, "staged");
  const manifest = JSON.parse(readFileSync(join(stagedDir, MANIFEST_NAME), "utf8"));
  const entries = [...Object.entries(manifest.files || {}), [MANIFEST_NAME, { mode: 0o644 }]];

  const backup = join(UPDATE_DIR, "backup");
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(backup, { recursive: true });

  const done = [];
  try {
    for (const [rel, meta] of entries) {
      const from = safeJoin(stagedDir, rel);
      const to = safeJoin(ROOT, rel);
      if (existsSync(to)) {
        const keep = safeJoin(backup, rel);
        mkdirSync(dirname(keep), { recursive: true });
        cpSync(to, keep);
      }
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      if (meta && typeof meta.mode === "number") {
        try { chmodSync(to, meta.mode); } catch { /* Windows has no mode bits */ }
      }
      done.push(rel);
    }
  } catch (err) {
    /* Put back everything already replaced, so a half-applied update never
       leaves an app that will not start. */
    log(`  update failed (${err.message}) — rolling back`);
    for (const rel of done) {
      const keep = safeJoin(backup, rel);
      if (existsSync(keep)) cpSync(keep, safeJoin(ROOT, rel));
    }
    rmSync(join(UPDATE_DIR, "pending.json"), { force: true });
    throw err;
  }

  rmSync(stagedDir, { recursive: true, force: true });
  rmSync(join(UPDATE_DIR, "pending.json"), { force: true });
  log(`  updated ${info.from} -> ${info.to}`);
  return info;
}

/* ---------- run ---------- */

/* Only when invoked directly — start.mjs imports apply() and pending(). */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (cmd === "check") await check();
    else if (cmd === "apply") {
      const info = apply();
      if (!info) console.log("  nothing staged to apply");
    } else await stage();
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
}
