import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { randomBytes, randomInt } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";
import { networkInterfaces } from "node:os";
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
  node start.mjs --library      keep documents on the server, in ./data
  node start.mjs --host         host a shared session others on your network
                                can open and edit (implies --library)
  node start.mjs --port 9000    use a different port (default 8791)
  node start.mjs --no-open      don't launch a browser
  node start.mjs --data DIR     where --library keeps documents
                                (default: ./data beside this script)
  node start.mjs --no-update-check
                                don't look for a new version in the background

Sharing:

  --pin [1234]                  ask everyone who joins for this code. With no
                                value, one is generated and printed. The code
                                travels in the clear over plain HTTP: fine on
                                your own network, not on a public one.
  --review-pin [5678]           a SECOND code that opens the documents to be
                                read and commented on and nothing else. With
                                no value, one is generated and printed.
  --share-readonly              shorthand for --review-pin with no value; with
                                --host and no --pin, generates both codes.
  --allow-origin <origin>       let a copy of Splitpage served from somewhere
                                else talk to this server (repeatable; use
                                "null" for a copy opened straight off disk)

Joining someone else's server over SSH:

  node start.mjs --tunnel me@host [--remote-port 8791] [--local-port 8791]

  Runs ssh -N -L <local>:localhost:<remote> me@host, waits for the tunnel,
  and opens the browser at http://localhost:<local>/. Nothing of yours is
  served; closing this window closes the tunnel.

