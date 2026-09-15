/* Splitpage document server.
 *
 * Serves the app's static files and a small document API from one origin, so
 * a Cloudflare Access cookie covers both and the service worker stays in
 * scope. No dependencies — plain Node (18+), so the image is just `node:alpine`
 * plus this file and there is nothing to audit but what you can read here.
 *
 * There is no *real* authentication in this process. It is designed to sit
 * behind Cloudflare Access (or a VPN), which rejects unauthenticated requests
 * before they arrive. If you expose this port directly to the internet,
 * anyone who finds it can read and rewrite every document. See DEPLOY.md.
 *
 * JOIN_PIN is the one exception, and it is a small one: a shared code that
 * stops a curious neighbour on the same wifi from opening your scripts. It
 * travels in the clear over plain HTTP, so it is a door lock for a LAN, not
 * a substitute for Access on the internet.
 *
 * Storage is one JSON file per document in DATA_DIR. That is the whole
 * database: no index to corrupt, and `cp -r` is a valid backup.
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const child_process = require("node:child_process");

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "..", "public");
/* A script with a few embedded images gets large. 25 MB is roomy for that and
   still small enough that a runaway client can't fill the array. */
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
/* Set READ_ONLY=1 to publish a library nobody can write to. */
const READ_ONLY = process.env.READ_ONLY === "1";
/* Set NO_API=1 to serve the app and nothing else. The local launcher uses this
   for its default mode: with no /api to find, the client's health probe fails
   and it stays in local mode, where a document is a file you save to disk.
   That is the workflow start.bat has always given, and turning it into a
   server-side library because a launcher happened to run Node would be a
   surprise, not an upgrade. `start --library` is the opt-in. */
const NO_API = process.env.NO_API === "1";

/* ---------- the join PIN ----------
 *
 * Empty (the default) means open, exactly as this server has always been.
 * Set it and every /api/* route except /api/health and /api/join needs a
 * token, which a client gets by posting the right PIN once.
 *
 * The token lives in this process's memory and nowhere else: it is minted at
 * startup, never written to disk, never logged, and never put in
 * update-status.json or any file the static handler serves (invariant #29).
 * Restarting the server invalidates every session, which is the right
 * trade for a tool you start when you want to share and close when you stop.
 */
const JOIN_PIN = String(process.env.JOIN_PIN || "");
const SESSION_TOKEN = crypto.randomBytes(32).toString("hex");

/* Origins allowed to call this API from another page — a comma list, empty
   (the default) meaning same-origin only. A copy of the app opened from disk
   sends `Origin: null`, so the literal entry `null` is what lets a portable
   copy talk to a server; see DEPLOY.md for why that is broader than it looks. */
