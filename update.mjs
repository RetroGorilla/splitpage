#!/usr/bin/env node
/* Splitpage update check.
 *
 *   node update.mjs            say whether a newer release exists
 *   node update.mjs check      the same thing, said explicitly
 *   node update.mjs --json     print one JSON line instead of prose
 *
 * WHAT THIS DOES NOT DO, AND WHY. It used to download a release zip, verify
 * every file in it against the release's own manifest, stage the result under
 * .update/, and let start.mjs swap the files in at the next launch — a whole
 * in-place self-update path, with a backup directory, a crash sentinel and a
 * rollback, so that a portable copy could replace itself. That is gone (#75).
 *
 * It was one of six ways to install this app, and the one nobody could keep
 * working: every release-breaking bug in the launcher came out of the swap.
 * The two paths that install anything now are the Electron setup, which has
 * its own updater in desktop/main.js with a mandatory published checksum
 * (#64), and downloading the portable zip again and unzipping it. Neither
 * needs this file to move a byte on disk, so this file no longer moves one.
 *
 * What is left is the question the app's update bar actually asks: is there
 * something newer than what I am running? The launcher answers it into
 * update-status.json at boot; this is the same answer from a terminal.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

/* Overridable so this can be pointed at a test server — and so anyone running
   their own fork is not stuck checking someone else's releases. */
const DEFAULT_API = "https://api.github.com/repos/RetroGorilla/splitpage/releases/latest";

const argv = process.argv.slice(2);
/* --json makes stdout a single machine-readable line, for anything that has
   to parse the answer rather than read it. It implies --quiet, because a
   "JSON line" with progress chatter above it is neither. */
const JSON_OUT = argv.includes("--json");
const QUIET = argv.includes("--quiet") || JSON_OUT;
const say = (...a) => { if (!QUIET) console.log(...a); };

/* ---------- versions ---------- */

/* Numeric, dotted, longest-wins, with semver's rule for a pre-release:
   "3.0.0-beta.1" is older than "3.0.0" and newer than "3.0.0-beta". Anything
   non-numeric in a core segment sorts as 0. */
export function compareVersions(a, b) {
  const va = splitVersion(a), vb = splitVersion(b);
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const na = va.core[i] || 0, nb = vb.core[i] || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  /* The same release: the release itself is newer than any pre-release of
     it, so a 3.0.0-beta.1 copy is offered 3.0.0 when it ships. */
  if (!va.pre.length || !vb.pre.length) return va.pre.length === vb.pre.length ? 0 : (va.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i], y = vb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; continue; }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* "3.0.0-beta.1" -> core [3, 0, 0], pre ["beta", "1"]. Build metadata
   ("+abc") plays no part in the order. */
function splitVersion(v) {
  const s = String(v).trim().replace(/\+.*$/, "");
  const dash = s.indexOf("-");
  return {
    core: (dash === -1 ? s : s.slice(0, dash)).split(".").map((n) => parseInt(n, 10) || 0),
    pre: dash === -1 ? [] : s.slice(dash + 1).split(".").filter(Boolean)
  };
}

function localVersion() {
  try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return "0.0.0"; }
}

/* Resolve the update API URL in priority order:
   1. SPLITPAGE_UPDATE_API env var (the operator's own choice, on this machine)
   2. Default hard-coded URL

   `updateApi` from the local .splitpage-release.json used to sit between
   those two, and it must not (#64): that file arrived with the last release
   this copy downloaded, so a single bad release could point every future
   update check somewhere else, permanently, with nothing left to notice it.
   The manifest is a record of what was installed, not a say in where the
   next one comes from. Nothing that ships in a release gets a vote here.
   Exported so start.mjs can use the same resolution logic. */
export function updateApiUrl() {
  if (process.env.SPLITPAGE_UPDATE_API) return process.env.SPLITPAGE_UPDATE_API;
  return DEFAULT_API;
}

/* ---------- the remote release ---------- */

export async function latestRelease() {
  const res = await fetch(updateApiUrl(), { headers: { "Accept": "application/vnd.github+json", "User-Agent": "splitpage-updater" } });
  if (!res.ok) throw new Error(`update check failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  const version = String(body.tag_name || body.name || "").replace(/^v/, "").trim();
  if (!version) throw new Error("the release has no version tag");
  return { version, url: String(body.html_url || ""), notes: body.body || "" };
}

/* ---------- the one command ---------- */

export async function check() {
  const current = localVersion();
  const release = await latestRelease();
  const newer = compareVersions(release.version, current) > 0;
  say(`  installed: ${current}`);
  say(`  available: ${release.version}${newer ? "" : "  (you are up to date)"}`);
  if (newer) {
    say(`\n  Download it from ${release.url || "the releases page"} and unzip it over this copy,`);
    say(`  or install the desktop app, which updates itself.\n`);
  }
  return { current, release, newer };
}

/* ---------- run ---------- */

/* Only when invoked directly — start.mjs imports compareVersions() and
   updateApiUrl() and does its own check in the background. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { current, release, newer } = await check();
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify({
        ok: true, version: current, latest: release.version, updateAvailable: newer, releaseUrl: release.url
      }) + "\n");
    }
  } catch (err) {
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: "failed", message: err.message }) + "\n");
    else console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
}