Updates are not installed by this launcher (#75): it only looks for one and
says so. "node update.mjs" prints the same answer from a terminal; unzip a
newer release over this copy, or use the desktop app, which updates itself.
`);
  process.exit(0);
}

const HOSTING = has("--host");
const LIBRARY = HOSTING || has("--library");
const DATA_DIR = valueOf("--data", join(ROOT, "data"));
const WANTED_PORT = Number(valueOf("--port", 8791));
if (!Number.isInteger(WANTED_PORT) || WANTED_PORT < 1 || WANTED_PORT > 65535) {
  console.error("--port must be a number between 1 and 65535");
  process.exit(1);
}

function isPort(n) { return Number.isInteger(n) && n > 0 && n < 65536; }

function generatePin() {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

let joinPin = "";
if (has("--pin")) {
  const given = valueOf("--pin", "");
  joinPin = (given && !given.startsWith("--")) ? given.trim() : generatePin();
}

let reviewPin = "";
if (has("--review-pin") || has("--share-readonly")) {
  const given = valueOf("--review-pin", "");
  reviewPin = (given && !given.startsWith("--")) ? given.trim() : generatePin();
  if (!joinPin) joinPin = generatePin();
  if (reviewPin === joinPin) {
    console.error("--review-pin and --pin must be different codes.");
    process.exit(1);
  }
}
const reviewKey = reviewPin ? randomBytes(16).toString("hex") : "";

function valuesOf(flag) {
  const out = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1].trim());
  }
  return out;
}
const ALLOW_ORIGINS = valuesOf("--allow-origin").filter(Boolean);

if (has("--tunnel")) {
  const target = valueOf("--tunnel", "");
  if (!target || target.startsWith("--")) {
    console.error("--tunnel needs a destination, e.g. --tunnel me@studio.example.com");
    process.exit(1);
  }
  const remotePort = Number(valueOf("--remote-port", 8791));
  const localPort = Number(valueOf("--local-port", String(remotePort)));
  if (!isPort(remotePort) || !isPort(localPort)) {
    console.error("--remote-port and --local-port must be numbers between 1 and 65535");
    process.exit(1);
  }

  const forward = `${localPort}:localhost:${remotePort}`;
  console.log(`
  Opening an SSH tunnel to ${target}
      ssh -N -L ${forward} ${target}

  If it asks for a password or a key passphrase, answer it here.
  Close this window to close the tunnel.
`);

  const ssh = spawn("ssh", ["-N", "-L", forward, target], { stdio: ["inherit", "inherit", "inherit"] });

  ssh.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      console.error(`
  Could not find ssh on this computer.

  On Windows 10/11: Settings > System > Optional features > Add a feature,
  then install "OpenSSH Client". On macOS and Linux it is already there.
`);
    } else {
      console.error("  The tunnel could not start: " + (err && err.message));
    }
    process.exit(1);
  });
  ssh.on("exit", (code) => {
    console.log("\n  The tunnel closed.");
    process.exit(code == null ? 0 : code);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { ssh.kill(); process.exit(0); });
  }

  const tunnelUrl = `http://localhost:${localPort}/`;
  const ready = await waitForPort(localPort);
  if (!ready) {
    console.error(`
  The tunnel did not come up on port ${localPort}. Look for an ssh message above —
  a wrong host, a refused key, or something already listening on that port
  are the usual reasons. Try --local-port with a different number.
`);
    ssh.kill();
    process.exit(1);
  }

  console.log(`  Connected. Splitpage is at ${tunnelUrl}\n`);
  if (!has("--no-open")) openBrowser(tunnelUrl);
  await new Promise(() => {});
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
    probe.listen(port, HOSTING ? "0.0.0.0" : "127.0.0.1");
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
writeStatus({ checking: willCheck });

if (willCheck) {
  (async () => {
    try {
      const res = await fetch(updater.updateApiUrl(),
        { headers: { "Accept": "application/vnd.github+json", "User-Agent": "splitpage-launcher" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json();
      const latest = String(body.tag_name || body.name || "").replace(/^v/, "").trim();
      const current = readVersion() || "0.0.0";
      writeStatus({
        latest,
        updateAvailable: !!latest && updater.compareVersions(latest, current) > 0,
        checking: false,
        error: undefined
      });
    } catch (err) {
      writeStatus({ error: err.message, checking: false });
    }
  })();
}

const launchToken = HOSTING ? "" : randomBytes(16).toString("hex");

const server = spawn(process.execPath, [join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    PORT: String(port),
    HOST: HOSTING ? "0.0.0.0" : "127.0.0.1",
    STATIC_DIR: ROOT,
    DATA_DIR,
    NO_API: LIBRARY ? "0" : "1",
    JOIN_PIN: joinPin,
    REVIEW_PIN: reviewPin,
    REVIEW_KEY: reviewKey,
    ALLOW_ORIGINS: ALLOW_ORIGINS.join(","),
    LAUNCH_TOKEN: launchToken
  }
});

server.on("exit", (code) => process.exit(code == null ? 0 : code));

const url = `http://localhost:${port}/`;
const openUrl = launchToken ? `${url}#launch=${launchToken}` : url;

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

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

console.log(`
  Splitpage is running at ${url}
  ${LIBRARY ? `Documents are kept on the server, in ${DATA_DIR}` : "Documents are files you save to disk (--library keeps them on the server)"}
`);

if (HOSTING) {
  const addresses = lanAddresses();
  console.log("  Other people on your network open one of these:");
  if (addresses.length) {
    for (const address of addresses) console.log(`      http://${address}:${port}/`);
  } else {
    console.log("      (no network address found — are you connected?)");
  }
  if (joinPin) {
    const line = "  " + "+" + "-".repeat(30) + "+";
    console.log(`
  They will be asked for this code:

${line}
  |        JOIN PIN   ${joinPin}${" ".repeat(Math.max(1, 11 - joinPin.length))}|
${line}

  Read it out to them; don't post it anywhere the address is posted. The
  code is checked by this computer but travels in the clear over plain
  HTTP, so anyone able to watch the network can read it as it goes past —
  fine on your own network, not on a public one or over the internet. For
  the internet, run the server image behind a Cloudflare tunnel (DEPLOY.md).
  Close this window to stop sharing.`);
    if (reviewPin) {
      console.log(`
  To let someone READ and COMMENT but not edit, send them one of these
  instead:
`);
      if (addresses.length) {
        for (const address of addresses) console.log(`      http://${address}:${port}/#review=${reviewKey}`);
      } else {
        console.log("      (no network address found — are you connected?)");
      }
      console.log(`
  or give them the address above and this code:

${line}
  |      REVIEW PIN   ${reviewPin}${" ".repeat(Math.max(1, 11 - reviewPin.length))}|
${line}

  They can read the script, run the teleprompter, export it and leave
  comments; the server refuses every other change, so it does not matter
  what their copy of the app lets them click. Restarting this window
  invalidates the link and both codes.`);
    }
  } else {
    console.log(`
  Anyone who can reach that address can read and edit these scripts —
  there is no password. Fine on your own network, not on a public one.
  Add --pin to ask everyone who joins for a code instead.
  Close this window to stop sharing.`);
  }
}

if (joinPin && !HOSTING) {
  console.log(`  This copy asks for a join PIN: ${joinPin}
`);
  if (reviewPin) {
    console.log(`  Read and comment only: ${url}#review=${reviewKey}
  (or the address above with the code ${reviewPin})
`);
  }
}

console.log(`
  In Chrome or Edge, use the install icon in the address bar to add it as
  its own app window. Leave this window open while you work; Ctrl+C stops it.
`);

if (!has("--no-open")) openBrowser(openUrl);
else if (launchToken) console.log(`  Open it yourself at ${openUrl}
  (the #launch part is what lets this page offer to add itself to the Start
  Menu; it is valid for this run only)
`);

function openBrowser(target) {
  const opener =
    platform === "win32" ? { cmd: "cmd", args: ["/c", "start", "", target] }
    : platform === "darwin" ? { cmd: "open", args: [target] }
    : { cmd: "xdg-open", args: [target] };
  const child = spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`  (Could not open a browser — go to ${target} yourself.)`));
  child.unref();
}

async function waitForPort(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.kill(); process.exit(0); });
}