const ALLOW_ORIGINS = String(process.env.ALLOW_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

/* Set by start.mjs, per launch, for the wizard's "install this copy" step.
   Absent (a Docker deployment, or a server started by hand) the launcher
   routes do not exist at all. */
const LAUNCH_TOKEN = String(process.env.LAUNCH_TOKEN || "");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

/* ---------- identity ----------
 *
 * Cloudflare Access puts the signed-in user's email on every request it lets
 * through. We only ever read it for display and attribution — it is not a
 * permission check, because by the time a request is here Access has already
 * made that decision. Behind a VPN instead, these headers are simply absent
 * and the app falls back to asking for a name, exactly like the local build.
 */
function identityOf(req) {
  const email = String(req.headers["cf-access-authenticated-user-email"] || "").trim();
  if (!email || email.length > 200 || !email.includes("@")) return { email: null, name: null };
  /* "priya.malhotra" -> "Priya Malhotra": a decent default someone can still
     overwrite. Nothing here is verified beyond Access having signed them in. */
  const name = email.split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { email, name: name || null };
}

/* ---------- the join PIN, CORS, and the launch token ----------
 *
 * Everything in this block is about *who may call the API*, and it is the
 * only place in the process that decides that. Three separate keys, on
 * purpose: the PIN is shared with people, the session token is what the
 * browser then carries, and the launch token belongs to the launcher that
 * started this process and to nothing else.
 */

/* Constant-time by construction: both sides are hashed to a fixed 32 bytes
   first, so timingSafeEqual never sees mismatched lengths (which throws) and
   the comparison leaks neither the PIN's length nor how far it matched. */
function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given == null ? "" : given)).digest();
  const b = crypto.createHash("sha256").update(String(expected == null ? "" : expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/* A wrong PIN is cheap to guess six digits at a time, so make guessing
   expensive: ten failures from one address in a minute and that address is
   told to come back later. In memory, per process — a launcher that runs for
   an afternoon does not need a store for this, and neither does a container. */
const PIN_WINDOW_MS = 60 * 1000;
const PIN_MAX_FAILURES = 10;
const pinFailures = new Map();

function clientIp(req) {
  return String((req.socket && req.socket.remoteAddress) || "unknown");
}

function recentFailures(ip) {
  const now = Date.now();
  const list = (pinFailures.get(ip) || []).filter((t) => now - t < PIN_WINDOW_MS);
  if (list.length) pinFailures.set(ip, list); else pinFailures.delete(ip);
  /* Nothing else prunes this map, and an attacker gets to choose the key by
     choosing a source address. Sweep the whole thing whenever it grows past
     anything a real shared session would produce. */
  if (pinFailures.size > 1000) {
    for (const [key, times] of pinFailures) {
      if (!times.some((t) => now - t < PIN_WINDOW_MS)) pinFailures.delete(key);
    }
  }
  return list;
}

function noteFailure(ip) {
  const list = recentFailures(ip);
  list.push(Date.now());
  pinFailures.set(ip, list);
}

function hasSessionToken(req) {
  const given = String(req.headers["x-splitpage-token"] || "");
  /* length check first: timingSafeEqual throws on a length mismatch, and the
     token's length is not a secret (it is always 64 hex characters) */
  if (given.length !== SESSION_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(SESSION_TOKEN));
}

/* Echoed only for an origin that was explicitly allowed, never `*`, and never
   with Allow-Credentials: a cross-origin caller proves itself with the token
   header, so there is no reason to let a browser attach a cookie it happens
   to hold for this host. */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || ALLOW_ORIGINS.indexOf(origin) === -1) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "content-type, x-splitpage-token, x-splitpage-launch",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"
  };
}

/* The version this copy is, for a client deciding whether it is talking to
   something older than itself. VERSION sits beside the static files in every
   layout we ship (the launcher points STATIC_DIR at the app folder; the
   Docker image copies both into /app/public). */
const VERSION = (() => {
  if (process.env.SPLITPAGE_VERSION) return String(process.env.SPLITPAGE_VERSION).trim();
  for (const dir of [STATIC_DIR, path.join(STATIC_DIR, ".."), path.join(__dirname, "..")]) {
    try {
      const v = fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim();
      if (v) return v;
    } catch (e) { /* not there — try the next */ }
  }
  return null;
})();

/* ---------- document ids ----------
 *
 * An id becomes a filename, so it is validated as a strict whitelist rather
 * than sanitised. Anything that is not lowercase alphanumeric plus dashes is
 * rejected outright — that is what stops "../../etc/passwd" and friends, and
 * a whitelist cannot be out-thought the way a blacklist can.
 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function slugify(title) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = crypto.randomBytes(3).toString("hex");
  return (base ? base + "-" + suffix : "doc-" + suffix);
}

function docPath(id) {
  return path.join(DATA_DIR, id + ".json");
}

/* ---------- serialised writes ----------
 *
 * Node handles one request at a time per tick, but a read-modify-write spans
 * awaits, so two saves of the same document can interleave and the second can
 * be written from a stale read. Every write for an id is chained behind the
 * previous one, which makes the compare-and-set below actually atomic.
 */
const writeChains = new Map();

function withDocLock(id, fn) {
  const prev = writeChains.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  /* keep the chain from growing without bound, and never let a rejection
     poison the next writer */
  const settled = next.then(() => {}, () => {});
  writeChains.set(id, settled);
  /* Nothing ever pruned an id out of this map — not even on DELETE — so
     it grew by one permanent entry for every distinct document id ever
     written, for the life of the process. Once this write settles, drop
     the entry entirely if nothing queued a newer write for the same id
     in the meantime (identity check: writeChains.get(id) is still the
     exact promise we just stored here). */
  settled.then(() => {
    if (writeChains.get(id) === settled) writeChains.delete(id);
  });
  return next;
}

