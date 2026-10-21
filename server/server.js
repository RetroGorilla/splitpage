"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { codePointPrefix } = require("./text");
const blobs = require("./blobs");
const {
  COMMENT_NAME_MAX,
  DOC_COMMENTS_MAX,
  COMMENT_REPLIES_MAX,
  commentName,
  commentIdOf,
  cleanComment,
  cleanReply,
  placeAnchor
} = require("./comments");

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "..", "public");
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_BYTES || 8 * 1024 * 1024);
const REVIEW_BLOB_BUDGET = Number(process.env.REVIEW_BLOB_BUDGET_BYTES || 20 * 1024 * 1024);
const LINK_EDIT_BLOB_BUDGET = Number(process.env.LINK_EDIT_BLOB_BUDGET_BYTES || 100 * 1024 * 1024);
const READ_ONLY = process.env.READ_ONLY === "1";
const NO_API = process.env.NO_API === "1";

const JOIN_PIN = String(process.env.JOIN_PIN || "");
let ownerToken = crypto.randomBytes(32).toString("hex");
const OWNER_KEY_MIN = 20;

const REVIEW_PIN = String(process.env.REVIEW_PIN || "");
const REVIEW_KEY = String(process.env.REVIEW_KEY || "");
const REVIEW_ACTIVE = !!(JOIN_PIN && (REVIEW_PIN || REVIEW_KEY) && REVIEW_PIN !== JOIN_PIN);
const REVIEW_TOKEN = crypto.randomBytes(32).toString("hex");

