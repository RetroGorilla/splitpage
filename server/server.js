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

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "..", "public");
/* A script with a few embedded images gets large. 25 MB is roomy for that and
   still small enough that a runaway client can't fill the array. */
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
/* One image, uploaded on its own (#82). Images left the document for
   content-addressed blobs under DATA_DIR/blobs, so a script no longer carries
   its stills inside it; this is the cap on one still. */
const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_BYTES || 8 * 1024 * 1024);
/* How many bytes of images a REVIEW token may store per rolling hour — the
   screenshots a reviewer pastes into comments. An editor has no such cap: an
   editor can already write 25 MB per save. A reviewer otherwise could not
   write to the disk at all, and this keeps "can comment" from becoming "can
   fill the array". The library-wide review credential is one token shared by
   everyone who holds it, so it is one budget shared by all of them. */
const REVIEW_BLOB_BUDGET = Number(process.env.REVIEW_BLOB_BUDGET_BYTES || 20 * 1024 * 1024);
const REVIEW_BLOB_WINDOW_MS = 60 * 60 * 1000;
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

/* ---------- the review credential ----------
 *
 * A second code, and a link carrying a key instead of that code, which open
 * the same documents to be READ and COMMENTED ON and nothing else. Two ways
 * in because they are for two situations: REVIEW_PIN is read out loud like
 * the join PIN, REVIEW_KEY rides in the fragment of a link that can simply be
 * sent (see start.mjs) and is never the code itself, so passing the link on
 * does not pass the code on.
 *
 * Both mint the SAME review token, and the role lives with that token in this
 * process's memory — not in anything the client holds, so there is no local
 * state to flip and a reconnect gets the role back rather than losing it.
 * Restarting invalidates them exactly like the join PIN.
 *
 * A review credential without a join PIN would be a lock on a door standing
 * open (with no JOIN_PIN, /api/join hands an EDITOR token to anyone who
 * asks), and one that equals the join PIN is a typo that would quietly
 * downgrade the host. Both are ignored, loudly, at startup.
 */
const REVIEW_PIN = String(process.env.REVIEW_PIN || "");
const REVIEW_KEY = String(process.env.REVIEW_KEY || "");
const REVIEW_ACTIVE = !!(JOIN_PIN && (REVIEW_PIN || REVIEW_KEY) && REVIEW_PIN !== JOIN_PIN);
const REVIEW_TOKEN = crypto.randomBytes(32).toString("hex");

/* ---------- per-document review links (#63) ----------
 *
 * REVIEW_PIN and REVIEW_KEY above are the operator's own, chosen at launch
 * before any document exists: they are a credential for this LIBRARY, and
 * the launcher prints them saying so.
 *
 * The link the app offers is a different thing. It is asked for from inside
 * an open document and it reads as "share THIS script", so it gets a key of
 * its own, minted per document and remembered here — the token it mints
 * carries the document id with it, and the list, read and save routes hold
 * it to that one document. Before this, every review credential read every
 * document on the server and listed the picker; a link meant for one script
 * was a key to the whole library.
 *
 * In memory, per process, exactly like the session token: restarting the
 * server invalidates every link, which is the same trade the join PIN makes.
 * Minted once per document and reused, so handing the link out twice does
 * not quietly invalidate the copy already sent.
 */
const reviewGrantsByDoc = new Map();   /* docId -> { key, token } */
const reviewGrantsByKey = new Map();   /* key   -> { docId, token } */
const reviewScopeByToken = new Map();  /* token -> docId */
const REVIEW_GRANT_MAX = 500;

function reviewGrantFor(docId) {
  let grant = reviewGrantsByDoc.get(docId);
  if (grant) return grant;
  /* A library nobody prunes would otherwise grow one grant per document
     ever shared, for as long as the process runs. Oldest first: Map keeps
     insertion order, and the oldest link is the one least likely to still
     be in somebody's inbox. */
  if (reviewGrantsByDoc.size >= REVIEW_GRANT_MAX) {
    const oldest = reviewGrantsByDoc.keys().next().value;
    const gone = reviewGrantsByDoc.get(oldest);
    reviewGrantsByDoc.delete(oldest);
    if (gone) { reviewGrantsByKey.delete(gone.key); reviewScopeByToken.delete(gone.token); }
  }
  grant = {
    key: crypto.randomBytes(24).toString("hex"),
    token: crypto.randomBytes(32).toString("hex")
  };
  reviewGrantsByDoc.set(docId, grant);
  reviewGrantsByKey.set(grant.key, { docId, token: grant.token });
  reviewScopeByToken.set(grant.token, docId);
  return grant;
}

/* Which document a review token is confined to, or "" for the launch-wide
   credential, which the operator set deliberately and which is not confined
   to anything. */
function reviewScopeOfToken(token) {
  return reviewScopeByToken.get(String(token || "")) || "";
}

function reviewScopeOf(req) {
  return reviewScopeOfToken(req.headers["x-splitpage-token"] || "");
}

/* Origins allowed to call this API from another page — a comma list, empty
   (the default) meaning same-origin only.

   The literal entry `null` used to be accepted, so that a copy of the app
   opened from disk (which sends `Origin: null`) could talk to a server. It
   is no longer: `null` is not one origin, it is what every sandboxed iframe
   on every site on the internet sends, so allowing it allowed all of them
   (#63). A portable copy served over http:// has a real origin to name here;
   one opened from file:// has to be served instead. */
const ALLOW_ORIGINS = String(process.env.ALLOW_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .filter((o) => {
    if (o !== "null") return true;
    console.warn("[splitpage] ALLOW_ORIGINS=null is ignored — `null` is the origin every " +
                 "sandboxed iframe sends, not one site. Name the origin the copy is served from.");
    return false;
  });

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

/* ---------- who the limiter counts against ----------
 *
 * The socket's own address, unless TRUST_PROXY=1 says something in front of
 * this process is rewriting it. Behind cloudflared, a reverse proxy or plain
 * Docker NAT every request arrives from the same address, so the bucket above
 * is one bucket for everybody: one stranger's ten wrong guesses lock the whole
 * house out for a minute (#74).
 *
 * Off by default, and that default matters. X-Forwarded-For is a request
 * header like any other — anyone talking to this port directly can write
 * whatever they like in it, so honouring it unconditionally would hand every
 * guesser a fresh bucket per guess and turn the limiter off. It is only worth
 * anything when a proxy you control is the ONLY way in, which is the one case
 * the operator is asserting by setting this.
 *
 * The FIRST entry, because a proxy appends: "client, proxy1, proxy2". Anything
 * that is not plausibly an address is ignored rather than used as a key — a
 * header of junk should fall back to the socket, not mint a bucket named after
 * the junk.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

function forwardedIp(req) {
  const header = req.headers["x-forwarded-for"];
  /* Node joins a repeated header into an array; a proxy that sets it twice
     means the same list, so read it as one. */
  const raw = Array.isArray(header) ? header.join(",") : String(header || "");
  const first = raw.split(",")[0].trim().replace(/^\[|\]$/g, "");
  return IP_RE.test(first) ? first : "";
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = forwardedIp(req);
    if (forwarded) return forwarded;
  }
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