async function readDoc(id) {
  try {
    const raw = await fsp.readFile(docPath(id), "utf8");
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== "object") return null;
    return doc;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/* Write to a temp file in the same directory and rename over the target.
   Rename is atomic within a filesystem, so a crash or a full disk leaves the
   previous version intact rather than a half-written one. */
async function writeDoc(doc) {
  const target = docPath(doc.id);
  const tmp = target + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(doc), "utf8");
  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/* ---------- http helpers ---------- */

function sendJson(res, status, body, opts) {
  const payload = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    /* documents must never be cached by the browser or by Cloudflare — a
       stale rev would make the client think it is up to date and clobber */
    "Cache-Control": "no-store"
  };
  /* Set when we are answering without having read the rest of the request
     body (an over-length upload). The client is still sending; keeping the
     connection alive would leave its unread bytes in front of the next
     request on it, so this response ends the connection. */
  if (opts && opts.close) headers["Connection"] = "close";
  /* Stamped on the response object by the request handler below, where the
     request is still in scope. Doing it there rather than threading `req`
     through every sendJson() call site means a route added later cannot
     forget the CORS headers — and static files, which are answered without
     this helper, still never get them. */
  if (res.corsHeaders) Object.assign(headers, res.corsHeaders);
  res.writeHead(status, headers);
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        /* Pause rather than destroy. req.destroy() tears the socket down
           immediately, so the 413 below never reaches the client and it sees
           a connection reset instead of a message telling it the document is
           too big — which, for a script carrying too many embedded images, is
           the one thing the user needs to be told. The socket is closed for
           real once that response has been written (Connection: close). */
        aborted = true;
        chunks.length = 0;
        req.pause();
        reject(Object.assign(new Error("too-large"), { code: "TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(Object.assign(new Error("bad-json"), { code: "BAD_JSON" }));
      }
    });
    req.on("error", reject);
  });
}

/* A summary for the picker: enough to choose a document without shipping
   every row of every script to build a list. */
function summarise(doc) {
  const state = doc.state || {};
  return {
    id: doc.id,
    title: (state.title || "Untitled Script"),
    rev: doc.rev || 0,
    rows: Array.isArray(state.rows) ? state.rows.length : 0,
    updatedAt: doc.updatedAt || null,
    updatedBy: doc.updatedBy || null
  };
}

/* ---------- the launcher's routes ----------
 *
 * This is the ONE place in the process that runs another program (invariant
 * #28), and it exists so the first-run wizard can offer "put this copy in
 * the Start Menu" without the user going to find a command line.
 *
 * Three locks, all of which must be open:
 *   1. a launch token, minted by start.mjs for this launch and handed to the
 *      page in the URL fragment — so another tab in the same browser, which
 *      can reach localhost just as easily, cannot call this;
 *   2. HOST === "127.0.0.1" — never under --host, where the port is on the
 *      network and "install something" would be a remote code execution
 *      route with a friendly name;
 *   3. the script it runs is a fixed path inside this installation. Nothing
 *      from the request reaches a command line.
 *
 * A refusal is 404, not 401: when these conditions are not met the routes
 * genuinely do not exist, and saying so gives a prober nothing to work with.
 */

function launcherAllowed(req) {
  if (!LAUNCH_TOKEN || HOST !== "127.0.0.1") return false;
  const given = String(req.headers["x-splitpage-launch"] || "");
  if (given.length !== LAUNCH_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(LAUNCH_TOKEN));
}

/* Is there an Add/Remove Programs entry pointing at THIS folder? Not "is
   Splitpage installed" — a portable copy sitting next to an installed one
   must still be able to offer to register itself. */
