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
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_BYTES || 8 * 1024 * 1024);
const REVIEW_BLOB_BUDGET = Number(process.env.REVIEW_BLOB_BUDGET_BYTES || 20 * 1024 * 1024);
const REVIEW_BLOB_WINDOW_MS = 60 * 60 * 1000;
const READ_ONLY = process.env.READ_ONLY === "1";
const NO_API = process.env.NO_API === "1";

const JOIN_PIN = String(process.env.JOIN_PIN || "");
const SESSION_TOKEN = crypto.randomBytes(32).toString("hex");

const REVIEW_PIN = String(process.env.REVIEW_PIN || "");
const REVIEW_KEY = String(process.env.REVIEW_KEY || "");
const REVIEW_ACTIVE = !!(JOIN_PIN && (REVIEW_PIN || REVIEW_KEY) && REVIEW_PIN !== JOIN_PIN);
const REVIEW_TOKEN = crypto.randomBytes(32).toString("hex");

const reviewGrantsByDoc = new Map();
const reviewGrantsByKey = new Map();
const reviewScopeByToken = new Map();
const REVIEW_GRANT_MAX = 500;

function reviewGrantFor(docId) {
  let grant = reviewGrantsByDoc.get(docId);
  if (grant) return grant;
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

function reviewScopeOfToken(token) {
  return reviewScopeByToken.get(String(token || "")) || "";
}

function reviewScopeOf(req) {
  return reviewScopeOfToken(req.headers["x-splitpage-token"] || "");
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

const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

function forwardedIp(req) {
  const header = req.headers["x-forwarded-for"];
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
  if (given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function roleOfToken(given) {
  const token = String(given == null ? "" : given);
  if (sameToken(token, SESSION_TOKEN)) return "edit";
  if (REVIEW_ACTIVE && sameToken(token, REVIEW_TOKEN)) return "review";
  if (REVIEW_ACTIVE && reviewScopeByToken.has(token)) return "review";
  return null;
}

function roleOf(req) {
  return roleOfToken(req.headers["x-splitpage-token"] || "");
}

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
  noteRefs(doc.id, doc.rev || 0, refs || refsIn(doc.state));
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
  return String(value == null ? "" : value).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
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
const COMMENT_HTML_MAX = 256 * 1024;
const COMMENT_NAME_MAX = 80;
const COMMENT_QUOTE_MAX = 2000;
const DOC_COMMENTS_MAX = 2000;
const COMMENT_REPLIES_MAX = 500;

function commentText(value, max) {
  return String(value == null ? "" : value)
    .replace(/<[^>]*>/g, "")
    /* eslint-disable-next-line no-control-regex -- C0 controls, minus the
       tab/LF/CR a comment may legitimately contain, are what this strips. */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
}

function commentIdOf(value) {
  const id = String(value == null ? "" : value);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

function cleanComment(input, now, fallbackAuthor) {
  if (!input || typeof input !== "object") return null;
  const id = commentIdOf(input.id);
  if (!id) return null;
  const body = typeof input.body === "string" ? input.body : "";
  if (!body || body.length > COMMENT_HTML_MAX) return null;
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
    if (raw.charAt(0) === "!" || raw.charAt(0) === "?") continue;
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

function anchorIdOf(attrs) {
  if (attrValue(attrs, "class").split(/\s+/).indexOf("cmt-anchor") === -1) return "";
  return attrValue(attrs, "data-cmt");
}

function fieldSignature(html, dropId) {
  const path = [];
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
  row.updatedAt = now;
  row.updatedBy = author;
  return "ok";
}

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
const SHA_RE = /^[0-9a-f]{64}$/;
const CLIENT_BLOBS = 2;
const MISSING_BODY = 256 * 1024;
const MISSING_MAX = 2000;

function isSha(value) {
  return typeof value === "string" && SHA_RE.test(value);
}

function blobPath(sha) {
  return path.join(BLOBS_DIR, sha.slice(0, 2), sha);
}

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

async function blobsMissing(shas) {
  const missing = [];
  for (const sha of shas) if (!(await hasBlob(sha))) missing.push(sha);
  return missing;
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

async function refusedRefs(incoming, docId, acceptMissing) {
  if (!incoming.size) return [];
  const missing = await blobsMissing(incoming);
  if (!missing.length) return [];
  const accept = new Set(Array.isArray(acceptMissing) ? acceptMissing.filter(isSha) : []);
  const stored = docId ? await storedRefsOf(docId) : null;
  return missing.filter((sha) => !accept.has(sha) && !(stored && stored.has(sha)));
}

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

function clientKnowsBlobs(req) {
  const v = parseInt(String(req.headers["x-splitpage-client"] || ""), 10);
  return isFinite(v) && v >= CLIENT_BLOBS;
}

const reviewLedgers = new Map();

function reviewLedger(token, now) {
  const list = (reviewLedgers.get(token) || []).filter((e) => now - e.at < REVIEW_BLOB_WINDOW_MS);
  if (list.length) reviewLedgers.set(token, list); else reviewLedgers.delete(token);
  return list;
}

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

async function blobVisibility(req, role) {
  if (role !== "review") return null;
  const scope = reviewScopeOf(req);
  if (!scope) return null;
  const token = String(req.headers["x-splitpage-token"] || "");
  const refs = (await storedRefsOf(scope)) || new Set();
  return (sha) => refs.has(sha) || reviewUploaded(token, sha);
}

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
    if (visible && !visible(sha)) return sendJson(res, 404, { error: "not-found" });
    let buf;
    try {
      buf = await fsp.readFile(blobPath(sha));
    } catch (err) {
      if (err && err.code === "ENOENT") return sendJson(res, 404, { error: "not-found" });
      throw err;
    }
    const mime = sniffImageMime(buf);
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
        present = sha256Of(await fsp.readFile(blobPath(sha)).catch(() => Buffer.alloc(0))) === sha;
      }
      if (present) touchBlobs([sha]);
      else await writeBlob(sha, buf);
      if (entry && !(present && truthful)) {
        entry.sha = sha;
        entry.bytes = blobCharge(buf.length);
        entry = null;
      }
      if (present && truthful) return sendJson(res, 200, { stored: false });
      return sendJson(res, 201, { stored: true });
    } finally {
      if (entry) {
        const list = reviewLedgers.get(token);
        const at = list ? list.indexOf(entry) : -1;
        if (at !== -1) list.splice(at, 1);
      }
    }
  }

  return sendJson(res, 405, { error: "method-not-allowed" });
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
      reviewAvailable: REVIEW_ACTIVE,
      blobs: 1,
      version: VERSION
    });
  }

  if (parts[1] === "join" && req.method === "POST") {
    if (!JOIN_PIN) return sendJson(res, 200, { token: SESSION_TOKEN, role: "edit", open: true });
    const ip = clientIp(req);
    if (recentFailures(ip).length >= PIN_MAX_FAILURES) {
      return sendJson(res, 429, { error: "too-many-attempts" });
    }
    const body = await readBody(req, SMALL_BODY);
    if (sameSecret(body && body.pin, JOIN_PIN)) {
      pinFailures.delete(ip);
      return sendJson(res, 200, { token: SESSION_TOKEN, role: "edit" });
    }
    if (REVIEW_ACTIVE && body && typeof body.key === "string") {
      const grant = reviewGrantsByKey.get(body.key);
      if (grant) {
        pinFailures.delete(ip);
        return sendJson(res, 200, { token: grant.token, role: "review", docId: grant.docId });
      }
    }
    if (REVIEW_ACTIVE && ((REVIEW_PIN && sameSecret(body && body.pin, REVIEW_PIN)) ||
                          (REVIEW_KEY && sameSecret(body && body.key, REVIEW_KEY)))) {
      pinFailures.delete(ip);
      return sendJson(res, 200, { token: REVIEW_TOKEN, role: "review" });
    }
    noteFailure(ip);
    return sendJson(res, 401, { error: "bad-pin" });
  }

  if (parts[1] === "launcher") return handleLauncher(req, res, parts);

  if (parts[1] === "presence" && req.method === "POST") {
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

  const role = JOIN_PIN ? roleOf(req) : "edit";
  if (!role) {
    return sendJson(res, 401, { error: "pin-required" });
  }

  if (parts[1] === "me" && req.method === "GET") {
    return sendJson(res, 200, Object.assign({ role }, who));
  }

  if (parts[1] === "share" && req.method === "GET") {
    if (role !== "edit") return sendJson(res, 403, { error: "review-only" });
    if (!REVIEW_ACTIVE) return sendJson(res, 200, { reviewAvailable: false, reviewKey: "", docId: "" });
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

  if (parts[1] === "blobs") return handleBlobs(req, res, parts, role);

  if (parts[1] !== "docs") return sendJson(res, 404, { error: "not-found" });

  const id = parts[2];

  if (!id && req.method === "GET") {
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
    const body = await readBody(req);
    if (!body || typeof body.state !== "object" || body.state === null) {
      return sendJson(res, 400, { error: "bad-state" });
    }
    const createRefs = refsIn(body.state);
    const createMissing = await refusedRefs(createRefs, "", body.acceptMissing);
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

  if (role === "review") {
    const scope = reviewScopeOf(req);
    if (scope && scope !== id) return sendJson(res, 403, { error: "wrong-document" });
  }

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
    const commentRefs = await commentRefsRefused(req, role, id, comment.body);
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
    if (!body || typeof body.state !== "object" || body.state === null) {
      return sendJson(res, 400, { error: "bad-state" });
    }
    const putRefs = refsIn(body.state);
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
  const url = new URL(req.url, "http://localhost");
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
