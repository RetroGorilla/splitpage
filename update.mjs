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