function sameToken(given, token) {
  /* length check first: timingSafeEqual throws on a length mismatch, and the
     token's length is not a secret (it is always 64 hex characters) */
  if (given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/* "edit", "review", or null for a caller carrying neither token. The role is
   read from the token on every request, so it cannot be stale and cannot be
   asserted by the client. */
function roleOfToken(given) {
  const token = String(given == null ? "" : given);
  if (sameToken(token, SESSION_TOKEN)) return "edit";
  if (REVIEW_ACTIVE && sameToken(token, REVIEW_TOKEN)) return "review";
  /* A per-document review link's own token (#63). A plain Map lookup rather
     than a timing-safe compare of every grant in turn: the key space is 256
     bits of randomness, and walking the whole map per request would be both
     slower and, with hundreds of grants, no more constant-time than this. */
  if (REVIEW_ACTIVE && reviewScopeByToken.has(token)) return "review";
  return null;
}

function roleOf(req) {
  return roleOfToken(req.headers["x-splitpage-token"] || "");
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
    "Access-Control-Allow-Headers": "content-type, x-splitpage-token, x-splitpage-launch, x-splitpage-client",
    /* PATCH is here for the one comment resolve route (#71). A preflight
       that does not name a method is a preflight that fails, and a route
       added without its method named here works from the app and from
       nowhere else — which is a bug nobody meets until the day somebody
       sets ALLOW_ORIGINS. */
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
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

/* ---------- the head line ----------
 *
 * A document file is written with its own summary on the first line and the
 * state on the second:
 *
 *     {"id":"kitchen-ab12","rev":7,"updatedAt":"…","title":"Kitchen","rows":9,
 *     "state":{ …the whole script… }}
 *
 * It is still one JSON object and still one file — the newline is whitespace
 * JSON ignores, so `cp -r` is still the backup and readDoc() is unchanged.
 * What it buys is that the three things nothing else needs the script for —
 * the rev a PUT compares against, and the title and timestamp the picker
 * lists — can be had by reading the first few hundred bytes instead of
 * parsing 25 MB of state per document (#74). The picker used to parse every
 * script in the library in full to draw a list of their names.
 *
 * Deliberately IN the file rather than in a sidecar beside it: a sidecar is a
 * second write that a crash can land between, and a rev that disagrees with
 * the document it describes is worse than no rev at all. This one arrives
 * with the rename or not at all.
 *
 * Documents written before this existed have no head line. Every reader below
 * falls back to a full parse for those, and the list route quietly rewrites
 * one when it meets it, so a library upgrades itself as it is used.
 */
const DOC_HEAD_MAX = 8192;

/* A title is as long as whoever pasted it made it, and the head line has to
   fit in the one small read below. The copy in the summary is held short;
   the document's own state still carries the title in full, so nothing is
   lost — a picker entry is a line in a list, not a document. */
const HEAD_TITLE_MAX = 512;

/* The summary as it is stored: every top-level field of the document except
   the state, plus the two things the picker wants out of the state. */
function headOf(doc) {
  const head = {};
  for (const key of Object.keys(doc)) {
    if (key !== "state") head[key] = doc[key];
  }
  const state = doc.state || {};
  head.title = String(state.title || "Untitled Script").slice(0, HEAD_TITLE_MAX);
  head.rows = Array.isArray(state.rows) ? state.rows.length : 0;
  return head;
}

function encodeDoc(doc) {
  const head = JSON.stringify(headOf(doc));
  /* "{…}" + "{…}" spliced into one object: drop the head's closing brace and
     continue it with the state on the next line. headOf always returns at
     least title and rows, so there is never a dangling comma here. */
  return head.slice(0, -1) + ",\n\"state\":" + JSON.stringify(doc.state) + "}";
}

/* The head line alone, or null for a document that has none (written before
   this existed, or carrying a title longer than the read below) — in which
   case the caller parses the whole file instead. */
async function readDocHead(id) {
  let handle;
  try {
    handle = await fsp.open(docPath(id), "r");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const buf = Buffer.alloc(DOC_HEAD_MAX);
    const { bytesRead } = await handle.read(buf, 0, DOC_HEAD_MAX, 0);
    const text = buf.toString("utf8", 0, bytesRead);
    const end = text.indexOf("\n");
    if (end === -1) return null;
    /* Everything before the newline, closed off: the trailing comma is the
       one encodeDoc put there to join the head to the state. A title cannot
       smuggle a newline in — JSON.stringify escapes it. */
    const line = text.slice(0, end).replace(/,$/, "") + "}";
    const head = JSON.parse(line);
    if (!head || typeof head !== "object" || typeof head.rev !== "number") return null;
    return head;
  } catch (err) {
    /* An unreadable head is never fatal: it only means this document is read
       the old way. A corrupt file still fails loudly in readDoc(). */
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/* rev, title and timestamps, by whichever route is cheapest for this file. */
async function readDocMeta(id) {
  const head = await readDocHead(id);
  if (head) return head;
  const doc = await readDoc(id);
  return doc ? headOf(doc) : null;
}

/* fsync a directory so a rename in it is on the disk and not only in the
   page cache. Best effort: Windows cannot open a directory for reading at
   all, and some filesystems refuse the sync — neither is a reason to fail a
   save that has otherwise succeeded. */
async function syncDir(dir) {
  let handle;
  try {
    handle = await fsp.open(dir, "r");
    await handle.sync();
  } catch (err) {
    /* nothing to do about it here */
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/* Write to a temp file in the same directory and rename over the target.
   Rename is atomic within a filesystem, so a crash or a full disk leaves the
   previous version intact rather than a half-written one.

   Atomic is not the same as durable. Without the fsync below, the rename can
   reach the disk before the bytes it points at do, and a power cut between
   the two leaves the document there and EMPTY — the one outcome this whole
   dance exists to prevent (#74). So: write, fsync the temp file, rename,
   then fsync the directory that now holds the new name. */
async function writeFileDurable(target, data) {
  const tmp = target + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    let handle;
    try {
      handle = await fsp.open(tmp, "w");
      await handle.writeFile(data, typeof data === "string" ? "utf8" : undefined);
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDir(path.dirname(target));
}

async function writeDoc(doc, refs) {
  await writeFileDurable(docPath(doc.id), encodeDoc(doc));
  /* The refs of the state that just went to disk, filed under the rev it
     went there as, so a review link asking for an image (and an old client's
     PUT asking whether it may) does not have to parse the script back in to
     find out (#82). Whoever wrote it had the state in hand anyway. */
  noteRefs(doc.id, doc.rev || 0, refs || refsIn(doc.state));
}

/* ---------- http helpers ---------- */

/* Is this request still sending a body nobody has read? A message the parser
   has finished is not, and neither is a GET, which announces no body to
   leave behind — so the common answer here is "no" and the connection is
   kept alive as it always was. */
function stillUploading(req) {
  if (!req || req.complete) return false;
  if (req.headers["transfer-encoding"]) return true;
  return Number(req.headers["content-length"] || 0) > 0;
}

function sendJson(res, status, body, opts) {
  const payload = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    /* documents must never be cached by the browser or by Cloudflare — a
       stale rev would make the client think it is up to date and clobber */
    "Cache-Control": "no-store"
  };
  /* Answering without having read the rest of the request body: an
     over-length upload, or — since #74 — any refusal that happens before
     readBody(), which is now every gated route's 401. The client is still
     sending; keeping the connection alive would leave its unread bytes in
     front of the next request on it, so this response ends the connection
     and Node discards what is still arriving.

     `res.req` is Node's own back-reference to the request, which is what
     lets this be decided here rather than at forty call sites: a route
     added later cannot forget it, exactly as with the CORS headers below. */
  if (stillUploading(res.req) || (opts && opts.close)) headers["Connection"] = "close";
  /* Stamped on the response object by the request handler below, where the
     request is still in scope. Doing it there rather than threading `req`
     through every sendJson() call site means a route added later cannot
     forget the CORS headers — and static files, which are answered without
     this helper, still never get them. */
  if (res.corsHeaders) Object.assign(headers, res.corsHeaders);
  res.writeHead(status, headers);
  res.end(payload);
}

/* Small enough for a PIN, a link key or a heartbeat, which is all the two
   routes that read a body before they know who is asking ever carry. MAX_BODY
   is sized for a script with images in it, and a caller who has not proved
   anything yet has no business sending one (#74). */
const SMALL_BODY = 8 * 1024;

function readBody(req, limit) {
  return readRawBody(req, limit || MAX_BODY).then((buf) => {
    try {
      const text = buf.toString("utf8");
      return text ? JSON.parse(text) : {};
    } catch (err) {
      throw Object.assign(new Error("bad-json"), { code: "BAD_JSON" });
    }
  });
}

/* The body as bytes, capped. An image upload (#82) is not JSON, and every
   JSON body is these bytes parsed. */
function readRawBody(req, limit) {
  const max = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > max) {
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
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/* A summary for the picker: enough to choose a document without shipping
   every row of every script to build a list. Built from the head line when
   there is one — which is the whole point of the head line, since drawing a
   list of names used to mean parsing every script in the library in full. */
function summarise(head) {
  return {
    id: head.id,
    title: (head.title || "Untitled Script"),
    rev: head.rev || 0,
    rows: typeof head.rows === "number" ? head.rows : 0,
    updatedAt: head.updatedAt || null,
    updatedBy: head.updatedBy || null
  };
}

/* Documents this process has already offered a head line to. Once each: a
   file that cannot be given a readable one — a name so long it does not fit
   the read, a filesystem that refused the write — would otherwise be
   rewritten by every listing for as long as the server runs. */
const headUpgraded = new Set();

/* One document's line in the picker, or null if it is not there. Reads the
   head line; falls back to the whole file for a document saved before head
   lines existed, and — unless this library is published read-only — rewrites
   that document with one so the next listing is cheap. The rewrite is the
   same content under the same lock as any other write, so it cannot race a
   save or change what the document says. */
async function summaryOf(id) {
  const head = await readDocHead(id).catch(() => null);
  if (head) return summarise(head);
  const doc = await readDoc(id).catch(() => null);
  if (!doc) return null;
  if (!READ_ONLY && !headUpgraded.has(id)) {
    headUpgraded.add(id);
    withDocLock(id, async () => {
      if (await readDocHead(id)) return; /* somebody rewrote it first */
      const current = await readDoc(id);
      /* Only ever rewrite a file that names itself: an id that disagrees
         with its filename is not something a listing should be repairing. */
      if (current && current.id === id) await writeDoc(current);
    }).catch(() => { /* a listing is not the place to fail over this */ });
  }
  return summarise(headOf(doc));
}

/* ---------- the launcher's routes ----------
 *
 * One route, and all it does is describe this process: where the copy of the
 * app it is serving sits on disk, and what it is running on. The first-run
 * wizard asks, so that step 2 can name the folder rather than talk about it
 * in the abstract.
 *
 * It used to do more, and what it did is why the locks below exist.
 * `register` spawned `installer/install.ps1` to put this folder in the Start
 * Menu, and `update/stage` spawned `update.mjs stage --json` to download a
 * release. #75 deleted both of those programs, so both routes went with
 * them — and with them the last place this server started another process
 * at all (invariant #28 is now a flat no, with no exception attached).
 *
 * The locks stay exactly as they were. They are the reason a route here
 * could exist in the first place, they are cheap, and `root` is still an
 * absolute path off somebody's disk, which is nobody else's business:
 *   1. a launch token, minted by start.mjs for this launch and handed to the
 *      page in the URL fragment — so another tab in the same browser, which
 *      can reach localhost just as easily, cannot call this;
 *   2. HOST === "127.0.0.1" — never under --host, where the port is on the
 *      network.
 * Anything that ever lands here next inherits both.
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

function handleLauncher(req, res, parts) {
  if (!launcherAllowed(req)) return sendJson(res, 404, { error: "not-found" });

  if (parts[2] === "info" && req.method === "GET") {
    return sendJson(res, 200, {
      root: path.resolve(STATIC_DIR),
      arch: process.arch,
      platform: process.platform
    });
  }

  return sendJson(res, 404, { error: "not-found" });
}

/* ---------- who else is here ----------
 *
 * A heartbeat and a listing in one round trip: a client posts where it is,
 * and is told where everybody else is. That is the whole of it.
 *
 * IN MEMORY, AND NOWHERE ELSE. Presence is not part of a document and must
 * never become part of one: this map is the only place it lives, nothing
 * reads it on the way to writeDoc(), and it holds seconds of state — a
 * restart forgets everyone, which is correct, because everyone would
 * reconnect within one beat anyway. It is capped in both directions so a
 * client that invents document ids or client ids cannot grow it without
 * bound, and swept on every request rather than on a timer, because there is
 * nothing to sweep when nobody is asking.
 *
 * TTL is a few beats, not minutes: it is what makes a closed tab disappear
 * when its "I'm gone" beacon never arrives.
 */
/* Overridable only so a test can watch an entry expire without waiting out a
   real one (tools/test-server.mjs); nothing that ships sets it. */
const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS || 15000);
const PRESENCE_MAX_PER_DOC = 50;
const PRESENCE_MAX_DOCS = 200;
const presenceByDoc = new Map();   /* docId -> Map(clientId -> {name, rowId, field, at}) */

function sweepPresence(now) {
  for (const [docId, people] of presenceByDoc) {
    for (const [id, who] of people) {
      if (now - who.at > PRESENCE_TTL_MS) people.delete(id);
    }
    if (!people.size) presenceByDoc.delete(docId);
  }
}

/* Every string that comes back out of here is shown by another person's
   browser, so it is bounded and whitelisted on the way in. The name is the
   one free-text field and is only ever rendered as text. */
function presenceWord(value, max) {
  /* C0 controls and DEL. These used to be three LITERAL control bytes sitting
     inside the character class in this file — invisible in every editor and
     one careless re-encode away from silently changing meaning. Written as
     \x escapes now, the same way desktop/main.js:draftScalarString already
     wrote the identical class, and for the reason its comment gives (#68). */
  /* eslint-disable-next-line no-control-regex -- stripping them is the job. */
  return String(value == null ? "" : value).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
}

function presenceHandle(value) {
  const v = String(value == null ? "" : value);
  return /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : "";
}

/* ---------- the rev a heartbeat carries (issue #69) ----------
 *
 * The beat is the only thing in hosted mode that round-trips on its own, so
 * it is also the pull channel: it names the document's current rev and the
 * client goes and gets the document when that number has moved past the one
 * it is holding. Nothing else about the document is sent — the client does
 * a normal GET, which is the one request that already knows how to hand a
 * whole script back.
 *
 * readDocHead() and NOT readDocMeta(): one positional read of the first 8KB
 * (#74), never a parse. This runs every two seconds for every tab in every
 * open document, and parsing a script with base64 stills in it at that rate
 * — to read one number off the front of it — is exactly what the head line
 * was added to stop. A document written before head lines existed therefore
 * answers with no rev at all rather than being parsed here: it has no pull
 * channel until the next listing or the next save gives it a head line,
 * which both do on their own.
 *
 * Failure is silence, not an error. A beat is a heartbeat; it must not turn
 * a missing or unreadable file into something the other end has to handle.
 */
async function presenceRev(docId) {
  try {
    const head = await readDocHead(docId);
    return head && typeof head.rev === "number" ? head.rev : null;
  } catch (err) {
    return null;
  }
}

/* ---------- a comment, without the document around it (#71) ----------
 *
 * This is the ONLY way a review token writes anything. It used to be a
 * whole-document PUT that the server accepted only if it could prove, by
 * comparing the upload against the stored script key by key (with a
 * hand-rolled HTML tokenizer for the scene text), that nothing but a comment
 * had moved. That was an expensive way to post four words, and it failed in
 * ways nobody could explain from the outside — #62 was a reviewer seeing
 * "review-only" because their copy carried `brollShots: []` and the stored
 * one, saved before that field existed, carried no such key. It would have
 * broken again with every field the state ever gained.
 *
 * So: a route that takes the comment and nothing else. The reviewer never
 * sends the state, the server never diffs a document, and the two facts the
 * comparison existed to prove — that a comment may only be ADDED, and that
 * nothing else in the document may move — are no longer assertions to
 * check but the only operations this code can perform. A review PUT is now
 * refused outright, before its body is read (#71).
 *
 * Three things this route is careful about:
 *
 *   1. it reads the stored document INSIDE the document's lock and appends
 *      to what it finds there. There is no baseRev and no compare-and-set,
 *      because there is nothing to conflict over: two reviewers commenting
 *      in the same second queue behind each other and both comments land.
 *      A read-modify-write outside the lock would have the second one
 *      overwrite the first, which is the exact failure the whole-document
 *      PUT had to hand a 409 back to avoid;
 *   2. it is idempotent by comment id. A client that posts, loses the
 *      answer to a dropped connection and posts again gets the comment it
 *      already has and the rev it is already at, not a second copy of its
 *      own comment;
 *   3. it bounds every field on the way in. The server has no DOM and does
 *      not sanitise HTML — it never has, on any route; the client does that
 *      on the way in and on the way out (migrateRows is the only door).
 *      What this adds is a SHAPE: a comment that reaches storage from here
 *      has the keys a comment has, sized the way a comment is sized, and
 *      carries no other key at all.
 */

/* One comment, with at most a pasted screenshot inside it and at most one
   scene field's worth of HTML beside it for the anchor. Deliberately its own
   cap rather than MAX_BODY: MAX_BODY is 25 MB because a whole script full of
   embedded images has to fit through PUT, and the entire point of this route
   is that a reviewer never sends one (#71, #74). Equally deliberately not
   SMALL_BODY, which is sized for a PIN: a comment with a screenshot pasted
   into it is a normal comment and must not be refused. */
const COMMENT_BODY = 512 * 1024;
const COMMENT_HTML_MAX = 256 * 1024;   /* one comment body, or one anchored field */
const COMMENT_NAME_MAX = 80;           /* matches the client's plainName() */
const COMMENT_QUOTE_MAX = 2000;
/* Bounds on the document rather than on the request: a reviewer who is
   allowed to append forever is a reviewer who can grow a script past the
   25 MB it can be saved in, one legitimate comment at a time. */
const DOC_COMMENTS_MAX = 2000;
const COMMENT_REPLIES_MAX = 500;

/* Names, quotes and assignees are plain text and only ever rendered as text,
   exactly as on the client (plainText/plainName in 04-richtext.js): markup
   stripped, control characters dropped, bounded. */
function commentText(value, max) {
  return String(value == null ? "" : value)
    .replace(/<[^>]*>/g, "")
    /* eslint-disable-next-line no-control-regex -- C0 controls, minus the
       tab/LF/CR a comment may legitimately contain, are what this strips. */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
}

/* A comment id ends up in a CSS attribute selector and in a `data-cmt`
   attribute in someone else's browser, so it is whitelisted rather than
   sanitised — the same reasoning as a document id, and the same character
   set the client's safeId() leaves behind. */
function commentIdOf(value) {
  const id = String(value == null ? "" : value);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

/* The comment as it will be stored, or null for anything that is not one.
 *
 * Built key by key rather than copied and cleaned, so a field this server
 * has never heard of cannot arrive through here. `resolved` is hard-coded
 * false and the timestamps are this process's clock: a comment is born
 * unresolved, and when it was posted is something the server knows and the
 * poster only claims.
 */
function cleanComment(input, now, fallbackAuthor) {
  if (!input || typeof input !== "object") return null;
  const id = commentIdOf(input.id);
  if (!id) return null;
  const body = typeof input.body === "string" ? input.body : "";
  if (!body || body.length > COMMENT_HTML_MAX) return null;
  /* A title comment is the merge's document-level conflict card: it belongs
     to no row, and the client's migrateRows nulls its rowId and anchorId to
     keep it from being folded into one. Every other comment names a row. */
  const onTitle = input.field === "title";
  const rowId = commentIdOf(input.rowId);
  if (!onTitle && !rowId) return null;
  return {
    id,
    rowId: onTitle ? null : rowId,
    field: onTitle ? "title"
      : (input.field === "visualText" || input.field === "visualImage") ? input.field : "audioText",
    anchorId: onTitle ? null : (commentIdOf(input.anchorId) || id),
    quotedText: commentText(input.quotedText, COMMENT_QUOTE_MAX),
    author: commentText(input.author, COMMENT_NAME_MAX) || fallbackAuthor || "Anonymous",
    body,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    assignee: commentText(input.assignee, COMMENT_NAME_MAX),
    createdAt: now,
    updatedAt: now,
    kind: input.kind === "conflict" ? "conflict" : "anchor",
    replies: []
  };
}

function cleanReply(input, now, fallbackAuthor) {
  if (!input || typeof input !== "object") return null;
  const id = commentIdOf(input.id);
  if (!id) return null;
  const body = typeof input.body === "string" ? input.body : "";
  if (!body || body.length > COMMENT_HTML_MAX) return null;
  return {
    id,
    author: commentText(input.author, COMMENT_NAME_MAX) || fallbackAuthor || "Anonymous",
    body,
    createdAt: now
  };
}

/* ---------- the anchor ----------
 *
 * The one place a comment touches the script itself: the `.cmt-anchor` span
 * wrapped around the words it is about lives in the row's HTML, so posting a
 * comment on a phrase is genuinely an edit to that phrase's field.
 *
 * The request carries that ONE field's new HTML — a scene, not a script — and
 * it is accepted only if unwrapping this comment's own anchor out of it gives
 * back the same words, links, images and line breaks as what is stored.
 *
 * That comparison is the one piece of the old whole-document proof that
 * survives (#71), and it survives because this is the one question that
 * still needs it: "is this the same scene text with a span around some of
 * it?" cannot be answered by comparing strings. Wrapping a selection that
 * crosses a <strong> boundary splits that element in two, and unwrapping the
 * span cannot glue it back together; a browser may also re-serialise an
 * element's attributes in another order. So the field is compared as a
 * sequence of text runs, each labelled with the inline elements around it —
 * fieldSignature() below, over the quote-aware tokenizer htmlTokens(). It
 * looks at one field of one row and nothing else, so unlike the document
 * compare it replaced it has no opinion about the shape of the state and
 * nothing to rot when that shape changes.
 */

/* Attributes as a set rather than as written, so two serialisations of the
   same element compare equal whatever order or spacing they came out in. */
function normalizeAttrs(attrs) {
  const pairs = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(String(attrs || "")))) {
    const value = m[2] === undefined ? "" : m[2].replace(/^["']|["']$/g, "");
    pairs.push(m[1].toLowerCase() + "=" + value);
  }
  pairs.sort();
  return pairs.join(" ");
}

const VOID_TAGS = new Set(["br", "img", "hr", "input", "wbr", "source", "track", "col", "area", "base", "embed", "link", "meta"]);

/* Quote-aware, because a ">" inside an attribute value is serialised as
   itself and would otherwise end the tag early. */
function htmlTokens(html) {
  const s = String(html == null ? "" : html);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) { tokens.push({ kind: "text", text: s.slice(i) }); break; }
    if (lt > i) tokens.push({ kind: "text", text: s.slice(i, lt) });
    let j = lt + 1;
    let quote = "";
    while (j < s.length) {
      const ch = s[j];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      j++;
    }
    if (j >= s.length) { tokens.push({ kind: "text", text: s.slice(lt) }); break; }
    const raw = s.slice(lt + 1, j);
    i = j + 1;
    if (raw.charAt(0) === "!" || raw.charAt(0) === "?") continue; /* a comment or a doctype is not content */
    const close = raw.charAt(0) === "/";
    const body = close ? raw.slice(1) : raw;
    const name = (body.match(/^[a-zA-Z0-9-]+/) || [""])[0].toLowerCase();
    if (!name) continue;
    tokens.push({
      kind: close ? "close" : "open",
      name,
      attrs: body.slice(name.length).replace(/\/\s*$/, "").trim(),
      selfClosing: /\/\s*$/.test(body)
    });
  }
  return tokens;
}

function attrValue(attrs, name) {
  const re = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s]+))", "i");
  const m = re.exec(String(attrs || ""));
  return m ? String(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : "";
}

/* The comment id of a `<span class="cmt-anchor" data-cmt="…">`, or "" for
   any other element. */
function anchorIdOf(attrs) {
  if (attrValue(attrs, "class").split(/\s+/).indexOf("cmt-anchor") === -1) return "";
  return attrValue(attrs, "data-cmt");
}

/* A field as the sequence of its text runs, each labelled with the inline
   elements wrapped around it, plus <br>/<img> in place (sanitizeHtml never
   lets a div or a p through — they come back as <br> — so there is no block
   structure left to preserve). `dropId` unwraps the one comment anchor the
   request is adding, which is what makes "the same words, now with a comment
   on some of them" compare equal to what is stored.
 *
 * Deliberately blind to exactly one thing: WHERE an inline element starts and
 * stops, when the text and the labels either side are identical. Wrapping a
 * selection that crosses a <strong> boundary splits that element in two, and
 * unwrapping the anchor again cannot glue it back together — so
 * `<strong>hel</strong><strong>lo</strong>` has to compare equal to
 * `<strong>hello</strong>`. The two render the same and say the same. */
function fieldSignature(html, dropId) {
  const path = [];       /* [{ name, sig, dropped }] */
  const out = [];
  const label = () => path.filter((p) => !p.dropped).map((p) => p.sig).join("");
  for (const tk of htmlTokens(html)) {
    if (tk.kind === "text") {
      if (!tk.text) continue;
      const key = label();
      const last = out[out.length - 1];
      if (last && last.kind === "text" && last.key === key) last.text += tk.text;
      else out.push({ kind: "text", key, text: tk.text });
      continue;
    }
    const sig = tk.name + (tk.attrs ? " " + normalizeAttrs(tk.attrs) : "");
    if (tk.kind === "open") {
      if (VOID_TAGS.has(tk.name) || tk.selfClosing) { out.push({ kind: "void", key: label(), sig }); continue; }
      const dropped = tk.name === "span" && !!dropId && anchorIdOf(tk.attrs) === dropId;
      path.push({ name: tk.name, sig, dropped });
      continue;
    }
    if (VOID_TAGS.has(tk.name)) continue;
    for (let n = path.length - 1; n >= 0; n--) {
      if (path[n].name === tk.name) { path.length = n; break; }
    }
  }
  return out
    .filter((item) => item.kind === "void" || item.text.length)
    .map((item) => item.kind + "" + item.key + "" + (item.kind === "void" ? item.sig : item.text))
    .join("");
}

/* Where this comment's anchor goes.
 *
 * A mismatch is NOT a refusal. Somebody else may have rewritten that scene
 * while the reviewer was typing, and in that case the anchor is stale but the
 * comment is not: it still names its row, its field and the words it quoted,
 * so it still lands and still opens the right scene. Losing a reviewer's
 * paragraph because a word moved would be the worse answer by far. The
 * response says which happened, in `anchored`.
 *
 * Returns "none" (nothing was asked for), "ok" (placed), "stale" (the scene
 * has moved on) or "bad" (not an anchor at all — that one IS a refusal,
 * because it is a client sending nonsense rather than a document changing).
 */
function placeAnchor(state, anchor, cmtId, author, now) {
  if (anchor === undefined || anchor === null) return "none";
  if (typeof anchor !== "object") return "bad";
  const field = anchor.field;
  if (field !== "visualText" && field !== "audioText") return "bad";
  const rowId = commentIdOf(anchor.rowId);
  const html = anchor.html;
  if (!rowId || typeof html !== "string" || html.length > COMMENT_HTML_MAX) return "bad";
  const rows = Array.isArray(state.rows) ? state.rows : [];
  let row = null;
  for (const r of rows) if (r && typeof r === "object" && r.id === rowId) { row = r; break; }
  if (!row) return "stale";
  if (fieldSignature(row[field], "") !== fieldSignature(html, cmtId)) return "stale";
  row[field] = html;
  /* Posting a comment stamps the scene it landed on, and nothing else. */
  row.updatedAt = now;
  row.updatedBy = author;
  return "ok";
}

/* The document a comment write leaves behind. Built fresh from `id`, `state`
   and the new rev exactly as PUT builds it, so both paths store the same
   shape, and written through writeDoc() so the head line is regenerated from
   the state that is actually going to disk and the fsync discipline is the
   same one every other save gets (#74).

   `lastEditedBy`/`lastEditedAt` move with it. A comment IS a save — a
   reviewer's name there is true, not a forged edit — and it is what makes
   the client's "opened the latest version, last edited by …" honest. The
   state's own `rev` is left alone: that is the client's merge counter
   (max-plus-one, 02-state.js), and the rev this API compares against is the
   document's, which is bumped here. */
async function writeCommentChange(id, doc, state, by, now) {
  if (by) {
    state.lastEditedBy = by;
    state.lastEditedAt = now;
  }
  const next = {
    id,
    rev: (doc.rev || 0) + 1,
    state,
    updatedAt: now,
    updatedBy: by || doc.updatedBy || null
  };
  await writeDoc(next);
  return next;
}

/* The stored document, ready to be appended to, or a refusal to send back.
   A document with no `comments` array is not an error and never was — one
   saved before comments existed simply has none (#62's lesson: absence is
   not disagreement). */
async function openForComment(id) {
  const doc = await readDoc(id);
  if (!doc) return { error: { status: 404, body: { error: "not-found" } } };
  const state = doc.state;
  if (!state || typeof state !== "object") {
    return { error: { status: 409, body: { error: "no-state" } } };
  }
  if (!Array.isArray(state.comments)) state.comments = [];
  return { doc, state };
}

function findComment(state, cid) {
  for (const c of state.comments) if (c && typeof c === "object" && c.id === cid) return c;
  return null;
}

/* What every answer from this route looks like: the new rev, who it is now
   attributed to, and the stored comment — so the client adopts the server's
   copy (its bounded author, its server clock) instead of keeping its own. */
function commentAnswer(id, doc, comment, extra) {
  return Object.assign({
    id,
    rev: doc.rev || 0,
    updatedAt: doc.updatedAt || null,
    updatedBy: doc.updatedBy || null,
    comment
  }, extra || {});
}

/* ---------- images, as content-addressed blobs (#82) ----------
 *
 * An image is stored once, under the SHA-256 of its bytes, and a document
 * names it by that hash instead of carrying it: `row.imageRef.sha256` for a
 * scene's still, `<img data-blob="<sha>">` inside a comment, a reply or a
 * scene's HTML. The bytes live at DATA_DIR/blobs/<first two hex>/<sha>, raw,
 * written the same durable way a document is (temp in the same directory,
 * fsync, rename, fsync the directory).
 *
 * Global and content-addressed (owner's decision): two documents holding the
 * same screenshot hold one file. Nothing here ever deletes one (also the
 * owner's decision, for this issue); a successful save touches the mtime of
 * every blob it names, so a collector written later can tell what is in use.
 *
 * The rule every durable write keeps: NO DURABLE RECORD NAMES A BLOB ITS
 * STORE DOES NOT ALREADY HOLD DURABLY. Here that is the 422 below — a save
 * or a comment naming a blob this server does not have is refused, and the
 * client uploads it and asks again. The one exception is explicit: a save
 * may list a sha in `acceptMissing` when the client KNOWS the bytes are gone
 * for good (a history snapshot restored after its image was lost), so a
 * missing picture cannot make a script unsaveable.
 *
 * Legacy states that carry their images inline as base64 are accepted
 * forever; nothing here looks at them.
 */
const BLOBS_DIR = path.join(DATA_DIR, "blobs");
const SHA_RE = /^[0-9a-f]{64}$/;
/* The one client version this server needs to know about (D7): 2 is the
   first that keeps blob references. An older client does not know an
   `imageRef` is an image, and a save from one would write back a script
   whose stills it could not see — so it is refused where that matters. */
const CLIENT_BLOBS = 2;
/* 2000 hashes and the JSON around them. */
const MISSING_BODY = 256 * 1024;
const MISSING_MAX = 2000;

function isSha(value) {
  return typeof value === "string" && SHA_RE.test(value);
}

function blobPath(sha) {
  return path.join(BLOBS_DIR, sha.slice(0, 2), sha);
}

/* PNG, JPEG, GIF or WebP, from the first bytes, or "" for anything else.
   Never SVG: an SVG is a document that can carry script, and a blob is
   served from this origin. */
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head = buf.toString("latin1", 0, 12);
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return "";
}

function sha256Of(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* Every sha a state names: an image record (`imageRef` on a row, or the
   `imageValue` an image conflict card carries) and every `data-blob`
   attribute on a tag in any string in it — comment and reply bodies and a
   row's HTML fields included. Deliberately wider than any one client's
   walker: for the 422 check a wider net only asks for more of what must be
   there anyway, and for a review link it only lets it see images its own
   document shows. Attributes are read through htmlTokens(), so words that
   merely LOOK like one in a script's text do not count. */
function refsIn(state) {
  const out = new Set();
  const walk = (value, key, depth) => {
    if (depth > 64) return;
    if (typeof value === "string") {
      if (value.indexOf("data-blob") !== -1) blobAttrsIn(value, out);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, "", depth + 1);
      return;
    }
    if ((key === "imageRef" || key === "imageValue") && isSha(value.sha256)) out.add(value.sha256);
    for (const k of Object.keys(value)) walk(value[k], k, depth + 1);
  };
  walk(state, "", 0);
  return out;
}

function blobAttrsIn(html, out) {
  for (const tk of htmlTokens(html)) {
    if (tk.kind !== "open" || tk.attrs.indexOf("data-blob") === -1) continue;
    const sha = attrValue(tk.attrs, "data-blob");
    if (isSha(sha)) out.add(sha);
  }
}

/* The refs of a stored document, by id and rev. writeDoc() files them as it
   writes, so the common case is a lookup; a document this process has not
   written since it started is parsed once. Bounded like everything else in
   memory here. */
const refsCache = new Map();   /* docId -> { rev, refs:Set } */
const REFS_CACHE_MAX = 200;

function noteRefs(id, rev, refs) {
  refsCache.delete(id);
  if (refsCache.size >= REFS_CACHE_MAX) refsCache.delete(refsCache.keys().next().value);
  refsCache.set(id, { rev, refs });
}

/* A Set, or null when there is no such document. */
async function storedRefsOf(id) {
  const meta = await readDocMeta(id);
  if (!meta) return null;
  const rev = meta.rev || 0;
  const hit = refsCache.get(id);
  if (hit && hit.rev === rev) return hit.refs;
  const doc = await readDoc(id);
  if (!doc) return null;
  const refs = refsIn(doc.state);
  noteRefs(id, doc.rev || 0, refs);
  return refs;
}

async function hasBlob(sha) {
  try {
    return (await fsp.stat(blobPath(sha))).isFile();
  } catch (err) {
    return false;
  }
}

/* The shas in `shas` this server does not hold. */
async function blobsMissing(shas) {
  const missing = [];
  for (const sha of shas) if (!(await hasBlob(sha))) missing.push(sha);
  return missing;
}

/* Best effort, never awaited by anything that answers: a blob in use is a
   blob whose mtime is recent, and that is all a later collector would ask. */
function touchBlobs(shas) {
  const now = new Date();
  for (const sha of shas) fsp.utimes(blobPath(sha), now, now).catch(() => {});
}

async function writeBlob(sha, buf) {
  const dir = path.dirname(blobPath(sha));
  /* mkdir -p returns the first directory it had to create, if any. A new
     directory is a new name in its parent, and a name is durable only once
     the parent is synced — the same reason writeFileDurable() syncs the
     directory it renamed into. */
  const created = await fsp.mkdir(dir, { recursive: true });
  if (created) {
    await syncDir(BLOBS_DIR);
    await syncDir(DATA_DIR);
  }
  await writeFileDurable(blobPath(sha), buf);
}

/* What a PUT or POST names that the store does not hold, minus what the
   stored document already names (a ref that was already dangling cannot be
   fixed by refusing the next save) and minus what the client said it knows
   is gone (`acceptMissing`). Empty means the write may go ahead.
   `docId` names the stored document, or is "" for a new one; its refs are
   only looked up when something is actually missing, which on a server
   holding every image is never. */
async function refusedRefs(incoming, docId, acceptMissing) {
  if (!incoming.size) return [];
  const missing = await blobsMissing(incoming);
  if (!missing.length) return [];
  const accept = new Set(Array.isArray(acceptMissing) ? acceptMissing.filter(isSha) : []);
  const stored = docId ? await storedRefsOf(docId) : null;
  return missing.filter((sha) => !accept.has(sha) && !(stored && stored.has(sha)));
}

/* The images a new comment or reply body names that it may not name: ones
   this server does not hold (the same 422 a save gets, and the same excuse
   for one its document already names), and — for a per-document review link
   — ones it can neither see in its document nor has uploaded itself, which
   are answered as missing whether or not they are here, so posting a comment
   is not a way to ask what the rest of the library holds. */
async function commentRefsRefused(req, role, docId, html) {
  const refs = new Set();
  if (typeof html === "string" && html.indexOf("data-blob") !== -1) blobAttrsIn(html, refs);
  if (!refs.size) return { refs, missing: [] };
  const visible = await blobVisibility(req, role);
  let stored;
  const missing = [];
  for (const sha of refs) {
    if (visible && !visible(sha)) { missing.push(sha); continue; }
    if (await hasBlob(sha)) continue;
    if (stored === undefined) stored = (await storedRefsOf(docId)) || new Set();
    if (!stored.has(sha)) missing.push(sha);
  }
  return { refs, missing };
}

/* Does this request come from a client that knows what a blob ref is? */
function clientKnowsBlobs(req) {
  const v = parseInt(String(req.headers["x-splitpage-client"] || ""), 10);
  return isFinite(v) && v >= CLIENT_BLOBS;
}

/* ---------- a reviewer's image budget ----------
 *
 * A reviewer may upload the screenshots they paste into comments (D6), up to
 * REVIEW_BLOB_BUDGET bytes per token per rolling hour. The bytes are RESERVED
 * before the body is read — the declared length, or the whole per-blob cap
 * for a chunked upload — so ten uploads started at once cannot each find the
 * budget empty; the reservation is settled to what was actually stored when
 * the upload ends, and to nothing when it fails.
 *
 * The ledger also remembers which shas a token has uploaded. A per-document
 * review link sees only the images its document names — and the images it
 * has itself handed over, because it holds those bytes already. That is what
 * lets a comment carrying a fresh screenshot pass the 422 check below without
 * the check telling a link-holder whether some OTHER document on this server
 * holds an image with that hash.
 */
const reviewLedgers = new Map();   /* token -> [{ at, bytes, sha }] */

function reviewLedger(token, now) {
  const list = (reviewLedgers.get(token) || []).filter((e) => now - e.at < REVIEW_BLOB_WINDOW_MS);
  if (list.length) reviewLedgers.set(token, list); else reviewLedgers.delete(token);
  return list;
}

/* A file costs at least a block on the disk, and a floor on the charge is
   also a ceiling on how many entries a ledger can hold. */
const BLOB_MIN_CHARGE = 4096;

function blobCharge(bytes) {
  return Math.max(BLOB_MIN_CHARGE, bytes);
}

function reviewBytesUsed(token, now) {
  let used = 0;
  for (const e of reviewLedger(token, now)) used += e.bytes;
  return used;
}

function reviewUploaded(token, sha) {
  return reviewLedger(token, Date.now()).some((e) => e.sha === sha);
}

/* Which shas this caller may learn anything about. Everything, for an editor
   and for the library-wide review credential (either can read every document
   there is). For a per-document review link: what its document names, plus
   what it uploaded itself. */
async function blobVisibility(req, role) {
  if (role !== "review") return null;
  const scope = reviewScopeOf(req);
  if (!scope) return null;
  const token = String(req.headers["x-splitpage-token"] || "");
  const refs = (await storedRefsOf(scope)) || new Set();
  return (sha) => refs.has(sha) || reviewUploaded(token, sha);
}

/* GET, PUT and POST /missing under /api/blobs. Called after the gate, with
   the caller's role. */
async function handleBlobs(req, res, parts, role) {
  if (parts[2] === "missing" && parts.length === 3) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
    const body = await readBody(req, MISSING_BODY);
    const shas = body && body.shas;
    if (!Array.isArray(shas) || shas.length > MISSING_MAX || !shas.every(isSha)) {
      return sendJson(res, 400, { error: "bad-shas" });
    }
    const unique = Array.from(new Set(shas));
    const visible = await blobVisibility(req, role);
    /* A per-document link is told the truth about what it may see, and that
       everything else is missing. "Missing" costs it one upload of bytes it
       already holds; the truth would tell it what the rest of the library
       contains. */
    const missing = [];
    for (const sha of unique) {
      if (visible && !visible(sha)) missing.push(sha);
      else if (!(await hasBlob(sha))) missing.push(sha);
    }
    return sendJson(res, 200, { missing });
  }

  if (parts.length !== 3) return sendJson(res, 404, { error: "not-found" });
  const sha = parts[2];

  if (req.method === "GET") {
    if (!isSha(sha)) return sendJson(res, 400, { error: "bad-sha" });
    const visible = await blobVisibility(req, role);
    /* Not "forbidden": a link that may not see a blob is told it is not
       there, exactly as if it were not, so asking reveals nothing. */
    if (visible && !visible(sha)) return sendJson(res, 404, { error: "not-found" });
    let buf;
    try {
      buf = await fsp.readFile(blobPath(sha));
    } catch (err) {
      if (err && err.code === "ENOENT") return sendJson(res, 404, { error: "not-found" });
      throw err;
    }
    const mime = sniffImageMime(buf);
    /* A file that is not what its name says — a bad disk, a hand edit — is
       not served as if it were. Not deleted either (D4): the next upload of
       the real bytes replaces it. */
    if (!mime || sha256Of(buf) !== sha) {
      console.error("[splitpage] blob " + sha + " does not match its name; not serving it");
      return sendJson(res, 404, { error: "not-found" });
    }
    const headers = Object.assign({
      "Cache-Control": "private, max-age=31536000, immutable",
      "ETag": "\"" + sha + "\"",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox"
    }, res.corsHeaders || {});
    const inm = String(req.headers["if-none-match"] || "");
    if (inm.split(",").some((t) => t.trim().replace(/^W\//, "") === "\"" + sha + "\"")) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers["Content-Type"] = mime;
    headers["Content-Length"] = buf.length;
    res.writeHead(200, headers);
    res.end(buf);
    return;
  }

  if (req.method === "PUT") {
    /* Everything that can refuse this without the bytes does so before a
       byte is read (#74): the library, the hash's shape, the declared size,
       and a reviewer's budget. */
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    if (!isSha(sha)) return sendJson(res, 400, { error: "bad-sha" });
    const declared = req.headers["content-length"] !== undefined
      ? Number(req.headers["content-length"]) : NaN;
    if (isFinite(declared) && declared > MAX_BLOB_BYTES) {
      return sendJson(res, 413, { error: "too-large" });
    }
    let entry = null;
    const token = String(req.headers["x-splitpage-token"] || "");
    if (role === "review") {
      const now = Date.now();
      const reserve = blobCharge(isFinite(declared) && declared >= 0 ? declared : MAX_BLOB_BYTES);
      if (reviewBytesUsed(token, now) + reserve > REVIEW_BLOB_BUDGET) {
        return sendJson(res, 429, { error: "review-budget" });
      }
      entry = { at: now, bytes: reserve, sha: "" };
      const list = reviewLedger(token, now);
      list.push(entry);
      reviewLedgers.set(token, list);
    }
    try {
      const buf = await readRawBody(req, MAX_BLOB_BYTES);
      if (sha256Of(buf) !== sha) return sendJson(res, 400, { error: "hash-mismatch" });
      if (!sniffImageMime(buf)) return sendJson(res, 415, { error: "unsupported-type" });
      const visible = await blobVisibility(req, role);
      const truthful = !visible || visible(sha);
      let present = false;
      if (await hasBlob(sha)) {
        /* Present only if it is what it says: a damaged copy is replaced by
           the good bytes just received, never kept in their place. */
        present = sha256Of(await fsp.readFile(blobPath(sha)).catch(() => Buffer.alloc(0))) === sha;
      }
      if (present) touchBlobs([sha]);
      else await writeBlob(sha, buf);
      if (entry && !(present && truthful)) {
        /* Charged for what it cost the disk — or, for a per-document link
           that is told "stored" about a blob it could not have known was
           here, charged as though it had, so the two answers cannot be told
           apart by the budget either. A re-upload of something the caller
           could see anyway costs nothing and needs no entry (the finally
           below drops it). */
        entry.sha = sha;
        entry.bytes = blobCharge(buf.length);
        entry = null;
      }
      /* A per-document link is only told the blob was already here when it
         could have seen it anyway; otherwise the answer is the one a new
         upload gets, and says nothing about what else the library holds. */
      if (present && truthful) return sendJson(res, 200, { stored: false });
      return sendJson(res, 201, { stored: true });
    } finally {
      /* Refused, failed, or free: nothing charged, and no entry left behind
         for a caller to grow the ledger with. */
      if (entry) {
        const list = reviewLedgers.get(token);
        const at = list ? list.indexOf(entry) : -1;
        if (at !== -1) list.splice(at, 1);
      }
    }
  }

  return sendJson(res, 405, { error: "method-not-allowed" });
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
      /* whether a second, comment-only credential exists at all — not what
         it is. A client needs this to know a review link is worth offering */
      reviewAvailable: REVIEW_ACTIVE,
      /* This server stores images as blobs under /api/blobs (#82). A client
         keeps its images as references only against a server that says so. */
      blobs: 1,
      version: VERSION
    });
  }

  /* Open, because it is the door: post the PIN, get the token every other
     route wants. Rate-limited per address so the six digits cannot simply be
     enumerated. */
  if (parts[1] === "join" && req.method === "POST") {
    if (!JOIN_PIN) return sendJson(res, 200, { token: SESSION_TOKEN, role: "edit", open: true });
    const ip = clientIp(req);
    if (recentFailures(ip).length >= PIN_MAX_FAILURES) {
      return sendJson(res, 429, { error: "too-many-attempts" });
    }
    /* A PIN and a link key are a few dozen bytes between them, and this is
       the one route that anyone at all may call, so it reads a small body
       rather than a document-sized one (#74). */
    const body = await readBody(req, SMALL_BODY);
    /* The join PIN is checked first, so a review PIN set to the same digits
       by mistake can never take the host's own session down to read-only. */
    if (sameSecret(body && body.pin, JOIN_PIN)) {
      pinFailures.delete(ip);
      return sendJson(res, 200, { token: SESSION_TOKEN, role: "edit" });
    }
    /* A per-document review link (#63): its key names one document, and the
       token it hands back is held to that document by every route below.
       Checked before the launch-wide credential so a link always wins over
       the library-wide one, never the other way round. */
    if (REVIEW_ACTIVE && body && typeof body.key === "string") {
      const grant = reviewGrantsByKey.get(body.key);
      if (grant) {
        pinFailures.delete(ip);
        return sendJson(res, 200, { token: grant.token, role: "review", docId: grant.docId });
      }
    }
    /* Either half of the LIBRARY-wide review credential: the code someone
       was read out, or the key the launcher printed. Deliberately not
       confined to one document — the operator set it before any document
       existed and the launcher says as much when it prints it. */
    if (REVIEW_ACTIVE && ((REVIEW_PIN && sameSecret(body && body.pin, REVIEW_PIN)) ||
                          (REVIEW_KEY && sameSecret(body && body.key, REVIEW_KEY)))) {
      pinFailures.delete(ip);
      return sendJson(res, 200, { token: REVIEW_TOKEN, role: "review" });
    }
    noteFailure(ip);
    return sendJson(res, 401, { error: "bad-pin" });
  }

  /* The launcher's own routes carry their own key and their own refusals
     (loopback only, launch token only), so they are settled before the PIN
     gate rather than behind it — a PIN is about sharing documents with
     people, and none of this is reachable by anyone but the launcher that
     started this process. See invariant #28. */
  if (parts[1] === "launcher") return handleLauncher(req, res, parts);

  /* Presence, before the gate only because it carries its own copy of it.
     One case forces that: the "I'm gone" beacon a closing tab sends.
     navigator.sendBeacon cannot set a header, so there the token arrives in
     the body instead — the same credential in a different envelope, and it
     is still gated on that credential whichever way it arrives. No token is
     still no presence, in either envelope.

     Both roles are here: a review viewer (#30) is someone else in the
     document and shows up like anybody else.

     It reads one thing off the disk, added by #69: the document's rev, from
     its head line, which is what makes this the pull channel as well as the
     listing (presenceRev above). It still WRITES nothing but the in-memory
     map, and presence is still never part of a document. */
  if (parts[1] === "presence" && req.method === "POST") {
    /* The header first, before a byte of the body is read: a caller who
       offered a token and got it wrong is refused here, not after 25 MB of
       whatever they were uploading has been buffered and parsed (#74). The
       beacon is why the body is still consulted at all, and a beacon sets no
       header — so the body is read with the small cap, which a heartbeat has
       never come close to. */
    const given = String(req.headers["x-splitpage-token"] || "");
    const headerRole = JOIN_PIN ? roleOfToken(given) : "edit";
    if (JOIN_PIN && given && !headerRole) return sendJson(res, 401, { error: "pin-required" });
    const body = await readBody(req, SMALL_BODY);
    const role = headerRole || (JOIN_PIN ? roleOfToken(body && body.token) : "edit");
    if (!role) return sendJson(res, 401, { error: "pin-required" });

    const docId = body && body.docId;
    const me = presenceHandle(body && body.id);
    if (!isValidId(docId) || !me) return sendJson(res, 400, { error: "bad-presence" });

    if (body && body.gone) {
      /* A tab that is going away. Answering with the listing would be
         pointless — it is not there to read it, and it has no use for a rev
         either, so this one branch never touches the disk. */
      sweepPresence(Date.now());
      const leaving = presenceByDoc.get(docId);
      if (leaving) {
        leaving.delete(me);
        if (!leaving.size) presenceByDoc.delete(docId);
      }
      return sendJson(res, 200, { ok: true });
    }

    /* Before the map is touched rather than in the middle of it: this is the
       one await in the route, and the sweep-then-mutate below has to stay
       one uninterrupted run or another beat's sweep can drop the entry this
       one is about to write into. */
    const rev = await presenceRev(docId);
    /* `docId` travels back with it so the other end can tell whether the
       answer is about the document it still has open — the picker is never
       disabled, so a beat sent for one document can land after another has
       been opened. Both of the "presence is full" answers below carry it
       too: being left out of the listing is no reason to lose the pull
       channel as well. */
    const answer = (here) => sendJson(res, 200, { docId, rev, here });

    const now = Date.now();
    sweepPresence(now);
    let people = presenceByDoc.get(docId);
    if (!people) {
      if (presenceByDoc.size >= PRESENCE_MAX_DOCS) return answer([]);
      people = new Map();
      presenceByDoc.set(docId, people);
    }
    if (people.size >= PRESENCE_MAX_PER_DOC && !people.has(me)) {
      return answer([]);
    }
    people.set(me, {
      name: presenceWord(body && body.name, 40),
      /* A row id is a document's own id for a scene, and it ends up in
         another browser's attribute selector — whitelisted, not sanitised,
         same reasoning as a document id. */
      rowId: presenceHandle(body && body.rowId),
      field: ["visualText", "audioText", "visualImage", "title"].indexOf(String(body && body.field)) === -1
        ? "" : String(body.field),
      at: now
    });
    const here = [];
    for (const [id, who] of people) {
      if (id === me) continue;
      here.push({ id, name: who.name, rowId: who.rowId, field: who.field });
    }
    return answer(here);
  }

  /* The gate. Everything below needs the token once a PIN is set — including
     /api/me, which is a name and an email address.

     It is here, above every route that reads a body, on purpose: a caller
     with no token is refused before readBody() allocates anything, so an
     unauthenticated 25 MB upload costs this process nothing but the headers
     it arrived with (#74). Nothing below may read a body before the check it
     is gated on. sendJson() ends the connection when the client is still
     sending, so the refusal is a clean 401 rather than a socket reset.

     JSON, deliberately: the client treats a non-JSON answer as a lapsed
     Cloudflare Access session and reloads the page to sign in again, which
     would be exactly the wrong move here. */
  const role = JOIN_PIN ? roleOf(req) : "edit";
  if (!role) {
    return sendJson(res, 401, { error: "pin-required" });
  }

  /* Where the client learns what it is allowed to do — from the token it
     already holds, on every load and every reconnect, rather than from
     anything it stored for itself. */
  if (parts[1] === "me" && req.method === "GET") {
    return sendJson(res, 200, Object.assign({ role }, who));
  }

  /* What the host needs to hand a review link out: the KEY that link
     carries, never the review PIN itself, and only to someone who is
     already an editor here — a reviewer asking has nothing to share and
     gets a refusal. It is answered over the API and never written into
     update-status.json, the document, or any file the static handler
     serves (invariant #29). */
  if (parts[1] === "share" && req.method === "GET") {
    if (role !== "edit") return sendJson(res, 403, { error: "review-only" });
    if (!REVIEW_ACTIVE) return sendJson(res, 200, { reviewAvailable: false, reviewKey: "", docId: "" });
    /* `?doc=<id>` asks for a link to THAT script, which is what the app
       offers and what a reader is being handed. Without one there is nothing
       to scope a link to, and the launch-wide credential is the operator's
       to hand out, not this route's — so it is refused rather than quietly
       answered with a key to the whole library (#63). */
    const wanted = url.searchParams.get("doc") || "";
    if (!isValidId(wanted)) return sendJson(res, 400, { error: "bad-id" });
    if (!(await readDoc(wanted))) return sendJson(res, 404, { error: "not-found" });
    const grant = reviewGrantFor(wanted);
    return sendJson(res, 200, {
      reviewAvailable: true,
      reviewKey: grant.key,
      docId: wanted
    });
  }

  /* Images (#82): after the gate, like everything that reads or writes. */
  if (parts[1] === "blobs") return handleBlobs(req, res, parts, role);

  if (parts[1] !== "docs") return sendJson(res, 404, { error: "not-found" });

  const id = parts[2];

  /* list */
  if (!id && req.method === "GET") {
    /* A review link names one document, so the picker it can list is that
       one document — not the library (#63). */
    const scope = role === "review" ? reviewScopeOf(req) : "";
    if (scope) {
      const only = await summaryOf(scope);
      return sendJson(res, 200, { docs: only ? [only] : [] });
    }
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
      /* The head line, not the whole script: a picker listing twenty
         documents used to parse twenty documents in full to print their
         names (#74). */
      const summary = await summaryOf(docId);
      if (summary) docs.push(summary);
    }
    docs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return sendJson(res, 200, { docs });
  }

  /* create */
  if (!id && req.method === "POST") {
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    if (role === "review") return sendJson(res, 403, { error: "review-only" });
    const body = await readBody(req);
    if (!body || typeof body.state !== "object" || body.state === null) {
      return sendJson(res, 400, { error: "bad-state" });
    }
    /* Every image the new document names must already be here (#82) — a
       new document has no stored refs to excuse a dangling one. */
    const createRefs = refsIn(body.state);
    const createMissing = await refusedRefs(createRefs, "", body.acceptMissing);
    if (createMissing.length) {
      return sendJson(res, 422, { error: "missing-blobs", missing: createMissing });
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
        await writeDoc(d, createRefs);
        return d;
      });
      if (wrote) { newId = candidate; doc = wrote; break; }
    }
    if (doc) touchBlobs(createRefs);
    if (!doc) return sendJson(res, 500, { error: "id-collision" });
    return sendJson(res, 201, { id: newId, rev: doc.rev, updatedAt: doc.updatedAt });
  }

  if (!isValidId(id)) return sendJson(res, 400, { error: "bad-id" });

  /* A per-document review link reaches that document and no other, on every
     method — reading one, commenting on one and deleting one were all gated
     on holding a token, not on which document the token was minted for
     (#63). The launch-wide review credential has no scope and is unchanged. */
  if (role === "review") {
    const scope = reviewScopeOf(req);
    if (scope && scope !== id) return sendJson(res, 403, { error: "wrong-document" });
  }

  /* ---------- comments, on their own (#71) ----------
   *
   *   POST  /api/docs/:id/comments            a new comment, or a reply
   *   PATCH /api/docs/:id/comments/:commentId resolve or unresolve one
   *
   * Above the read and save routes because `/api/docs/:id/comments` is a
   * longer path than `/api/docs/:id` and would otherwise be answered as a
   * GET of the document — the extra segment silently ignored.
   *
   * POST is open to both roles. An editor has PUT and does not need it, but
   * there is nothing there an editor may not do, and a route that refuses the
   * more privileged caller is a trap for whoever writes the client next.
   *
   * PATCH is an editor's only. Reviewers never resolve or unresolve a comment
   * (the owner's decision): this server cannot tell who wrote a comment — an
   * author is a name typed into a box, and every reviewer on a link shares
   * the one token — so there is no "their own comment" a reviewer could be
   * limited to, and a reviewer resolving anything would be resolving someone
   * else's. The client already offers them no Resolve; this is the same rule
   * held where a token alone cannot get round it.
   */
  if (parts[3] === "comments") {
    /* Nothing hangs off a comment: a reply is a POST to the collection
       carrying `replyTo`, not a path of its own. A deeper path is not a
       method this route lacks, it is a route that is not here. */
    if (parts.length > 5) return sendJson(res, 404, { error: "not-found" });
    const hasCid = parts[4] !== undefined;
    if (!((req.method === "POST" && !hasCid) || (req.method === "PATCH" && hasCid))) {
      return sendJson(res, 405, { error: "method-not-allowed" });
    }
    const cid = hasCid ? commentIdOf(parts[4]) : "";
    if (hasCid && !cid) return sendJson(res, 400, { error: "bad-comment-id" });
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    /* Refused on the role alone, before the body or the document is looked
       at: which comment, and which way, make no difference to the answer. */
    if (req.method === "PATCH" && role === "review") {
      return sendJson(res, 403, { error: "reviewers-cannot-resolve" });
    }

    /* Only now is a byte of the body read: the token was checked by the gate
       above, the review link's scope by the check above that, and the method,
       the path and the role by the lines above this one (#74). The cap is
       this route's own — a comment, not a script. */
    const body = await readBody(req, COMMENT_BODY);
    const now = new Date().toISOString();
    /* Cloudflare Access's word first, the client's claim second: the same
       order PUT uses for `updatedBy`, and for the same reason — one is an
       identity this process was handed and the other is a name in a box. */
    const by = who.name || commentText(body && body.by, COMMENT_NAME_MAX);

    if (req.method === "PATCH") {
      if (!body || typeof body.resolved !== "boolean") {
        return sendJson(res, 400, { error: "bad-resolve" });
      }
      const resolved = body.resolved;
      return withDocLock(id, async () => {
        const open = await openForComment(id);
        if (open.error) return sendJson(res, open.error.status, open.error.body);
        const comment = findComment(open.state, cid);
        if (!comment) return sendJson(res, 404, { error: "no-such-comment" });
        /* Already the way it is being asked for: answer with the document as
           it stands rather than writing a new rev that changes nothing. Two
           people clicking Resolve on the same card is one resolve. */
        if (comment.resolved === resolved) {
          return sendJson(res, 200, commentAnswer(id, open.doc, comment, { changed: false }));
        }
        comment.resolved = resolved;
        comment.updatedAt = now;
        /* Unresolving clears both fields, exactly as the client's
           toggleResolve does — a resolver's name next to a comment that is
           not resolved is worse than no name at all. */
        comment.resolvedBy = resolved ? (by || "Anonymous") : null;
        comment.resolvedAt = resolved ? now : null;
        const next = await writeCommentChange(id, open.doc, open.state, by, now);
        return sendJson(res, 200, commentAnswer(id, next, comment, { changed: true }));
      });
    }

    /* A reply to a comment that is already there. Distinguished by carrying
       `reply`, not by a route of its own: it is the same append, under the
       same lock, to the same document, and one route is one place to get
       that right. */
    if (body && body.reply !== undefined) {
      const parentId = commentIdOf(body.replyTo);
      const reply = cleanReply(body.reply, now, by);
      if (!parentId || !reply) return sendJson(res, 400, { error: "bad-comment" });
      const replyRefs = await commentRefsRefused(req, role, id, reply.body);
      if (replyRefs.missing.length) {
        return sendJson(res, 422, { error: "missing-blobs", missing: replyRefs.missing });
      }
      return withDocLock(id, async () => {
        const open = await openForComment(id);
        if (open.error) return sendJson(res, open.error.status, open.error.body);
        const parent = findComment(open.state, parentId);
        if (!parent) return sendJson(res, 404, { error: "no-such-comment" });
        if (!Array.isArray(parent.replies)) parent.replies = [];
        for (const r of parent.replies) {
          if (r && r.id === reply.id) {
            return sendJson(res, 200, commentAnswer(id, open.doc, parent, { changed: false }));
          }
        }
        if (parent.replies.length >= COMMENT_REPLIES_MAX) {
          return sendJson(res, 409, { error: "too-many-replies" });
        }
        parent.replies.push(reply);
        /* A thread's own timestamp moves when it is replied to, and only
           then. */
        parent.updatedAt = now;
        const next = await writeCommentChange(id, open.doc, open.state, by, now);
        touchBlobs(replyRefs.refs);
        return sendJson(res, 200, commentAnswer(id, next, parent, { changed: true, reply }));
      });
    }

    const comment = cleanComment(body && body.comment, now, by);
    if (!comment) return sendJson(res, 400, { error: "bad-comment" });
    /* Judged before the lock is taken: nonsense is nonsense whatever the
       document says, and there is no reason to queue behind a save to find
       out. Whether it is a REPEAT can only be judged inside. */
    if (body.anchor !== undefined && body.anchor !== null && typeof body.anchor !== "object") {
      return sendJson(res, 400, { error: "bad-anchor" });
    }
    /* The anchor's HTML needs no such check: placeAnchor() accepts it only
       when it matches the stored field tag for tag, images included, so it
       cannot bring a new ref in. */
    const commentRefs = await commentRefsRefused(req, role, id, comment.body);
    if (commentRefs.missing.length) {
      return sendJson(res, 422, { error: "missing-blobs", missing: commentRefs.missing });
    }
    return withDocLock(id, async () => {
      const open = await openForComment(id);
      if (open.error) return sendJson(res, open.error.status, open.error.body);
      const already = findComment(open.state, comment.id);
      if (already) {
        /* The same comment, posted twice: a client that never saw its
           answer. Hand back the one that is stored and the rev it is at.
           Not 409 — from where the client is standing this worked, and it
           did. */
        return sendJson(res, 200, commentAnswer(id, open.doc, already, { changed: false, anchored: false }));
      }
      if (open.state.comments.length >= DOC_COMMENTS_MAX) {
        return sendJson(res, 409, { error: "too-many-comments" });
      }
      const placed = placeAnchor(open.state, body.anchor, comment.id, comment.author, now);
      if (placed === "bad") return sendJson(res, 400, { error: "bad-anchor" });
      open.state.comments.push(comment);
      const next = await writeCommentChange(id, open.doc, open.state, by, now);
      touchBlobs(commentRefs.refs);
      return sendJson(res, 200, commentAnswer(id, next, comment, {
        changed: true,
        anchored: placed === "ok"
      }));
    });
  }

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
    /* A review token writes through the comment routes above and nowhere
       else (#71). Refused outright rather than judged: there is no longer
       any comparison here that could let one through, and refusing before
       readBody() means a reviewer cannot make this process buffer a 25 MB
       upload just to be told no (#74). */
    if (role === "review") return sendJson(res, 403, { error: "review-only" });
    /* D7 (#82): a client that predates blob references reads an `imageRef`
       as a key it does not know and a `data-blob` image as nothing at all,
       so its save of a document holding either would write back a script
       with its pictures gone from under it. Refused before the body, with a
       status that says what to do about it: reload. A document holding no
       refs is one an old client can still save, as it always could — and
       the rev compare-and-set below covers a document that gains refs
       between this check and the write, because the old client's baseRev
       is then stale and it gets a 409. */
    if (!clientKnowsBlobs(req)) {
      const held = await storedRefsOf(id);
      if (held && held.size) return sendJson(res, 426, { error: "client-too-old" });
    }
    const body = await readBody(req);
    if (!body || typeof body.state !== "object" || body.state === null) {
      return sendJson(res, 400, { error: "bad-state" });
    }
    const putRefs = refsIn(body.state);
    const baseRev = Number(body.baseRev);
    if (!isFinite(baseRev) || baseRev < 0) return sendJson(res, 400, { error: "bad-base-rev" });

    return withDocLock(id, async () => {
      /* The rev this is compared against, from the head line — the usual
         answer to a save is "yes, written", and answering it used to mean
         parsing the stored script in full to read one number off the front
         of it (#74). The whole file is still read for the one case that
         genuinely needs the state: a conflict, which hands it back to be
         merged. */
      const meta = await readDocMeta(id);
      if (!meta) return sendJson(res, 404, { error: "not-found" });

      /* Somebody else saved since this client loaded. Hand back their whole
         version so the client can three-way merge it against the base it
         still holds, rather than either side losing work. */
      if ((meta.rev || 0) !== baseRev) {
        const current = await readDoc(id);
        if (!current) return sendJson(res, 404, { error: "not-found" });
        return sendJson(res, 409, {
          error: "conflict",
          rev: current.rev || 0,
          state: current.state,
          updatedAt: current.updatedAt || null,
          updatedBy: current.updatedBy || null
        });
      }

      /* After the rev check — a stale client has to merge before anything
         else it is told matters — and before a byte is written: an image
         this save names that is new to this document and not on this
         server is refused, and the client uploads it and asks again (#82). */
      const missing = await refusedRefs(putRefs, id, body.acceptMissing);
      if (missing.length) return sendJson(res, 422, { error: "missing-blobs", missing });

      const doc = {
        id,
        rev: (meta.rev || 0) + 1,
        state: body.state,
        updatedAt: new Date().toISOString(),
        updatedBy: who.name || body.by || meta.updatedBy || null
      };
      await writeDoc(doc, putRefs);
      touchBlobs(putRefs);
      return sendJson(res, 200, { id, rev: doc.rev, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy });
    });
  }

  if (req.method === "DELETE") {
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    if (role === "review") return sendJson(res, 403, { error: "review-only" });
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
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": cache
  };
  /* index.html carries its own Content-Security-Policy in a <meta>, written
     by build.mjs (#65). frame-ancestors is the one directive a meta policy
     cannot express — browsers ignore it there — so it is sent as a header
     here, where it works: a hosted document is an editor, and an editor
     nobody else may frame is one nobody can click-jack. The rest of the
     policy stays in the page, so the two cannot drift. */
  if (ext === ".html") headers["Content-Security-Policy"] = "frame-ancestors 'self'";
  res.writeHead(200, headers);
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
     still answers: it is what lets the app the launcher just opened ask
     where it was started from. It is gated by the per-launch token and the
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
    if (TRUST_PROXY) {
      console.log("[splitpage] TRUST_PROXY=1 — the PIN rate limit counts X-Forwarded-For, so nothing " +
                  "but your proxy may be able to reach this port");
    }
    if (JOIN_PIN) {
      /* Never the PIN itself: this stream is inherited by the launcher and
         may end up in a log file. That it is set is all anyone needs here. */
      console.log("[splitpage] a join PIN is required — it travels in the clear, so keep this to your own network");
      if (REVIEW_ACTIVE) console.log("[splitpage] a review credential is set — it opens EVERY document here to read and comment on, nothing else. The link Splitpage itself offers is per-document.");
      else if (REVIEW_PIN || REVIEW_KEY) {
        console.log("[splitpage] the review credential was IGNORED — it is the same as the join PIN");
      }
    } else if (REVIEW_PIN || REVIEW_KEY) {
      console.log("[splitpage] the review credential was IGNORED — without a join PIN anyone who can reach this port is already an editor");
      console.log("[splitpage] no authentication in this process — put it behind Cloudflare Access or a VPN");
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
