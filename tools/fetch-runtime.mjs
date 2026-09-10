#!/usr/bin/env node
/* Fetch the Node runtime that ships inside SplitpageSetup.exe.
 *
 *   node tools/fetch-runtime.mjs [--arch x64|arm64] [--version 22.22.2]
 *
 * WHY THIS EXISTS. Splitpage's launcher, its updater and — the part that
 * actually matters to someone installing it — hosting a shared session all
 * run on Node. Telling a user to go and install Node first is a second
 * download and a second installer, which is exactly the seam this removes.
 * The setup.exe carries its own copy, so one download is the whole product.
 *
 * The binary is NOT in git: it is 87 MB, it is not ours, and it has its own
 * release cadence. It is downloaded once into .cache/ and reused.
 *
 * It is verified against nodejs.org's published SHASUMS256.txt before it is
 * unpacked. That file is fetched over HTTPS from the same origin, so this
 * protects against a truncated or corrupted download rather than against a
 * compromised nodejs.org — for which the answer is the release signatures,
 * and a bigger apparatus than a personal tool warrants.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip } from "../update.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

/* Pinned rather than "latest": a release should be reproducible, and a
   runtime that changes under you between two builds of the same version is
   the sort of thing that is only ever noticed by a user. */
export const NODE_VERSION = arg("--version", process.env.SPLITPAGE_NODE_VERSION || "22.22.2");

export async function fetchRuntime({ arch = "x64", version = NODE_VERSION, log = console.log } = {}) {
  const name = `node-v${version}-win-${arch}`;
  const out = join(CACHE, `${name}-node.exe`);
  if (existsSync(out)) {
    log(`  runtime: cached ${name}/node.exe`);
    return out;
  }

  mkdirSync(CACHE, { recursive: true });
  const base = `https://nodejs.org/dist/v${version}`;

  log(`  runtime: fetching checksums for ${version}...`);
  const sumsRes = await fetch(`${base}/SHASUMS256.txt`);
  if (!sumsRes.ok) throw new Error(`could not fetch SHASUMS256.txt: ${sumsRes.status} ${sumsRes.statusText}`);
  const sums = await sumsRes.text();
  const line = sums.split("\n").find((l) => l.trim().endsWith(`${name}.zip`));
  if (!line) throw new Error(`nodejs.org lists no ${name}.zip for v${version}`);
  const expected = line.trim().split(/\s+/)[0];

  log(`  runtime: downloading ${name}.zip (~35 MB)...`);
  const zipRes = await fetch(`${base}/${name}.zip`);
  if (!zipRes.ok) throw new Error(`download failed: ${zipRes.status} ${zipRes.statusText}`);
  const zip = Buffer.from(await zipRes.arrayBuffer());

  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${name}.zip\n    expected ${expected}\n    got      ${actual}`);
  }

  const files = readZip(zip);
  const exe = files.get(`${name}/node.exe`);
  if (!exe) throw new Error(`${name}.zip has no node.exe in it`);
  writeFileSync(out, exe);

  /* Node's own licence travels with its binary. */
  const licence = files.get(`${name}/LICENSE`);
  if (licence) writeFileSync(join(CACHE, `${name}-LICENSE`), licence);

  log(`  runtime: verified and unpacked node.exe (${(exe.length / 1024 / 1024).toFixed(0)} MB)`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const path = await fetchRuntime({ arch: arg("--arch", "x64") });
    console.log(path);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
}
