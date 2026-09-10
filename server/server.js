/* Splitpage document server.
 *
 * Serves the app's static files and a small document API from one origin, so
 * a Cloudflare Access cookie covers both and the service worker stays in
 * scope. No dependencies — plain Node (18+), so the image is just `node:alpine`
 * plus this file and there is nothing to audit but what you can read here.
 *
 * There is deliberately NO authentication in this process. It is designed to
 * sit behind Cloudflare Access (or a VPN), which rejects unauthenticated
 * requests before they arrive. If you expose this port directly to the
 * internet, anyone who finds it can read and rewrite every document. See
 * DEPLOY.md.
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

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "..", "public");
/* A script with a few embedded images gets large. 25 MB is roomy for that and
   still small enough that a runaway client can't fill the array. */
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
/* Set READ_ONLY=1 to publish a library nobody can write to. */
const READ_ONLY = process.env.READ_ONLY === "1";
/* Set NO_API=1 to serve the app and nothing else: with no /api to find, the
   client's health probe fails and it stays in local mode, where a document is
   a file you save to disk. The launcher sets this when the user has asked for
   that with `start --no-library`; otherwise first-run setup turns the library
   on and documents live in the data folder. */
const NO_API = process.env.NO_API === "1";

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

/* ---------- API ---------- */

async function handleApi(req, res, url) {
  const who = identityOf(req);
  const parts = url.pathname.split("/").filter(Boolean); /* ["api", "docs", id?] */

  if (parts[1] === "health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, mode: "server", readOnly: READ_ONLY });
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

/* Stamped on every response so a second launcher can tell "the port is taken"
   from "Splitpage is already running here" — the difference between starting
   beside it on the next port and simply opening a browser at it. Read once,
   at startup: it can only change when this process is replaced. */
const IDENTITY = (() => {
  try { return fs.readFileSync(path.join(STATIC_DIR, "VERSION"), "utf8").trim() || "1"; }
  catch { return "1"; }
})();

const server = http.createServer((req, res) => {
  res.setHeader("X-Splitpage", IDENTITY);
  /* Loopback or the whole network — the one thing a launcher cannot work out
     for itself by connecting over loopback, and the difference between "this
     is already shared" and "this is mine alone". */
  res.setHeader("X-Splitpage-Bind", HOST);
  const url = new URL(req.url, "http://localhost");
  const done = (!NO_API && url.pathname.startsWith("/api/"))
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
    console.log("[splitpage] no authentication in this process — put it behind Cloudflare Access or a VPN");
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