function installedHere(root) {
  if (process.platform !== "win32") return false;
  const key = "\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Splitpage";
  for (const hive of ["HKCU", "HKLM"]) {
    let out;
    try {
      out = child_process.spawnSync("reg", ["query", hive + key, "/v", "InstallLocation"],
        { encoding: "utf8", windowsHide: true, timeout: 5000 });
    } catch (e) { continue; }
    if (!out || out.status !== 0 || !out.stdout) continue;
    const m = /InstallLocation\s+REG_SZ\s+(.+)/i.exec(out.stdout);
    if (!m) continue;
    try {
      if (path.resolve(m[1].trim()) === path.resolve(root)) return true;
    } catch (e) { /* an unparseable path is not this one */ }
  }
  return false;
}

/* Staging outcomes that mean this server could not run the updater at all,
   as opposed to the updater running and reporting something about the
   release. Only these are HTTP failures — see the route below. */
const STAGE_INFRA_ERRORS = new Set(["updater-missing", "could-not-run", "no-answer"]);

/* One staging run at a time, for the whole process. Two concurrent runs would
   both rm -rf and rebuild the same .update/staged tree, and the loser could
   delete files the winner had already verified — so a second caller joins the
   run in flight instead of starting another. */
let updateStaging = null;

/* Download-and-verify the newest release into .update/, by spawning the
   updater that already knows how (update.mjs). Nothing here installs
   anything: staging only writes under .update/, and the swap happens at the
   next launch, in start.mjs, when no browser has the app open. That split is
   what keeps this route safe to expose at all — see update.mjs's header.
   The command line is this process's own node binary and a fixed path inside
   this installation; no part of the request reaches it. */
function stageUpdate(root) {
  if (updateStaging) return updateStaging;
  const script = path.join(root, "update.mjs");
  if (!fs.existsSync(script)) return Promise.resolve({ error: "updater-missing" });

  updateStaging = new Promise((resolve) => {
    const child = child_process.spawn(process.execPath, [script, "stage", "--json"], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (chunk) => { if (out.length < 64000) out += chunk; });
    child.stderr.on("data", (chunk) => { if (errOut.length < 8000) errOut += chunk; });
    /* A release zip over a slow link is legitimately slow; a hung one still
       has to end. Ten minutes, then the child is killed and the caller is
       told, rather than the request hanging until the browser gives up. */
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 600000);
    const finish = (value) => { clearTimeout(timer); resolve(value); };
    child.on("error", (err) => finish({ error: "could-not-run", detail: String(err && err.message) }));
    child.on("exit", () => {
      /* --json prints exactly one JSON line, but stdout is still a pipe that
         anything the child's runtime writes (a Node deprecation warning) can
         land in. Take the last line that parses, not the first or the whole. */
      let parsed = null;
      for (const line of out.split(/\r?\n/).reverse()) {
        if (!line.trim()) continue;
        try { parsed = JSON.parse(line); break; } catch (e) { /* not the answer line */ }
      }
      if (!parsed) return finish({ error: "no-answer", detail: (errOut || out).trim().slice(0, 500) });
      finish(parsed);
    });
  }).finally(() => { updateStaging = null; });

  return updateStaging;
}

function handleLauncher(req, res, parts) {
  if (!launcherAllowed(req)) return sendJson(res, 404, { error: "not-found" });

  const root = path.resolve(STATIC_DIR);
  const script = path.join(root, "installer", "install.ps1");

  if (parts[2] === "info" && req.method === "GET") {
    return sendJson(res, 200, {
      root,
      installed: installedHere(root),
      arch: process.arch,
      platform: process.platform,
      canRegister: process.platform === "win32" && fs.existsSync(script)
    });
  }

  if (parts[2] === "register" && req.method === "POST") {
    if (process.platform !== "win32") {
      return sendJson(res, 501, { error: "not-supported" });
    }
    if (!fs.existsSync(script)) return sendJson(res, 500, { error: "installer-missing" });
    return new Promise((resolve) => {
      /* An argument array, never a shell, and every argument is a constant
         or a path this process computed for itself. */
      const child = child_process.spawn("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
        "-InPlace", "-Dir", root
      ], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const take = (chunk) => { if (output.length < 8000) output += chunk; };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => child.kill(), 120000);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(sendJson(res, 500, { error: "could-not-run", detail: String(err && err.message) }));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(sendJson(res, 200, { ok: true, root, output: output.trim() }));
        else resolve(sendJson(res, 500, { error: "install-failed", code, output: output.trim() }));
      });
    });
  }

  /* "Download the update now", the button in the app's update bar. It answers
     with what update.mjs decided: staged (restart to finish), already up to
     date, or an error the page can show verbatim — notably "local-edits",
     which means staging stopped rather than overwrite a file the user
     changed by hand. */
  if (parts[2] === "update" && parts[3] === "stage" && req.method === "POST") {
    return stageUpdate(root).then((result) => {
      if (!result) return sendJson(res, 500, { error: "no-answer" });
      /* "The updater could not be run" is a server fault and answers 5xx.
         "The updater ran and said no" — it is already up to date, or it
         refused to overwrite files the user edited — is a successful request
         with an answer in it, and answers 200: the page needs to read
         `error` to say WHICH, and an HTTP error status reduces all of them
         to a status code on the way through launcherFetch. */
      if (STAGE_INFRA_ERRORS.has(result.error)) {
        return sendJson(res, result.error === "updater-missing" ? 501 : 500, result);
      }
      return sendJson(res, 200, result);
    });
  }

  return sendJson(res, 404, { error: "not-found" });
}

