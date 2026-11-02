import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";
import { writeFileSync, readFileSync } from "node:fs";

const ROOT = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
function valueOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
}

if (has("--help") || has("-h")) {
  console.log(`
Splitpage launcher

  node start.mjs                serve the app and open it in your browser
  node start.mjs --port 9000    use a different port (default 8791)
  node start.mjs --no-open      don't launch a browser
  node start.mjs --no-update-check
                                don't look for a new version in the background

Updates are not installed by this launcher (#75): it only looks for one and
says so. "node update.mjs" prints the same answer from a terminal; unzip a
newer release over this copy, or use the desktop app, which updates itself.
`);
  process.exit(0);
}

const WANTED_PORT = Number(valueOf("--port", 8791));
if (!Number.isInteger(WANTED_PORT) || WANTED_PORT < 1 || WANTED_PORT > 65535) {
  console.error("--port must be a number between 1 and 65535");
  process.exit(1);
}

if (existsSync(join(ROOT, "build.mjs")) && existsSync(join(ROOT, "src"))) {
  const built = spawn(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, stdio: "inherit" });
  const code = await new Promise((r) => built.on("exit", r));
  if (code !== 0) {
    console.error("\nBuild failed — not starting. Fix the error above and try again.");
    process.exit(1);
  }
}

if (!existsSync(join(ROOT, "index.html"))) {
  console.error("index.html is missing, and there is no src/ to build it from.");
  process.exit(1);
}

function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

let port = WANTED_PORT;
for (let i = 0; i < 20 && !(await isFree(port)); i++) port++;
if (!(await isFree(port))) {
  console.error(`Ports ${WANTED_PORT}-${port} are all busy. Try --port with something else.`);
  process.exit(1);
}
if (port !== WANTED_PORT) {
  console.log(`Port ${WANTED_PORT} was busy — using ${port} instead.`);
}

const STATUS_FILE = join(ROOT, "update-status.json");

let updater = null;
try { updater = await import("./update.mjs"); } catch { }

function readVersion() {
  try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return null; }
}

function readStatus() {
  try { return JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return {}; }
}

function writeStatus(extra) {
  const previous = readStatus();
  const version = readVersion();
  const latest = extra.latest !== undefined ? extra.latest : (previous.latest ?? null);
  const status = {
    ...previous,
    pending: null,
    justUpdated: null,
    version,
    checkedAt: new Date().toISOString(),
    latest,
    updateAvailable: !!latest && !!version && updater
      ? updater.compareVersions(latest, version) > 0
      : false,
    ...extra,
    ...(extra.updateAvailable === undefined ? {} : { updateAvailable: extra.updateAvailable })
  };
  if (status.latest && version && updater && updater.compareVersions(status.latest, version) <= 0) {
    status.updateAvailable = false;
  }
  try { writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + "\n"); } catch { }
}

const willCheck = !has("--no-update-check") && !!updater;
writeStatus({ checking: willCheck, ...(willCheck ? { latest: null, updateAvailable: false } : {}) });

if (willCheck) {
  (async () => {
    try {
      const release = await updater.latestRelease();
      const latest = release.version;
      const current = readVersion() || "0.0.0";
      writeStatus({
        latest,
        updateAvailable: !!latest && updater.compareVersions(latest, current) > 0,
        checking: false,
        error: undefined
      });
    } catch (err) {
      writeStatus({ latest: null, updateAvailable: false, error: err.message, checking: false });
    }
  })();
}

const server = spawn(process.execPath, [join(ROOT, "server", "server.ts")], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    STATIC_DIR: ROOT
  }
});

server.on("exit", (code) => process.exit(code == null ? 0 : code));

const url = `http://localhost:${port}/`;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url + "index.html", { method: "HEAD" });
      if (res.ok) return true;
    } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (!(await waitForServer())) {
  console.error("The server did not come up. Look for an error above.");
  server.kill();
  process.exit(1);
}

console.log(`
  Splitpage is running at ${url}
  Documents are files you save to disk.

  In Chrome or Edge, use the install icon in the address bar to add it as
  its own app window. Leave this window open while you work; Ctrl+C stops it.
`);

if (!has("--no-open")) openBrowser(url);

function openBrowser(target) {
  const opener =
    platform === "win32" ? { cmd: "cmd", args: ["/c", "start", "", target] }
    : platform === "darwin" ? { cmd: "open", args: [target] }
    : { cmd: "xdg-open", args: [target] };
  const child = spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`  (Could not open a browser — go to ${target} yourself.)`));
  child.unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.kill(); process.exit(0); });
}
