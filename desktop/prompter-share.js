/* Splitpage desktop — "Open in browser" for the teleprompter (issue #86).
 *
 * WHY THIS EXISTS. Follow My Voice runs on the Web Speech API, and inside
 * Electron that API's constructor exists but recognition fails at once with
 * a 'network' error: Google's speech backend is reachable from a real Chrome
 * or Edge install and not from here. On Windows the desktop app now has a
 * recogniser of its own (#8, desktop/voice-helper.js); reading the script in
 * the person's own browser is still offered everywhere, and is the only way
 * elsewhere. This file is what puts the script there.
 *
 * WHY A LOOPBACK SERVER AND NOT A FILE. A browser cannot be handed a local
 * file path to read, and a page opened from file:// is not a secure context,
 * so the browser would refuse it the microphone anyway (the "needs the app
 * served over http://" line in 20-teleprompter.js). http://127.0.0.1 IS a
 * secure context. So main serves the app page and the one script it was
 * asked to share, on loopback, and opens a URL to that.
 *
 * WHY NO TEMP FILE. The issue sketched "write the document to a temp
 * .splitpage". Nothing here writes one: the script is read from the file the
 * tab already saved to (main's own TabRecord says which, invariant #34) and
 * held in THIS PROCESS'S MEMORY, served from there. A temp file holding an
 * unreleased script would need cleaning up on every exit path, and the one
 * path nothing can clean up after is a crash — a copy on disk would outlive
 * it. Memory does not: if main dies, the copy dies with it and the port
 * closes. There is nothing to sweep at the next launch because nothing was
 * ever written.
 *
 * WHAT IS SERVED, AND TO WHOM.
 *   GET /                     the app page (index.html), so the browser runs
 *   GET /index.html           the SAME build the desktop app runs
 *   GET <static allowlist>    icon, manifest, help, VERSION — never sw.js:
 *                             no service worker is ever installed on this
 *                             origin, so no Cache Storage entry outlives it
 *   GET /api/*                404 JSON, the same "no server" answer the
 *                             desktop protocol handler gives, so the page
 *                             stays in local mode instead of probing
 *   GET /prompter-script/<t>  the shared script as JSON {name, text}, only
 *                             for the exact 256-bit token main put in the URL
 *   anything else             404
 *
 * Bound to 127.0.0.1 only. The Host header must name this listener
 * (127.0.0.1 or localhost, on this port) or the request is refused — that is
 * what stops a DNS-rebinding page in the same browser from reading it by a
 * name of its own. No CORS headers are ever sent, so another origin's script
 * can make the request but never read the answer. The token travels in the
 * URL's FRAGMENT (#script=…), which a browser never sends to any server, and
 * the page takes it out of the address bar once read.
 *
 * LIFETIME. One share per desktop tab: sharing again from the same tab
 * replaces that tab's previous one. A share is dropped when its tab closes,
 * after SHARE_TTL_MS, or when the app quits; the listener closes itself when
 * no share is left. A crash takes all of it down with the process.
 *
 * Plain CommonJS, Node built-ins only, no Electron: main.js requires it, and
 * desktop/test/prompter-share.test.mjs drives it under plain node. Listed in
 * electron-builder.yml's `files` for the same reason drafts.js is.
 */

"use strict";

const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const path = require("node:path");

/* The browser tab only needs the script once, at load; this is how long a
   RELOAD of that tab keeps working. After it the page says the link has
   expired and to open it again from the desktop app. */
const SHARE_TTL_MS = 60 * 60 * 1000;

/* A stable origin, not a fresh ephemeral port per launch: the browser keys
   localStorage by origin, and the teleprompter keeps its rig settings there
   (Mirror, Flip, Scene mode). Same port, same settings, every time. Moves up
   from here if something else already has it. Chosen clear of the document
   server's 8791+20 and of the ports the test drivers default to. */
const PREFERRED_PORT = 8771;
const PORT_SPAN = 20;

/* A script is text. Anything bigger than this is not one — the draft store's
   own ceiling for a document body is the same order of size. */