/* ---------- API ---------- */

async function handleApi(req, res, url) {
  const who = identityOf(req);
  const parts = url.pathname.split("/").filter(Boolean); /* ["api", "docs", id?] */

  /* Open, always: this is how a client finds out a server is here at all,
     and (with authRequired) whether it needs to ask for a PIN before it can
     do anything else. It says nothing a caller could not learn by looking at
     the page it was served. */
  if (parts[1] === "health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      mode: "server",
      readOnly: READ_ONLY,
      authRequired: !!JOIN_PIN,
      version: VERSION
    });
  }

  /* Open, because it is the door: post the PIN, get the token every other
     route wants. Rate-limited per address so the six digits cannot simply be
     enumerated. */
  if (parts[1] === "join" && req.method === "POST") {
    if (!JOIN_PIN) return sendJson(res, 200, { token: SESSION_TOKEN, open: true });
    const ip = clientIp(req);
    if (recentFailures(ip).length >= PIN_MAX_FAILURES) {
      return sendJson(res, 429, { error: "too-many-attempts" });
    }
    const body = await readBody(req);
    if (!sameSecret(body && body.pin, JOIN_PIN)) {
      noteFailure(ip);
      return sendJson(res, 401, { error: "bad-pin" });
    }
    pinFailures.delete(ip);
    return sendJson(res, 200, { token: SESSION_TOKEN });
  }

  /* The launcher's own routes carry their own key and their own refusals
     (loopback only, launch token only), so they are settled before the PIN
     gate rather than behind it — a PIN is about sharing documents with
     people, and none of this is reachable by anyone but the launcher that
     started this process. See invariant #28. */
  if (parts[1] === "launcher") return handleLauncher(req, res, parts);

  /* The gate. Everything below needs the token once a PIN is set — including
     /api/me, which is a name and an email address.

     JSON, deliberately: the client treats a non-JSON answer as a lapsed
     Cloudflare Access session and reloads the page to sign in again, which
     would be exactly the wrong move here. */
  if (JOIN_PIN && !hasSessionToken(req)) {
    return sendJson(res, 401, { error: "pin-required" });
  }

  if (parts[1] === "me" && req.method === "GET") {
    return sendJson(res, 200, who);
  }

  if (parts[1] !== "docs") return sendJson(res, 404, { error: "not-found" });

  const id = parts[2];

  /* list */
  if (!id && req.method === "GET") {
    let names;
    try {
      names = await fsp.readdir(DATA_DIR);
    } catch (err) {
      if (err && err.code === "ENOENT") names = [];
      else throw err;
    }
    const docs = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const docId = name.slice(0, -5);
      if (!isValidId(docId)) continue; /* ignore anything we did not write */
      const doc = await readDoc(docId).catch(() => null);
      if (doc) docs.push(summarise(doc));
    }
    docs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return sendJson(res, 200, { docs });
  }

  /* create */
  if (!id && req.method === "POST") {
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    const body = await readBody(req);
    if (!body || typeof body.state !== "object" || body.state === null) {
      return sendJson(res, 400, { error: "bad-state" });
    }
    /* slugify()'s uniqueness rests on 24 bits of random suffix — unlikely
       per call, but not impossible over a long-running/shared library's
       lifetime (birthday-bound collision). Unlike PUT's careful rev-based
       compare-and-set, a straight write here with no existence check
       would silently destroy whatever unrelated document already used
       that id. Retry with a fresh id (still inside the per-id lock, so
       two concurrent creates can't race each other onto the same check)
       rather than ever overwriting. */
    let newId, doc;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = slugify(body.state.title || body.title);
      const wrote = await withDocLock(candidate, async () => {
        if (await readDoc(candidate)) return null; /* taken — try another id */
        const d = {
          id: candidate,
          rev: 1,
          state: body.state,
          updatedAt: new Date().toISOString(),
          updatedBy: who.name || body.by || null
        };
        await writeDoc(d);
        return d;
      });
      if (wrote) { newId = candidate; doc = wrote; break; }
    }
    if (!doc) return sendJson(res, 500, { error: "id-collision" });
    return sendJson(res, 201, { id: newId, rev: doc.rev, updatedAt: doc.updatedAt });
  }

  if (!isValidId(id)) return sendJson(res, 400, { error: "bad-id" });

  /* read */
  if (req.method === "GET") {
    const doc = await readDoc(id);
    if (!doc) return sendJson(res, 404, { error: "not-found" });
    return sendJson(res, 200, {
      id: doc.id, rev: doc.rev || 0, state: doc.state,
      updatedAt: doc.updatedAt || null, updatedBy: doc.updatedBy || null
    });
  }

  /* compare-and-set save */
  if (req.method === "PUT") {
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    const body = await readBody(req);
    if (!body || typeof body.state !== "object" || body.state === null) {
      return sendJson(res, 400, { error: "bad-state" });
    }
    const baseRev = Number(body.baseRev);
    if (!isFinite(baseRev) || baseRev < 0) return sendJson(res, 400, { error: "bad-base-rev" });

    return withDocLock(id, async () => {
      const current = await readDoc(id);
      if (!current) return sendJson(res, 404, { error: "not-found" });

      /* Somebody else saved since this client loaded. Hand back their whole
         version so the client can three-way merge it against the base it
         still holds, rather than either side losing work. */
      if ((current.rev || 0) !== baseRev) {
        return sendJson(res, 409, {
          error: "conflict",
          rev: current.rev || 0,
          state: current.state,
          updatedAt: current.updatedAt || null,
          updatedBy: current.updatedBy || null
        });
      }

      const doc = {
        id,
        rev: (current.rev || 0) + 1,
        state: body.state,
        updatedAt: new Date().toISOString(),
        updatedBy: who.name || body.by || current.updatedBy || null
      };
      await writeDoc(doc);
      return sendJson(res, 200, { id, rev: doc.rev, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy });
    });
  }

  if (req.method === "DELETE") {
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    return withDocLock(id, async () => {
      try {
        await fsp.unlink(docPath(id));
      } catch (err) {
        if (err && err.code === "ENOENT") return sendJson(res, 404, { error: "not-found" });
        throw err;
      }
      return sendJson(res, 200, { ok: true });
    });
  }

  return sendJson(res, 405, { error: "method-not-allowed" });
}