const PERSIST_LINKS = process.env.PERSIST_LINKS === "1";
const LINKS_DIR = path.join(DATA_DIR, "links");
const LINKS_FILE = path.join(LINKS_DIR, "links.json");
const LINKS_SECRET_FILE = path.join(LINKS_DIR, "secret");
const LINK_ROLES = ["edit", "review"];
const LINK_ID_RE = /^[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const LINK_TOMBSTONE_MAX = 2000;

const linksById = new Map();
const linkByKey = new Map();
const linkByToken = new Map();
const linkByDocRole = new Map();
const linkTombstones = [];
const tombKeyHashes = new Set();
const tombTokenHashes = new Set();

function docRoleKey(docId, role) {
  return docId + "/" + role;
}

function indexLink(rec) {
  linksById.set(rec.id, rec);
  linkByKey.set(rec.key, rec);
  linkByToken.set(rec.token, rec);
  linkByDocRole.set(docRoleKey(rec.docId, rec.role), rec);
}

function unindexLink(rec) {
  linksById.delete(rec.id);
  linkByKey.delete(rec.key);
  linkByToken.delete(rec.token);
  const slot = docRoleKey(rec.docId, rec.role);
  if (linkByDocRole.get(slot) === rec) linkByDocRole.delete(slot);
}

function addTombstone(tomb) {
  linkTombstones.push(tomb);
  tombKeyHashes.add(tomb.keyHash);
  tombTokenHashes.add(tomb.tokenHash);
  while (linkTombstones.length > LINK_TOMBSTONE_MAX) {
    const oldest = linkTombstones.shift();
    tombKeyHashes.delete(oldest.keyHash);
    tombTokenHashes.delete(oldest.tokenHash);
  }
}

function activeLink(docId, role) {
  return linkByDocRole.get(docRoleKey(docId, role)) || null;
}

function mintLink(docId, role, createdBy) {
  let id;
  do { id = crypto.randomBytes(6).toString("hex"); } while (linksById.has(id));
  const rec = {
    id,
    key: crypto.randomBytes(24).toString("hex"),
    token: crypto.randomBytes(32).toString("hex"),
    docId,
    role,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || null
  };
  indexLink(rec);
  return rec;
}

function revokeLink(rec) {
  unindexLink(rec);
  addTombstone({
    id: rec.id,
    keyHash: sha256Of(rec.key),
    tokenHash: sha256Of(rec.token),
    docId: rec.docId,
    role: rec.role,
    revokedAt: new Date().toISOString()
  });
}

function linkAnswer(rec) {
  return { id: rec.id, role: rec.role, key: rec.key, createdAt: rec.createdAt };
}

let linksWriting = Promise.resolve();

function saveLinks() {
  if (!PERSIST_LINKS) return Promise.resolve();
  const write = () => writeFileDurable(LINKS_FILE, JSON.stringify({
    version: 1,
    links: Array.from(linksById.values()),
    revoked: linkTombstones
  }, null, 2) + "\n", 0o600);
  const next = linksWriting.then(write, write);
  linksWriting = next.catch(() => {});
  return next;
}

async function linkFor(docId, role, opts) {
  const existing = activeLink(docId, role);
  if (existing && !(opts && opts.replace)) return { link: existing, created: false };
  if (existing) revokeLink(existing);
  const rec = mintLink(docId, role, opts && opts.by);
  try {
    await saveLinks();
  } catch (err) {
    unindexLink(rec);
    throw err;
  }
  return { link: rec, created: true };
}

function revokeLinksOf(docId) {
  let n = 0;
  for (const role of LINK_ROLES) {
    const rec = activeLink(docId, role);
    if (rec) { revokeLink(rec); n++; }
  }
  return n;
}

function cleanLinkRecord(r) {
  if (!r || typeof r !== "object") return null;
  if (!LINK_ID_RE.test(String(r.id)) || !isValidId(r.docId) || LINK_ROLES.indexOf(r.role) === -1) return null;
  if (typeof r.key !== "string" || !/^[0-9a-f]{48,128}$/.test(r.key)) return null;
  if (typeof r.token !== "string" || !/^[0-9a-f]{64}$/.test(r.token)) return null;
  return {
    id: r.id, key: r.key, token: r.token, docId: r.docId, role: r.role,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
    createdBy: typeof r.createdBy === "string" ? r.createdBy : null
  };
}

function cleanTombstone(t) {
  if (!t || typeof t !== "object") return null;
  if (!SHA_RE.test(String(t.keyHash)) || !SHA_RE.test(String(t.tokenHash))) return null;
  return {
    id: String(t.id || ""), keyHash: t.keyHash, tokenHash: t.tokenHash,
    docId: String(t.docId || ""), role: String(t.role || ""),
    revokedAt: typeof t.revokedAt === "string" ? t.revokedAt : null
  };
}

async function loadLinkStore() {
  await fsp.mkdir(LINKS_DIR, { recursive: true, mode: 0o700 });
  await fsp.chmod(LINKS_DIR, 0o700).catch(() => {});

  let secret;
  try {
    secret = (await fsp.readFile(LINKS_SECRET_FILE, "utf8")).trim();
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
    secret = crypto.randomBytes(32).toString("hex");
    await writeFileDurable(LINKS_SECRET_FILE, secret + "\n", 0o600);
  }
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error(LINKS_SECRET_FILE + " is not 64 hex characters. Restore it from a backup, " +
                    "or delete it to start a new one (which signs every owner device out).");
  }
  await fsp.chmod(LINKS_SECRET_FILE, 0o600).catch(() => {});
  ownerToken = crypto.createHmac("sha256", Buffer.from(secret, "hex"))
    .update("owner\0" + JOIN_PIN).digest("hex");

  let raw = null;
  try {
    raw = await fsp.readFile(LINKS_FILE, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  if (raw === null) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(LINKS_FILE + " is not valid JSON. Restore it from a backup, or move it " +
                    "aside to start with no links (every link handed out stops working).", { cause: err });
  }
  await fsp.chmod(LINKS_FILE, 0o600).catch(() => {});
  let skipped = 0;
  for (const t of (data && Array.isArray(data.revoked)) ? data.revoked : []) {
    const tomb = cleanTombstone(t);
    if (tomb) addTombstone(tomb); else skipped++;
  }
  for (const r of (data && Array.isArray(data.links)) ? data.links : []) {
    const rec = cleanLinkRecord(r);
    if (!rec || linksById.has(rec.id) || linkByKey.has(rec.key) || linkByToken.has(rec.token) ||
        activeLink(rec.docId, rec.role) || tombKeyHashes.has(sha256Of(rec.key))) {
      skipped++;
      continue;
    }
    indexLink(rec);
  }
  if (skipped) console.warn("[splitpage] " + skipped + " unreadable entr" + (skipped === 1 ? "y" : "ies") +
                            " in " + LINKS_FILE + " were ignored");
}

const ALLOW_ORIGINS = String(process.env.ALLOW_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .filter((o) => {
    if (o !== "null") return true;
    console.warn("[splitpage] ALLOW_ORIGINS=null is ignored — `null` is the origin every " +
                 "sandboxed iframe sends, not one site. Name the origin the copy is served from.");
    return false;
  });

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

function identityOf(req) {
  const email = String(req.headers["cf-access-authenticated-user-email"] || "").trim();
  if (!email || email.length > 200 || !email.includes("@")) return { email: null, name: null };
  const name = email.split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { email, name: name || null };
}

function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given == null ? "" : given)).digest();
  const b = crypto.createHash("sha256").update(String(expected == null ? "" : expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

const PIN_WINDOW_MS = 60 * 1000;
const PIN_MAX_FAILURES = 10;
const pinFailures = new Map();

const TRUST_PROXY_MODE = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
const TRUST_PROXY = TRUST_PROXY_MODE === "1";
const TRUST_CLOUDFLARE = TRUST_PROXY_MODE === "cloudflare";
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

function forwardedIp(req) {
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : String(header || "");
  const first = raw.split(",")[0].trim().replace(/^\[|\]$/g, "");
  return IP_RE.test(first) ? first : "";
}

function cloudflareIp(req) {
  const raw = String(req.headers["cf-connecting-ip"] || "").trim().replace(/^\[|\]$/g, "");
  return IP_RE.test(raw) ? raw : "";
}

function clientIp(req) {
  if (TRUST_CLOUDFLARE) {
    const connecting = cloudflareIp(req);
    if (connecting) return connecting;
  } else if (TRUST_PROXY) {
    const forwarded = forwardedIp(req);
    if (forwarded) return forwarded;
  }
  return String((req.socket && req.socket.remoteAddress) || "unknown");
}

function recentFailures(ip) {
  const now = Date.now();
  const list = (pinFailures.get(ip) || []).filter((t) => now - t < PIN_WINDOW_MS);
  if (list.length) pinFailures.set(ip, list); else pinFailures.delete(ip);
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
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionOfToken(given) {
  const token = String(given == null ? "" : given);
  if (!token) return null;
  if (sameToken(token, ownerToken)) return { role: "edit", scope: "", token };
  if (REVIEW_ACTIVE && sameToken(token, REVIEW_TOKEN)) return { role: "review", scope: "", token };
  const link = linkByToken.get(token);
  if (link) return { role: link.role, scope: link.docId, token };
  if (tombTokenHashes.size && tombTokenHashes.has(sha256Of(token))) return { revoked: true };
  return null;
}

const OPEN_SESSION = Object.freeze({ role: "edit", scope: "", token: "" });

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || ALLOW_ORIGINS.indexOf(origin) === -1) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "content-type, x-splitpage-token, x-splitpage-launch, x-splitpage-client",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  };
}