const MAX_SCRIPT_BYTES = 64 * 1024 * 1024;

/* The formats the browser build opens as a project (fileKindFromName in
   18-local-files.js). A .docx or .csv is an IMPORT, not a project, and never
   reaches here: main only knows a tab's path when it is a project file. */
const SHAREABLE_EXTENSIONS = [".splitpage", ".md", ".html", ".htm"];

const TOKEN_RE = /^[0-9a-f]{64}$/;
const SCRIPT_PATH_RE = /^\/prompter-script\/([0-9a-f]{64})$/;

function isShareableName(name) {
  return SHAREABLE_EXTENSIONS.includes(path.extname(String(name || "")).toLowerCase());
}

function tokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function portIsFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/* createPrompterShare(options)
 *   readStatic(entry) -> Promise<Buffer>   reads one allowlisted file
 *   staticAllowlist   {"/path": {file, type}} — the desktop protocol
 *                     handler's own table; sw.js is dropped from it here
 *   cspHeader()       -> Promise<string>   the app's policy, or "" for none
 *   preferredPort     default PREFERRED_PORT (tests pass 0 for "any")
 *   ttlMs             default SHARE_TTL_MS
 *   now()             clock, for tests
 */
function createPrompterShare(options) {
  const opts = options || {};
  const host = "127.0.0.1";
  const readStatic = opts.readStatic;
  const cspHeader = typeof opts.cspHeader === "function" ? opts.cspHeader : async () => "";
  const preferredPort = opts.preferredPort === undefined ? PREFERRED_PORT : opts.preferredPort;
  const ttlMs = opts.ttlMs || SHARE_TTL_MS;
  const now = typeof opts.now === "function" ? opts.now : Date.now;

  const staticTable = {};
  for (const [route, entry] of Object.entries(opts.staticAllowlist || {})) {
    if (route === "/sw.js") continue;
    staticTable[route] = entry;
  }

  /* ownerId -> {token, name, text, expiresAt, timer} */
  const shares = new Map();
  let server = null;
  let port = null;
  let starting = null;

  function dropShare(ownerId) {
    const share = shares.get(ownerId);
    if (!share) return false;
    clearTimeout(share.timer);
    shares.delete(ownerId);
    if (!shares.size) stopServer();
    return true;
  }

  /* {ownerId, share, expired} for the share this token names, or null. An
     expired one is reported rather than dropped here: dropping the last
     share closes the listener, and that must wait until the answer saying
     "expired" has actually been sent on it. */
  function shareForToken(token) {
    for (const [ownerId, share] of shares) {
      if (tokensEqual(share.token, token)) return { ownerId, share, expired: share.expiresAt <= now() };
    }
    return null;
  }

  function hostAllowed(hostHeader) {
    if (typeof hostHeader !== "string" || port == null) return false;
    const h = hostHeader.toLowerCase();
    return h === `${host}:${port}` || h === `localhost:${port}`;
  }

  function send(res, status, headers, body) {
    res.writeHead(status, Object.assign({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store"
    }, headers));
    res.end(body);
  }

  function notFound(res, json) {
    if (json) send(res, 404, { "content-type": "application/json" }, JSON.stringify({ error: "no server" }));
    else send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
  }

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host)) {
      send(res, 403, { "content-type": "text/plain; charset=utf-8" }, "forbidden");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }, "method not allowed");
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://" + host).pathname); }
    catch { notFound(res, false); return; }

    if (pathname.startsWith("/api/")) { notFound(res, true); return; }

    const scriptMatch = SCRIPT_PATH_RE.exec(pathname);
    if (scriptMatch) {
      const found = shareForToken(scriptMatch[1]);
      if (!found || found.expired) {
        if (found) {
          res.once("finish", () => { if (shares.get(found.ownerId) === found.share) dropShare(found.ownerId); });
        }
        send(res, 404, { "content-type": "application/json" }, JSON.stringify({ error: "expired" }));
        return;
      }
      send(res, 200, { "content-type": "application/json; charset=utf-8" },
        req.method === "HEAD" ? undefined : JSON.stringify({ name: found.share.name, text: found.share.text }));
      return;
    }

    const entry = staticTable[pathname === "/" ? "/index.html" : pathname];
    if (!entry || typeof readStatic !== "function") { notFound(res, false); return; }
    let body;
    try { body = await readStatic(entry); } catch { notFound(res, false); return; }
    const headers = { "content-type": entry.type, "cache-control": "no-cache" };
    if (entry.type.startsWith("text/html")) {
      const csp = await cspHeader().catch(() => "");
      if (csp) headers["content-security-policy"] = csp;
    }
    send(res, 200, headers, req.method === "HEAD" ? undefined : body);
  }

  async function ensureServer() {
    if (server && port != null) return port;
    if (starting) return starting;
    starting = (async () => {
      let chosen = null;
      if (preferredPort === 0) {
        chosen = 0;
      } else {
        for (let p = preferredPort; p < preferredPort + PORT_SPAN; p++) {
          if (await portIsFree(p, host)) { chosen = p; break; }
        }
        /* Every port in the span taken: any free port still works, it just
           costs the stable origin (and with it the remembered rig settings). */
        if (chosen == null) chosen = 0;
      }
      const srv = http.createServer((req, res) => {
        handle(req, res).catch(() => {
          try { if (!res.headersSent) notFound(res, false); else res.end(); } catch { /* socket gone */ }
        });
      });
      await new Promise((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(chosen, host, () => { srv.removeListener("error", reject); resolve(); });
      });
      /* Loopback keep-alive sockets must not hold the process (or a test)
         open once every share is gone. */
      srv.keepAliveTimeout = 2000;
      server = srv;
      port = srv.address().port;
      return port;
    })();
    try { return await starting; }
    finally { starting = null; }
  }

  function stopServer() {
    if (!server) return;
    const srv = server;
    server = null;
    port = null;
    try { srv.close(); } catch { /* already closed */ }
    try { if (typeof srv.closeAllConnections === "function") srv.closeAllConnections(); } catch { /* ditto */ }
  }

  /* Share `text` (a project file's contents, as read off disk by main) for
     `ownerId` (a tab id), replacing whatever that tab shared before. Answers
     the URL main opens: the app page on this listener, told to start in the
     teleprompter, with the token in the fragment. */
  async function publish(ownerId, name, text) {
    if (typeof ownerId !== "string" || !ownerId) throw new Error("prompter-share: no owner");
    if (!isShareableName(name)) throw new Error("prompter-share: not a project file");
    if (typeof text !== "string") throw new Error("prompter-share: no text");
    if (Buffer.byteLength(text, "utf8") > MAX_SCRIPT_BYTES) throw new Error("prompter-share: too large");
    const listening = await ensureServer();
    const previous = shares.get(ownerId);
    if (previous) clearTimeout(previous.timer);
    const token = crypto.randomBytes(32).toString("hex");
    const share = { token, name: path.basename(name), text, expiresAt: now() + ttlMs, timer: null };
    share.timer = setTimeout(() => { if (shares.get(ownerId) === share) dropShare(ownerId); }, ttlMs);
    if (typeof share.timer.unref === "function") share.timer.unref();
    shares.set(ownerId, share);
    return `http://${host}:${listening}/?teleprompter=1#script=${token}`;
  }

  function closeAll() {
    for (const ownerId of [...shares.keys()]) {
      const share = shares.get(ownerId);
      clearTimeout(share.timer);
      shares.delete(ownerId);
    }
    stopServer();
  }

  return {
    publish,
    revoke: dropShare,
    closeAll,
    /* For tests and nothing else: what is live, without the text or tokens. */
    status() {
      return { listening: server != null, port, shares: [...shares.keys()] };
    }
  };
}

module.exports = {
  createPrompterShare,
  isShareableName,
  MAX_SCRIPT_BYTES,
  PREFERRED_PORT,
  SHARE_TTL_MS,
  TOKEN_RE
};