/* ---------- static files ---------- */

async function handleStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    /* malformed percent-encoding (e.g. a truncated "%zz" or a cut-off
       multi-byte escape) throws a URIError here — that's an ordinary bad
       request, not a server fault, and left unguarded it was only caught
       by the generic top-level handler, which logs it and answers 500. */
    res.writeHead(400).end();
    return;
  }
  if (rel === "/") rel = "/index.html";

  /* resolve, then confirm the result is still inside STATIC_DIR — the check
     is on the resolved path, because that is what the filesystem will use */
  const full = path.resolve(path.join(STATIC_DIR, rel));
  const root = path.resolve(STATIC_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  const ext = path.extname(full).toLowerCase();
  /* index.html carries the app AND, in the local build, the document — never
     let a proxy or browser hold a stale copy of it */
  const cache = (ext === ".html" || rel === "/sw.js")
    ? "no-cache"
    : "public, max-age=3600";
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": cache
  });
  if (req.method === "HEAD") { res.end(); return; }
  /* Headers are already written above, so an error here can't be turned into
     a clean 4xx/5xx — the best this can do is stop that one response instead
     of taking the whole process down. With no listener, Node's default
     behavior for an unhandled stream "error" is to throw, which crashes
     every other request and every document being edited, not just this one. */
  const stream = fs.createReadStream(full);
  stream.on("error", (err) => {
    console.error("[splitpage] static read error for " + full + ": " + (err && err.message));
    res.destroy();
  });
  stream.pipe(res);
}

