#!/usr/bin/env node
/* Splitpage launcher — one command, any OS.
 *
 *   node start.mjs              serve the app and open it in your browser
 *   node start.mjs --library    also run the document server (see below)
 *   node start.mjs --port 9000  use a different port
 *   node start.mjs --no-open    don't launch a browser
 *   node start.mjs --data DIR   where --library keeps documents
 *   node start.mjs --pin        require a join PIN (generated and printed)
 *   node start.mjs --tunnel me@host   reach someone else's server over SSH
 *   node start.mjs --no-update-check   skip the background update check
 *
 * WHY SERVE IT AT ALL, rather than just opening index.html?
 * Browsers only give a page installed-app status, a service worker (offline
 * use) and a microphone when it arrives over http(s). Opened off disk as a
 * file:// URL, Splitpage still edits and exports fine, but "Install app" and
 * Follow My Voice are both unavailable. That is the whole reason this exists.
 *
 * DEFAULT MODE IS DELIBERATELY DUMB. It serves files and nothing else, so the
 * app stays in local mode: a document is an .html file you save to disk, which
 * is the workflow this tool has always had. --library additionally runs the
 * document API and keeps documents on the server in ./data — the same thing
 * the Docker image does, minus the sharing.
 */

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

/* ---------- arguments ---------- */

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
  --allow-origin <origin>       let a copy of Splitpage served from somewhere
                                else talk to this server (repeatable; use
                                "null" for a copy opened straight off disk)

Joining someone else's server over SSH:

  node start.mjs --tunnel me@host [--remote-port 8791] [--local-port 8791]

  Runs ssh -N -L <local>:localhost:<remote> me@host, waits for the tunnel,
  and opens the browser at http://localhost:<local>/. Nothing of yours is
  served; closing this window closes the tunnel.

Updates install at launch and never while the app is open (see update.mjs):
  node update.mjs   downloads one, and the next start puts it in place.
