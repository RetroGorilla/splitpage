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
 *   GET /prompter-voice/<t>   Follow My Voice relayed from the desktop app
 *                             (issue #122): a text/event-stream, for a second
 *                             256-bit token of its own — see VOICE RELAY
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
 * VOICE RELAY (issue #122). Firefox has no Web Speech recogniser, and the
 * desktop app already runs Windows' own (desktop/voice-helper.js, #8). So
 * when main has a listener it gives the share a voice token too
 * (#…&voice=<port>-<token>), and the page opens an EventSource on
 * /prompter-voice/<token> when Follow My Voice is pressed. The stream
 * opening is what starts the listener (opts.voice.start, for the share's
 * owner) and the stream closing — Stop Following, the browser tab closing,
 * the share going — is what stops it, so a listener never outlives the page
 * that asked for it. Every event the helper sends for that session goes
 * down the stream as one `data:` line of JSON, exactly as voice-helper.js's
 * own parser rebuilt it: whatever types that lets through pass through here
 * unchanged. The page is served either by this listener or by the desktop's
 * document server (a server tab), so the one other origin allowed to read a
 * stream is whatever opts.corsOrigins() names.
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
const VOICE_PATH_RE = /^\/prompter-voice\/([0-9a-f]{64})$/;

/* A comment line down an idle voice stream this often, so a browser tab that
   vanished without closing its socket is noticed and its listener stopped. */
const VOICE_HEARTBEAT_MS = 15000;

/* What main's voice-start refusals mean to the page (the same words the
   desktop tab's own recogniser uses, 20f-desktop.js). */
const VOICE_START_ERRORS = { UNAVAILABLE: "unavailable", SPAWN_FAILED: "helper-failed" };

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
 *   voice             {start(ownerId) -> {ok, session} | {ok:false, code},
 *                      stop(ownerId, session)} — the relay's listener;
 *                     without it no share is given a voice token
 *   corsOrigins()     -> string[]  the other origins allowed to read a
 *                     voice stream (the desktop's document server)
 */
function createPrompterShare(options) {
  const opts = options || {};
  const host = "127.0.0.1";
  const readStatic = opts.readStatic;
  const cspHeader = typeof opts.cspHeader === "function" ? opts.cspHeader : async () => "";
  const preferredPort = opts.preferredPort === undefined ? PREFERRED_PORT : opts.preferredPort;
  const ttlMs = opts.ttlMs || SHARE_TTL_MS;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const voice = opts.voice && typeof opts.voice.start === "function" ? opts.voice : null;
  const corsOrigins = typeof opts.corsOrigins === "function" ? opts.corsOrigins : () => [];

  const staticTable = {};
  for (const [route, entry] of Object.entries(opts.staticAllowlist || {})) {
    if (route === "/sw.js") continue;
    staticTable[route] = entry;
  }

  /* ownerId -> {token, voiceToken, name, text, expiresAt, timer, streams}.
     A relay-only share (publishVoice) has no token and no text. */
  const shares = new Map();
  let server = null;
  let port = null;
  let starting = null;

  function dropShare(ownerId) {
    const share = shares.get(ownerId);
    if (!share) return false;
    clearTimeout(share.timer);
    shares.delete(ownerId);
    endStreams(share, "revoked");
    if (!shares.size) stopServer();
    return true;
  }

  /* The TTL is for reloading the page; a relay still in use keeps its share
     alive for as long as it is. */
  function armExpiry(ownerId, share) {
    clearTimeout(share.timer);
    share.timer = setTimeout(() => {
      if (shares.get(ownerId) !== share) return;
      if (share.streams.size) { share.expiresAt = now() + ttlMs; armExpiry(ownerId, share); return; }
      dropShare(ownerId);
    }, Math.max(0, share.expiresAt - now()));
    if (typeof share.timer.unref === "function") share.timer.unref();
  }

  function writeVoice(stream, event) {
    try { stream.res.write("data: " + JSON.stringify(event) + "\n\n"); } catch { /* socket gone */ }
  }

  function endStreams(share, reason) {
    for (const stream of [...share.streams]) {
      writeVoice(stream, { type: "end", session: stream.session, reason });
      stream.close();
    }
  }

  /* {ownerId, share, expired} for the share this token names, or null. An
     expired one is reported rather than dropped here: dropping the last
     share closes the listener, and that must wait until the answer saying
     "expired" has actually been sent on it. */
  function shareForToken(token, field) {
    const key = field || "token";
    for (const [ownerId, share] of shares) {
      if (tokensEqual(share[key], token)) return { ownerId, share, expired: share.expiresAt <= now() };
    }
    return null;
  }

  /* The page's EventSource. Opening it starts the listener for the share's
     owner; closing it, from either end, stops that session and no other. */
  function openVoiceStream(req, res, found) {
    const headers = {
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store"
    };
    const origin = req.headers.origin;
    if (typeof origin === "string" && corsOrigins().includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    const { ownerId, share } = found;
    const stream = {
      res,
      session: null,
      closed: false,
      heartbeat: null,
      close() {
        if (stream.closed) return;
        stream.closed = true;
        clearInterval(stream.heartbeat);
        share.streams.delete(stream);
        try { res.end(); } catch { /* socket gone */ }
        const session = stream.session;
        stream.session = null;
        if (session != null) {
          try { voice.stop(ownerId, session); } catch { /* main is going */ }
        }
      }
    };
    share.streams.add(stream);
    res.on("close", () => stream.close());
    /* Headers out now: an EventSource reports "open" only once it has them. */
    res.write(": relay\n\n");
    stream.heartbeat = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { stream.close(); }
    }, VOICE_HEARTBEAT_MS);
    if (typeof stream.heartbeat.unref === "function") stream.heartbeat.unref();
    share.expiresAt = now() + ttlMs;
    let answer;
    try { answer = voice.start(ownerId); } catch { answer = { ok: false, code: "SPAWN_FAILED" }; }
    if (stream.closed) return;
    if (!answer || !answer.ok || typeof answer.session !== "number") {
      writeVoice(stream, { type: "error", code: VOICE_START_ERRORS[answer && answer.code] || "helper-failed" });
      writeVoice(stream, { type: "end", reason: "exited" });
      stream.close();
      return;
    }
    stream.session = answer.session;
  }

  /* One event of one listening session, from main's voice helper, down the
     stream that session belongs to. An "end" closes the stream after it. */
  function pushVoice(ownerId, event) {
    const share = shares.get(ownerId);
    if (!share || !event || typeof event !== "object") return;
    for (const stream of [...share.streams]) {
      if (stream.session == null || stream.session !== event.session) continue;
      writeVoice(stream, event);
      if (event.type === "end") { stream.session = null; stream.close(); }
    }
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

    const voiceMatch = VOICE_PATH_RE.exec(pathname);
    if (voiceMatch) {
      const found = voice ? shareForToken(voiceMatch[1], "voiceToken") : null;
      if (!found || found.expired) {
        send(res, 404, { "content-type": "application/json" }, JSON.stringify({ error: "expired" }));
        return;
      }
      openVoiceStream(req, res, found);
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
  function replaceShare(ownerId, share) {
    const previous = shares.get(ownerId);
    if (previous) {
      clearTimeout(previous.timer);
      /* The browser tab the last link opened reads an older copy now; its
         relay goes rather than listening on for a page nobody watches. */
      endStreams(previous, "revoked");
    }
    shares.set(ownerId, share);
    armExpiry(ownerId, share);
  }

  function voiceParam(listening, share) {
    return share.voiceToken ? `voice=${listening}-${share.voiceToken}` : "";
  }

  /* publishOpts.voice: give the share a relay too (ignored without
     opts.voice). */
  async function publish(ownerId, name, text, publishOpts) {
    if (typeof ownerId !== "string" || !ownerId) throw new Error("prompter-share: no owner");
    if (!isShareableName(name)) throw new Error("prompter-share: not a project file");
    if (typeof text !== "string") throw new Error("prompter-share: no text");
    if (Buffer.byteLength(text, "utf8") > MAX_SCRIPT_BYTES) throw new Error("prompter-share: too large");
    const listening = await ensureServer();
    const withVoice = !!(voice && publishOpts && publishOpts.voice);
    const token = crypto.randomBytes(32).toString("hex");
    const share = {
      token,
      voiceToken: withVoice ? crypto.randomBytes(32).toString("hex") : null,
      name: path.basename(name), text, expiresAt: now() + ttlMs, timer: null, streams: new Set()
    };
    replaceShare(ownerId, share);
    const relay = voiceParam(listening, share);
    return `http://${host}:${listening}/?teleprompter=1#script=${token}` + (relay ? "&" + relay : "");
  }

  /* A relay with no script, for a page something else serves (a server
     tab's document, on the desktop's own document server). Answers the
     fragment parameter to hand that page: `voice=<port>-<token>`. */
  async function publishVoice(ownerId) {
    if (typeof ownerId !== "string" || !ownerId) throw new Error("prompter-share: no owner");
    if (!voice) throw new Error("prompter-share: no voice relay");
    const listening = await ensureServer();
    const share = {
      token: null, voiceToken: crypto.randomBytes(32).toString("hex"),
      name: "", text: null, expiresAt: now() + ttlMs, timer: null, streams: new Set()
    };
    replaceShare(ownerId, share);
    return voiceParam(listening, share);
  }

  function closeAll() {
    for (const ownerId of [...shares.keys()]) {
      const share = shares.get(ownerId);
      clearTimeout(share.timer);
      shares.delete(ownerId);
      endStreams(share, "quit");
    }
    stopServer();
  }

  return {
    publish,
    publishVoice,
    pushVoice,
    revoke: dropShare,
    closeAll,
    /* For tests and nothing else: what is live, without the text or tokens. */
    status() {
      let voiceStreams = 0;
      for (const share of shares.values()) voiceStreams += share.streams.size;
      return { listening: server != null, port, shares: [...shares.keys()], voiceStreams };
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