/* ---------- server ---------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  /* The launcher route is the one piece of API a static-only (NO_API) copy
     still answers: it is what lets the app the launcher just opened offer to
     add itself to the Start Menu. It is gated by the per-launch token and the
     loopback bind, never by NO_API - see launcherAllowed(). */
  const isLauncher = url.pathname.startsWith("/api/launcher/");
  const isApi = (!NO_API || isLauncher) && url.pathname.startsWith("/api/");

  /* CORS belongs to the API and only to the API. Static files stay
     same-origin whatever ALLOW_ORIGINS says: a page on another origin has no
     business reading this app's HTML through fetch(), and it can always just
     link to it. */
  if (isApi) {
    const cors = corsHeaders(req);
    if (cors) res.corsHeaders = cors;
    if (req.method === "OPTIONS") {
      /* The preflight. Answered before any route runs — a browser sends it
         without the token header, so making it pass the gate would fail
         every cross-origin request before it was even made. */
      res.writeHead(204, Object.assign({ "Content-Length": 0 }, cors || {}));
      res.end();
      return;
    }
  }

  const done = isApi
    ? handleApi(req, res, url)
    : handleStatic(req, res, url);

  Promise.resolve(done).catch((err) => {
    if (res.headersSent) { res.destroy(); return; }
    if (err && err.code === "TOO_LARGE") return sendJson(res, 413, { error: "too-large" }, { close: true });
    if (err && err.code === "BAD_JSON") return sendJson(res, 400, { error: "bad-json" });
    console.error("[splitpage]", req.method, url.pathname, err && err.stack ? err.stack : err);
    sendJson(res, 500, { error: "server-error" });
  });
});

/* start.mjs's pre-flight port check has an inherent TOCTOU gap (probes,
   closes, then spawns this process, which binds later) — a losing race
   (two launches at once, or a listener already on the target address)
   means listen() below fails. With no 'error' listener registered, that
   failure is an unhandled 'error' event: Node throws it as an uncaught
   exception, crashing with a raw stack trace instead of a clean message. */
server.on("error", (err) => {
  console.error("[splitpage] could not start on " + HOST + ":" + PORT + " — " +
    (err && err.message ? err.message : err));
  process.exit(1);
});

async function start() {
  /* Only when there is an API to store anything. In NO_API mode (the local
     launcher's default) this process is a static file server and has no
     business creating a data directory next to someone's app. */
  if (!NO_API) await fsp.mkdir(DATA_DIR, { recursive: true });
  server.listen(PORT, HOST, () => {
    console.log("[splitpage] listening on " + HOST + ":" + PORT);
    console.log("[splitpage] documents in " + DATA_DIR);
    console.log("[splitpage] static files from " + STATIC_DIR);
    if (READ_ONLY) console.log("[splitpage] READ-ONLY mode");
    if (NO_API) console.log("[splitpage] static only — no document API");
    if (ALLOW_ORIGINS.length) console.log("[splitpage] cross-origin calls allowed from: " + ALLOW_ORIGINS.join(", "));
    if (JOIN_PIN) {
      /* Never the PIN itself: this stream is inherited by the launcher and
         may end up in a log file. That it is set is all anyone needs here. */
      console.log("[splitpage] a join PIN is required — it travels in the clear, so keep this to your own network");
    } else {
      console.log("[splitpage] no authentication in this process — put it behind Cloudflare Access or a VPN");
    }
  });
}

/* let the container stop promptly instead of waiting out Docker's 10s kill */
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((err) => {
  console.error("[splitpage] failed to start:", err);
  process.exit(1);
});
