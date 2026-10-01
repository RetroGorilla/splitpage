import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

const DEFAULT_API = "https://api.github.com/repos/RetroGorilla/splitpage-releases/releases/latest";

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const QUIET = argv.includes("--quiet") || JSON_OUT;
const say = (...a) => { if (!QUIET) console.log(...a); };

export function compareVersions(a, b) {
  const va = splitVersion(a), vb = splitVersion(b);
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const na = va.core[i] || 0, nb = vb.core[i] || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
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

export function updateApiUrl() {
  if (process.env.SPLITPAGE_UPDATE_API) return process.env.SPLITPAGE_UPDATE_API;
  return DEFAULT_API;
}

export async function latestRelease() {
  const res = await fetch(updateApiUrl(), { headers: { "Accept": "application/vnd.github+json", "User-Agent": "splitpage-updater" } });
  if (!res.ok) throw new Error(`update check failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  const version = String(body.tag_name || body.name || "").replace(/^v/, "").trim();
  if (!version) throw new Error("the release has no version tag");
  return { version, url: String(body.html_url || ""), notes: body.body || "" };
}

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

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
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