const VERSION = (() => {
  if (process.env.SPLITPAGE_VERSION) return String(process.env.SPLITPAGE_VERSION).trim();
  for (const dir of [STATIC_DIR, path.join(STATIC_DIR, ".."), path.join(__dirname, "..")]) {
    try {
      const v = fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim();
      if (v) return v;
    } catch (e) { }
  }
  return null;
})();

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

const writeChains = new Map();

function withDocLock(id, fn) {
  const prev = writeChains.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(() => {}, () => {});
  writeChains.set(id, settled);
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

const DOC_HEAD_MAX = 8192;

const HEAD_TITLE_MAX = 512;

function isDocState(state) {
  return !!state && typeof state === "object" && !Array.isArray(state);
}

function headOf(doc) {
  const head = {};
  for (const key of Object.keys(doc)) {
    if (key !== "state") head[key] = doc[key];
  }
  const state = doc.state || {};
  head.title = codePointPrefix(String(state.title || "Untitled Script"), HEAD_TITLE_MAX);
  head.rows = Array.isArray(state.rows) ? state.rows.length : 0;
  return head;
}

function encodeDoc(doc) {
  const head = JSON.stringify(headOf(doc));
  return head.slice(0, -1) + ",\n\"state\":" + JSON.stringify(doc.state) + "}";
}

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
    const line = text.slice(0, end).replace(/,$/, "") + "}";
    const head = JSON.parse(line);
    if (!head || typeof head !== "object" || typeof head.rev !== "number") return null;
    return head;
  } catch (err) {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readDocMeta(id) {
  const head = await readDocHead(id);
  if (head) return head;
  const doc = await readDoc(id);
  return doc ? headOf(doc) : null;
}

async function syncDir(dir) {
  let handle;
  try {
    handle = await fsp.open(dir, "r");
    await handle.sync();
  } catch (err) {
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function writeFileDurable(target, data, mode) {
  const tmp = target + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    let handle;
    try {
      handle = await fsp.open(tmp, "w", mode === undefined ? 0o666 : mode);
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
  noteRefs(doc.id, doc.rev || 0, refs || blobs.refsIn(doc.state));
}

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
    "Cache-Control": "no-store"
  };
  if (stillUploading(res.req) || (opts && opts.close)) headers["Connection"] = "close";
  if (res.corsHeaders) Object.assign(headers, res.corsHeaders);
  res.writeHead(status, headers);
  res.end(payload);
}

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

const headUpgraded = new Set();

async function summaryOf(id) {
  const head = await readDocHead(id).catch(() => null);
  if (head) return summarise(head);
  const doc = await readDoc(id).catch(() => null);
  if (!doc) return null;
  if (!READ_ONLY && !headUpgraded.has(id)) {
    headUpgraded.add(id);
    withDocLock(id, async () => {
      if (await readDocHead(id)) return;
      const current = await readDoc(id);
      if (current && current.id === id) await writeDoc(current);
    }).catch(() => { });
  }
  return summarise(headOf(doc));
}

function launcherAllowed(req) {
  if (!LAUNCH_TOKEN || HOST !== "127.0.0.1") return false;
  return sameToken(String(req.headers["x-splitpage-launch"] || ""), LAUNCH_TOKEN);
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

const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS || 15000);
const PRESENCE_MAX_PER_DOC = 50;
const PRESENCE_MAX_DOCS = 200;
const presenceByDoc = new Map();

function sweepPresence(now) {
  for (const [docId, people] of presenceByDoc) {
    for (const [id, who] of people) {
      if (now - who.at > PRESENCE_TTL_MS) people.delete(id);
    }
    if (!people.size) presenceByDoc.delete(docId);
  }
}

function presenceWord(value, max) {
  /* eslint-disable-next-line no-control-regex -- stripping them is the job. */
  const text = String(value == null ? "" : value).replace(/[\x00-\x1f\x7f]/g, "").replace(/\p{Cs}/gu, "").trim();
  return codePointPrefix(text, max).trimEnd();
}

function presenceColor(value) {
  const v = String(value == null ? "" : value);
  return /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : "";
}

function presenceHandle(value) {
  const v = String(value == null ? "" : value);
  return /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : "";
}

async function presenceRev(docId) {
  try {
    const head = await readDocHead(docId);
    return head && typeof head.rev === "number" ? head.rev : null;
  } catch (err) {
    return null;
  }
}

const COMMENT_BODY = 512 * 1024;
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

async function openForComment(id) {
  const doc = await readDoc(id);
  if (!doc) return { error: { status: 404, body: { error: "not-found" } } };
  const state = doc.state;
  if (!isDocState(state)) {
    return { error: { status: 409, body: { error: "no-state" } } };
  }
  if (!Array.isArray(state.comments)) state.comments = [];
  return { doc, state };
}

function findComment(state, cid) {
  for (const c of state.comments) if (c && typeof c === "object" && c.id === cid) return c;
  return null;
}

function commentAnswer(id, doc, comment, extra) {
  return Object.assign({
    id,
    rev: doc.rev || 0,
    updatedAt: doc.updatedAt || null,
    updatedBy: doc.updatedBy || null,
    comment
  }, extra || {});
}

const BLOBS_DIR = path.join(DATA_DIR, "blobs");
const CLIENT_BLOBS = 2;
const MISSING_BODY = 256 * 1024;
const MISSING_MAX = 2000;

function blobPath(sha) {
  return path.join(BLOBS_DIR, sha.slice(0, 2), sha);
}

function sha256Of(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const refsCache = new Map();
const REFS_CACHE_MAX = 200;

function noteRefs(id, rev, refs) {
  refsCache.delete(id);
  if (refsCache.size >= REFS_CACHE_MAX) refsCache.delete(refsCache.keys().next().value);
  refsCache.set(id, { rev, refs });
}

async function storedRefsOf(id) {
  const meta = await readDocMeta(id);
  if (!meta) return null;
  const rev = meta.rev || 0;
  const hit = refsCache.get(id);
  if (hit && hit.rev === rev) return hit.refs;
  const doc = await readDoc(id);
  if (!doc) return null;
  const refs = blobs.refsIn(doc.state);
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

function touchBlobs(shas) {
  const now = new Date();
  for (const sha of shas) fsp.utimes(blobPath(sha), now, now).catch(() => {});
}

async function writeBlob(sha, buf) {
  const dir = path.dirname(blobPath(sha));
  const created = await fsp.mkdir(dir, { recursive: true });
  if (created) {
    await syncDir(BLOBS_DIR);
    await syncDir(DATA_DIR);
  }
  await writeFileDurable(blobPath(sha), buf);
}

function commentRefsRefused(session, docId, html) {
  return blobs.commentRefsRefused(html, {
    visibility: () => blobVisibility(session),
    hasBlob,
    storedRefs: () => storedRefsOf(docId)
  });
}

function clientKnowsBlobs(req) {
  const v = parseInt(String(req.headers["x-splitpage-client"] || ""), 10);
  return isFinite(v) && v >= CLIENT_BLOBS;
}

const blobBudgets = blobs.createBlobBudgets({
  reviewBudget: REVIEW_BLOB_BUDGET,
  linkEditBudget: LINK_EDIT_BLOB_BUDGET,
  maxBlobBytes: MAX_BLOB_BYTES
});

async function blobVisibility(session) {
  if (!session || !session.scope) return null;
  const refs = (await storedRefsOf(session.scope)) || new Set();
  return blobBudgets.visibleTo(session, refs);
}

async function handleBlobs(req, res, parts, session) {
  if (parts[2] === "missing" && parts.length === 3) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
    const body = await readBody(req, MISSING_BODY);
    const shas = body && body.shas;
    if (!Array.isArray(shas) || shas.length > MISSING_MAX || !shas.every(blobs.isSha)) {
      return sendJson(res, 400, { error: "bad-shas" });
    }
    const unique = Array.from(new Set(shas));
    const visible = await blobVisibility(session);
    const missing = await blobs.unavailableBlobs(unique, visible, hasBlob);
    return sendJson(res, 200, { missing });
  }

  if (parts.length !== 3) return sendJson(res, 404, { error: "not-found" });
  const sha = parts[2];

  if (req.method === "GET") {
    if (!blobs.isSha(sha)) return sendJson(res, 400, { error: "bad-sha" });
    const visible = await blobVisibility(session);
    if (visible && !visible(sha)) return sendJson(res, 404, { error: "not-found" });
    let buf;
    try {
      buf = await fsp.readFile(blobPath(sha));
    } catch (err) {
      if (err && err.code === "ENOENT") return sendJson(res, 404, { error: "not-found" });
      throw err;
    }
    const mime = blobs.sniffImageMime(buf);
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
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    if (!blobs.isSha(sha)) return sendJson(res, 400, { error: "bad-sha" });
    const declared = req.headers["content-length"] !== undefined
      ? Number(req.headers["content-length"]) : NaN;
    if (isFinite(declared) && declared > MAX_BLOB_BYTES) {
      return sendJson(res, 413, { error: "too-large" });
    }
    const hold = blobBudgets.reserve(session, declared);
    if (hold.refused) return sendJson(res, 429, { error: "review-budget" });
    try {
      const buf = await readRawBody(req, MAX_BLOB_BYTES);
      if (sha256Of(buf) !== sha) return sendJson(res, 400, { error: "hash-mismatch" });
      if (!blobs.sniffImageMime(buf)) return sendJson(res, 415, { error: "unsupported-type" });
      const visible = await blobVisibility(session);
      const truthful = !visible || visible(sha);
      let present = false;
      if (await hasBlob(sha)) {
        present = sha256Of(await fsp.readFile(blobPath(sha)).catch(() => Buffer.alloc(0))) === sha;
      }
      if (present) touchBlobs([sha]);
      else await writeBlob(sha, buf);
      if (!(present && truthful)) hold.settle(sha, buf.length);
      if (present && truthful) return sendJson(res, 200, { stored: false });
      return sendJson(res, 201, { stored: true });
    } finally {
      hold.release();
    }
  }

  return sendJson(res, 405, { error: "method-not-allowed" });
}

async function handleLinks(req, res, parts, id, session, who) {
  if (parts.length > 5) return sendJson(res, 404, { error: "not-found" });
  const linkId = parts[4];
  const allowed = linkId === undefined
    ? (req.method === "GET" || req.method === "POST")
    : req.method === "DELETE";
  if (!allowed) return sendJson(res, 405, { error: "method-not-allowed" });
  if (session.scope || session.role !== "edit") return sendJson(res, 403, { error: "owner-only" });
  if (!JOIN_PIN) return sendJson(res, 409, { error: "no-pin" });

  if (req.method === "GET") {
    const links = [];
    for (const role of LINK_ROLES) {
      const rec = activeLink(id, role);
      if (rec) links.push(linkAnswer(rec));
    }
    return sendJson(res, 200, { links });
  }

  if (req.method === "POST") {
    const body = await readBody(req, SMALL_BODY);
    const role = body && body.role;
    if (LINK_ROLES.indexOf(role) === -1) return sendJson(res, 400, { error: "bad-role" });
    if (READ_ONLY && role === "edit") return sendJson(res, 403, { error: "read-only" });
    return withDocLock(id, async () => {
      if (!(await readDocMeta(id))) return sendJson(res, 404, { error: "not-found" });
      const { link, created } = await linkFor(id, role, { replace: body.replace === true, by: who.name });
      return sendJson(res, created ? 201 : 200, linkAnswer(link));
    });
  }

  const rec = LINK_ID_RE.test(linkId) ? linksById.get(linkId) : null;
  if (!rec || rec.docId !== id) return sendJson(res, 404, { error: "no-such-link" });
  revokeLink(rec);
  await saveLinks();
  return sendJson(res, 200, { ok: true });
}

async function handleApi(req, res, url) {
  const who = identityOf(req);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[1] === "health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      mode: "server",
      readOnly: READ_ONLY,
      authRequired: !!JOIN_PIN,
      reviewAvailable: !!JOIN_PIN,
      links: 1,
      linksPersist: PERSIST_LINKS,
      blobs: 1,
      version: VERSION
    });
  }

  if (parts[1] === "join" && req.method === "POST") {
    if (!JOIN_PIN) return sendJson(res, 200, { token: ownerToken, role: "edit", open: true });
    const ip = clientIp(req);
    if (recentFailures(ip).length >= PIN_MAX_FAILURES) {
      return sendJson(res, 429, { error: "too-many-attempts" });
    }
    const body = await readBody(req, SMALL_BODY);
    if (sameSecret(body && body.pin, JOIN_PIN)) {
      pinFailures.delete(ip);
      return sendJson(res, 200, { token: ownerToken, role: "edit" });
    }
    const key = body && typeof body.key === "string" ? body.key : "";
    const link = key ? linkByKey.get(key) : null;
    if (link) {
      return sendJson(res, 200, { token: link.token, role: link.role, docId: link.docId, scope: link.docId });
    }
    if (key && tombKeyHashes.has(sha256Of(key))) {
      return sendJson(res, 410, { error: "link-off" });
    }
    if (REVIEW_ACTIVE && ((REVIEW_PIN && sameSecret(body && body.pin, REVIEW_PIN)) ||
                          (REVIEW_KEY && sameSecret(body && body.key, REVIEW_KEY)))) {
      return sendJson(res, 200, { token: REVIEW_TOKEN, role: "review" });
    }
    noteFailure(ip);
    return sendJson(res, 401, { error: "bad-pin" });
  }

  if (parts[1] === "launcher") return handleLauncher(req, res, parts);

  if (parts[1] === "presence" && req.method === "POST") {
    const given = String(req.headers["x-splitpage-token"] || "");
    const fromHeader = JOIN_PIN ? sessionOfToken(given) : OPEN_SESSION;
    if (fromHeader && fromHeader.revoked) return sendJson(res, 401, { error: "link-off" });
    if (JOIN_PIN && given && !fromHeader) return sendJson(res, 401, { error: "pin-required" });
    const body = await readBody(req, SMALL_BODY);
    const session = fromHeader || sessionOfToken(body && body.token);
    if (session && session.revoked) return sendJson(res, 401, { error: "link-off" });
    if (!session) return sendJson(res, 401, { error: "pin-required" });

    const docId = body && body.docId;
    const me = presenceHandle(body && body.id);
    if (!isValidId(docId) || !me) return sendJson(res, 400, { error: "bad-presence" });
    if (session.scope && session.scope !== docId) return sendJson(res, 403, { error: "wrong-document" });

    if (body && body.gone) {
      sweepPresence(Date.now());
      const leaving = presenceByDoc.get(docId);
      if (leaving) {
        leaving.delete(me);
        if (!leaving.size) presenceByDoc.delete(docId);
      }
      return sendJson(res, 200, { ok: true });
    }

    const rev = await presenceRev(docId);
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
      rowId: presenceHandle(body && body.rowId),
      field: ["visualText", "audioText", "visualImage", "title"].indexOf(String(body && body.field)) === -1
        ? "" : String(body.field),
      color: presenceColor(body && body.color),
      at: now
    });
    const here = [];
    for (const [id, who] of people) {
      if (id === me) continue;
      const entry = { id, name: who.name, rowId: who.rowId, field: who.field };
      if (who.color) entry.color = who.color;
      here.push(entry);
    }
    return answer(here);
  }

  const session = JOIN_PIN ? sessionOfToken(req.headers["x-splitpage-token"] || "") : OPEN_SESSION;
  if (session && session.revoked) return sendJson(res, 401, { error: "link-off" });
  if (!session) {
    return sendJson(res, 401, { error: "pin-required" });
  }
  const role = session.role;
  const scope = session.scope;

  if (parts[1] === "me" && req.method === "GET") {
    return sendJson(res, 200, Object.assign({ role, scope }, who));
  }

  if (parts[1] === "share" && req.method === "GET") {
    if (scope) return sendJson(res, 403, { error: "owner-only" });
    if (role !== "edit") return sendJson(res, 403, { error: "review-only" });
    if (!JOIN_PIN) return sendJson(res, 200, { reviewAvailable: false, reviewKey: "", docId: "" });
    const wanted = url.searchParams.get("doc") || "";
    if (!isValidId(wanted)) return sendJson(res, 400, { error: "bad-id" });
    return withDocLock(wanted, async () => {
      if (!(await readDocMeta(wanted))) return sendJson(res, 404, { error: "not-found" });
      const { link } = await linkFor(wanted, "review", { by: who.name });
      return sendJson(res, 200, {
        reviewAvailable: true,
        reviewKey: link.key,
        docId: wanted
      });
    });
  }

  if (parts[1] === "blobs") return handleBlobs(req, res, parts, session);

  if (parts[1] !== "docs") return sendJson(res, 404, { error: "not-found" });

  const id = parts[2];

  if (!id && req.method === "GET") {
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
      if (!isValidId(docId)) continue;
      const summary = await summaryOf(docId);
      if (summary) docs.push(summary);
    }
    docs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return sendJson(res, 200, { docs });
  }

  if (!id && req.method === "POST") {
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    if (role === "review") return sendJson(res, 403, { error: "review-only" });
    if (scope) return sendJson(res, 403, { error: "owner-only" });
    const body = await readBody(req);
    if (!body || !isDocState(body.state)) {
      return sendJson(res, 400, { error: "bad-state" });
    }
    const createRefs = blobs.refsIn(body.state);
    const createMissing = await blobs.refusedRefs(createRefs, { hasBlob, acceptMissing: body.acceptMissing });
    if (createMissing.length) {
      return sendJson(res, 422, { error: "missing-blobs", missing: createMissing });
    }
    let newId, doc;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = slugify(body.state.title || body.title);
      const wrote = await withDocLock(candidate, async () => {
        if (await readDoc(candidate)) return null;
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

  if (parts.length > 3 && parts[3] !== "comments" && parts[3] !== "links") {
    return sendJson(res, 404, { error: "not-found" });
  }

  if (scope && req.method === "DELETE" && parts.length === 3) {
    return sendJson(res, 403, { error: "owner-only" });
  }

  if (scope && scope !== id) return sendJson(res, 403, { error: "wrong-document" });

  if (parts[3] === "links") return handleLinks(req, res, parts, id, session, who);

  if (parts[3] === "comments") {
    if (parts.length > 5) return sendJson(res, 404, { error: "not-found" });
    const hasCid = parts[4] !== undefined;
    if (!((req.method === "POST" && !hasCid) || (req.method === "PATCH" && hasCid))) {
      return sendJson(res, 405, { error: "method-not-allowed" });
    }
    const cid = hasCid ? commentIdOf(parts[4]) : "";
    if (hasCid && !cid) return sendJson(res, 400, { error: "bad-comment-id" });
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    if (req.method === "PATCH" && role === "review") {
      return sendJson(res, 403, { error: "reviewers-cannot-resolve" });
    }

    const body = await readBody(req, COMMENT_BODY);
    const now = new Date().toISOString();
    const by = who.name || commentName(body && body.by, COMMENT_NAME_MAX);

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
        if (comment.resolved === resolved) {
          return sendJson(res, 200, commentAnswer(id, open.doc, comment, { changed: false }));
        }
        comment.resolved = resolved;
        comment.updatedAt = now;
        comment.resolvedBy = resolved ? (by || "Anonymous") : null;
        comment.resolvedAt = resolved ? now : null;
        const next = await writeCommentChange(id, open.doc, open.state, by, now);
        return sendJson(res, 200, commentAnswer(id, next, comment, { changed: true }));
      });
    }

    if (body && body.reply !== undefined) {
      const parentId = commentIdOf(body.replyTo);
      const reply = cleanReply(body.reply, now, by);
      if (!parentId || !reply) return sendJson(res, 400, { error: "bad-comment" });
      const replyRefs = await commentRefsRefused(session, id, reply.body);
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
        parent.updatedAt = now;
        const next = await writeCommentChange(id, open.doc, open.state, by, now);
        touchBlobs(replyRefs.refs);
        return sendJson(res, 200, commentAnswer(id, next, parent, { changed: true, reply }));
      });
    }

    const comment = cleanComment(body && body.comment, now, by);
    if (!comment) return sendJson(res, 400, { error: "bad-comment" });
    if (body.anchor !== undefined && body.anchor !== null && typeof body.anchor !== "object") {
      return sendJson(res, 400, { error: "bad-anchor" });
    }
    const commentRefs = await commentRefsRefused(session, id, comment.body);
    if (commentRefs.missing.length) {
      return sendJson(res, 422, { error: "missing-blobs", missing: commentRefs.missing });
    }
    return withDocLock(id, async () => {
      const open = await openForComment(id);
      if (open.error) return sendJson(res, open.error.status, open.error.body);
      const already = findComment(open.state, comment.id);
      if (already) {
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

  if (req.method === "GET") {
    const doc = await readDoc(id);
    if (!doc) return sendJson(res, 404, { error: "not-found" });
    return sendJson(res, 200, {
      id: doc.id, rev: doc.rev || 0, state: doc.state,
      updatedAt: doc.updatedAt || null, updatedBy: doc.updatedBy || null
    });
  }

  if (req.method === "PUT") {
    if (READ_ONLY) return sendJson(res, 403, { error: "read-only" });
    if (role === "review") return sendJson(res, 403, { error: "review-only" });
    if (!clientKnowsBlobs(req)) {
      const held = await storedRefsOf(id);
      if (held && held.size) return sendJson(res, 426, { error: "client-too-old" });
    }
    const body = await readBody(req);
    if (!body || !isDocState(body.state)) {
      return sendJson(res, 400, { error: "bad-state" });
    }
    const putRefs = blobs.refsIn(body.state);
    const baseRev = Number(body.baseRev);
    if (!isFinite(baseRev) || baseRev < 0) return sendJson(res, 400, { error: "bad-base-rev" });

    return withDocLock(id, async () => {
      const meta = await readDocMeta(id);
      if (!meta) return sendJson(res, 404, { error: "not-found" });

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

      const visible = putRefs.size ? await blobVisibility(session) : null;
      const missing = await blobs.refusedRefs(putRefs, {
        visible,
        hasBlob,
        acceptMissing: body.acceptMissing,
        storedRefs: () => storedRefsOf(id)
      });
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
      if (revokeLinksOf(id)) await saveLinks();
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

let dataDirReal = path.resolve(DATA_DIR);
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

function foldPath(p) {
  return FOLD_CASE ? p.toLowerCase() : p;
}

async function insideDataDir(full) {
  let real;
  try {
    real = await fsp.realpath(full);
  } catch (err) {
    real = full;
  }
  const f = foldPath(real);
  const d = foldPath(dataDirReal);
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

async function handleStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400).end();
    return;
  }
  if (rel === "/") rel = "/index.html";

  const full = path.resolve(path.join(STATIC_DIR, rel));
  const root = path.resolve(STATIC_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (path.relative(root, full).split(path.sep).some((seg) => seg.charAt(0) === ".")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  if (!stat.isFile() || await insideDataDir(full)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  const ext = path.extname(full).toLowerCase();
  const cache = (ext === ".html" || rel === "/sw.js")
    ? "no-cache"
    : "public, max-age=3600";
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": cache
  };
  if (ext === ".html") headers["Content-Security-Policy"] = "frame-ancestors 'self'";
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return; }
  const stream = fs.createReadStream(full);
  stream.on("error", (err) => {
    console.error("[splitpage] static read error for " + full + ": " + (err && err.message));
    res.destroy();
  });
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
    res.end("Bad request");
    return;
  }
  const isLauncher = url.pathname.startsWith("/api/launcher/");
  const isApi = (!NO_API || isLauncher) && url.pathname.startsWith("/api/");

  if (isApi) {
    const cors = corsHeaders(req);
    if (cors) res.corsHeaders = cors;
    if (req.method === "OPTIONS") {
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

server.on("error", (err) => {
  console.error("[splitpage] could not start on " + HOST + ":" + PORT + " — " +
    (err && err.message ? err.message : err));
  process.exit(1);
});

async function start() {
  if (!NO_API) await fsp.mkdir(DATA_DIR, { recursive: true });
  if (PERSIST_LINKS && !NO_API) await loadLinkStore();
  dataDirReal = await fsp.realpath(DATA_DIR).catch(() => path.resolve(DATA_DIR));
  server.listen(PORT, HOST, () => {
    console.log("[splitpage] listening on " + HOST + ":" + PORT);
    console.log("[splitpage] documents in " + DATA_DIR);
    console.log("[splitpage] static files from " + STATIC_DIR);
    if (READ_ONLY) console.log("[splitpage] READ-ONLY mode");
    if (NO_API) console.log("[splitpage] static only — no document API");
    if (ALLOW_ORIGINS.length) console.log("[splitpage] cross-origin calls allowed from: " + ALLOW_ORIGINS.join(", "));
    if (TRUST_PROXY) {
      console.log("[splitpage] TRUST_PROXY=1 — the PIN rate limit counts X-Forwarded-For, so nothing " +
                  "but your proxy may be able to reach this port. Behind Cloudflare use TRUST_PROXY=cloudflare: " +
                  "Cloudflare appends to a client's X-Forwarded-For, so its first entry is the caller's to choose");
    } else if (TRUST_CLOUDFLARE) {
      console.log("[splitpage] TRUST_PROXY=cloudflare — the PIN rate limit counts Cf-Connecting-Ip, so nothing " +
                  "but Cloudflare may be able to reach this port");
    } else if (TRUST_PROXY_MODE && TRUST_PROXY_MODE !== "0") {
      console.warn("[splitpage] TRUST_PROXY=" + TRUST_PROXY_MODE + " is not a setting this server knows " +
                   "(1 or cloudflare) — ignored; the PIN rate limit counts the socket");
    }
    if (PERSIST_LINKS && !NO_API) {
      console.log("[splitpage] PERSIST_LINKS=1 — invite links and the owner's sign-in survive a restart (" + LINKS_DIR + ")");
    }
    if (JOIN_PIN) {
      if (PERSIST_LINKS) {
        console.log("[splitpage] an owner key is required; guests come in on per-document links");
        if (JOIN_PIN.length < OWNER_KEY_MIN) {
          console.warn("[splitpage] WARNING: JOIN_PIN is shorter than " + OWNER_KEY_MIN + " characters on a server " +
                       "that keeps its sessions (PERSIST_LINKS=1), which means one meant to stay up on the " +
                       "internet. The rate limit slows a guesser down; it does not make a short code safe to " +
                       "expose. Set it to 32 or more random characters.");
        }
      } else {
        console.log("[splitpage] a join PIN is required — it travels in the clear, so keep this to your own network");
      }
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