`);
  process.exit(0);
}

/* Hosting is sharing, and sharing means the documents have to live somewhere
   both people can reach — so it implies the library. */
const HOSTING = has("--host");
const LIBRARY = HOSTING || has("--library");
/* An installed copy lives somewhere the user does not browse, so documents
   should be able to live somewhere they do. */
const DATA_DIR = valueOf("--data", join(ROOT, "data"));
const WANTED_PORT = Number(valueOf("--port", 8791));
if (!Number.isInteger(WANTED_PORT) || WANTED_PORT < 1 || WANTED_PORT > 65535) {
  console.error("--port must be a number between 1 and 65535");
  process.exit(1);
}

function isPort(n) { return Number.isInteger(n) && n > 0 && n < 65536; }

/* ---------- the join PIN ----------
 *
 * `--pin` on its own generates one; `--pin 4821` uses what you chose. Either
 * way it goes to the server as an environment variable and is printed once,
 * here, for you to read out to whoever is joining. It is never written to
 * update-status.json or anywhere else on disk (invariant #29) — that file is
 * served to anyone who can reach the port, which is exactly the audience the
 * PIN exists to keep out.
 */
function generatePin() {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

let joinPin = "";
if (has("--pin")) {
  const given = valueOf("--pin", "");
  joinPin = (given && !given.startsWith("--")) ? given.trim() : generatePin();
}

/* Repeatable, unlike everything else here: a portable copy on disk and a
   colleague's hosted copy are two different origins and both may need to
   reach one server. */
function valuesOf(flag) {
  const out = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1].trim());
  }
  return out;
}
const ALLOW_ORIGINS = valuesOf("--allow-origin").filter(Boolean);

/* ---------- --tunnel: join someone else's server over SSH ----------
 *
 * A mode of its own, handled before anything else: it serves nothing, builds
 * nothing and installs nothing. All it does is forward a local port to the
 * remote machine's Splitpage and open a browser at it, so the connection is
 * encrypted and authenticated by SSH and the remote port never has to face
 * the internet. Splitpage stores no credentials for this and never will —
 * ssh's own keys and agent do that job.
 */
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

  /* An argument array, never a shell: a destination with a space or a
     semicolon in it is then just a destination ssh will reject, not
     something a shell would run. -N means "no remote command" — this
     forwards a port and does nothing else. */
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
  /* ssh keeps this process alive; there is nothing else to do here. */
  await new Promise(() => {});
}

/* ---------- install anything update.mjs staged ----------
 *
 * Here, before the server starts and before a browser has the app open: this
 * is the one moment when replacing index.html is safe. update.mjs only ever
 * downloads and verifies; the swap happens exactly here.
 */

let applied = null;
if (existsSync(join(ROOT, "update.mjs"))) {
  try {
    const updater = await import("./update.mjs");
    applied = updater.apply({ log: (m) => console.log(m) });
  } catch (err) {
    /* A failed update rolls itself back, so the old version is still intact
       and the right thing to do is start it and say what happened. */
    console.error(`  update could not be installed: ${err.message}`);
    console.error("  starting the version you already had.");
  }
}

/* ---------- build, if this is a source checkout ---------- */

/* A downloaded release is just the built files, with no src/ and nothing to
   build. In a checkout, building first means you never debug a change you
   forgot to compile. */
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

/* ---------- find a port ---------- */

/* Probes whatever address the real server will actually bind — always
   127.0.0.1 before, regardless of --host, while server.js binds 0.0.0.0
   whenever HOSTING is set. A wildcard bind can conflict with something
   already listening on a specific interface (or vice versa) in ways a
   loopback-only probe can never see, so a "free" port here could still
   fail in the real server. */
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

/* ---------- tell the app where it stands ----------
 *
 * A plain file the page fetches. The app can then show "an update is ready"
 * without this process growing an HTTP route that installs things — which,
 * on an unauthenticated localhost server, would be reachable from any other
 * page in the browser.
 */

const STATUS_FILE = join(ROOT, "update-status.json");

let updater = null;
try { updater = await import("./update.mjs"); } catch { /* a release without it */ }

function readVersion() {
  try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return null; }
}

function readStatus() {
  try { return JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return {}; }
}

function writeStatus(extra) {
  const previous = readStatus();
  const version = readVersion();
  /* Carry forward what the last run learned. Starting from a blank slate
     every launch would hide a known update whenever the check is skipped
     (--no-update-check) or fails (offline) — which is exactly when the file
     is the only thing that still knows. updateAvailable is recomputed rather
     than carried, so it goes false by itself once the update is installed. */
  const latest = extra.latest !== undefined ? extra.latest : (previous.latest ?? null);
  const status = {
    /* Carry the whole previous status forward, not just `latest` — a
       field like justUpdated (set right after applying a staged update,
       for the frontend to show a "you're now on vX" banner) used to be
       silently dropped the moment ANY later writeStatus() call didn't
       itself re-supply it, which the background update-check does
       moments later. Fields below override this as intended; `extra`
       (the caller's actual update) always wins last. */
    ...previous,
    version,
    checkedAt: new Date().toISOString(),
    latest,
    updateAvailable: !!latest && !!version && updater
      ? updater.compareVersions(latest, version) > 0
      : false,
    ...extra,
    /* ...but never let a stale updateAvailable from `extra` win over the
       recomputation above when the versions say otherwise. */
    ...(extra.updateAvailable === undefined ? {} : { updateAvailable: extra.updateAvailable })
  };
  if (status.latest && version && updater && updater.compareVersions(status.latest, version) <= 0) {
    status.updateAvailable = false;
  }
  try { writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + "\n"); } catch { /* read-only dir */ }
}

writeStatus({ pending: updater ? updater.pending() : null, justUpdated: applied });

/* Deliberately not awaited: a slow or unreachable update server must never
   delay the app opening. Whatever it finds lands in the file, and the page
   picks it up on this load or the next one. */
if (!has("--no-update-check") && updater) {
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
        pending: updater.pending()
      });
    } catch (err) {
      writeStatus({ error: err.message, pending: updater.pending() });
    }
  })();
}

/* ---------- run the server ---------- */

/* One secret per launch, for the wizard's "add this copy to the Start Menu"
   step and nothing else. It goes to the server as an environment variable and
   to the page in the URL fragment (which browsers never send to a server and
   no proxy log records), and the page moves it straight into sessionStorage
   and strips it out of the address bar. Never under --host: server.js refuses
   those routes off loopback anyway, and not minting a key you cannot use is
   one less thing to get wrong. */
const launchToken = HOSTING ? "" : randomBytes(16).toString("hex");

const server = spawn(process.execPath, [join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    PORT: String(port),
    /* Loopback unless the user asked to host. There is no authentication in
       that process by design, so reaching the network is never the default
       and never silent — see the warning printed below. Putting it on the
       INTERNET is a different job again: the Docker image behind Cloudflare
       Access, in DEPLOY.md. */
    HOST: HOSTING ? "0.0.0.0" : "127.0.0.1",
    STATIC_DIR: ROOT,
    DATA_DIR,
    NO_API: LIBRARY ? "0" : "1",
    /* Empty means "no PIN" and "same-origin only" respectively, which is what
       server.js has always done — passing them unconditionally keeps the two
       processes' idea of the rules in one place. */
    JOIN_PIN: joinPin,
    ALLOW_ORIGINS: ALLOW_ORIGINS.join(","),
    LAUNCH_TOKEN: launchToken
  }
});

server.on("exit", (code) => process.exit(code == null ? 0 : code));

/* ---------- wait for it, then open a browser ---------- */

const url = `http://localhost:${port}/`;
/* The fragment is the launch token's whole delivery mechanism — see above. */
const openUrl = launchToken ? `${url}#launch=${launchToken}` : url;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url + "index.html", { method: "HEAD" });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (!(await waitForServer())) {
  console.error("The server did not come up. Look for an error above.");
  server.kill();
  process.exit(1);
}

/* Every address someone else could actually type. */
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
  /* Said plainly, every time, because it cannot be inferred from the URL:
     what does and does not stand between a stranger and these scripts. On a
     home or office network an open session is the point; on a cafe's wifi it
     is a mistake, and nobody should have to read the source to find that out. */
  if (joinPin) {
    /* ASCII, deliberately: this window is cmd.exe on most machines and a box
       drawn in anything else comes out as mojibake around the one number the
       user has to read out loud. */
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
  the internet, put Splitpage behind Cloudflare Access (see DEPLOY.md).
  Close this window to stop sharing.`);
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

/* Handed to the OS opener as a single argument and never through a shell, so
   the URL cannot be reinterpreted as anything else. */
function openBrowser(target) {
  const opener =
    platform === "win32" ? { cmd: "cmd", args: ["/c", "start", "", target] }
    : platform === "darwin" ? { cmd: "open", args: [target] }
    : { cmd: "xdg-open", args: [target] };
  const child = spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`  (Could not open a browser — go to ${target} yourself.)`));
  child.unref();
}

/* Something is listening and accepting connections on this local port. Used
   by --tunnel, where "up" is ssh having bound the forward — there is no HTTP
   to probe until it has, and the far end may want a passphrase first, so the
   wait is generous. */
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

/* Ctrl+C should stop the server too, not orphan it. */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.kill(); process.exit(0); });
}
