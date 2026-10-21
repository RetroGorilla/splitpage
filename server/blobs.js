"use strict";

const { htmlTokens, attrValue } = require("./html-tokens");

const SHA_RE = /^[0-9a-f]{64}$/;
const BUDGET_WINDOW_MS = 60 * 60 * 1000;
const BLOB_MIN_CHARGE = 4096;

function isSha(value) {
  return typeof value === "string" && SHA_RE.test(value);
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

function blobAttrsIn(html, out) {
  for (const tk of htmlTokens(html)) {
    if (tk.kind !== "open" || tk.attrs.indexOf("data-blob") === -1) continue;
    const sha = attrValue(tk.attrs, "data-blob");
    if (isSha(sha)) out.add(sha);
  }
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

function htmlRefs(html) {
  const refs = new Set();
  if (typeof html === "string" && html.indexOf("data-blob") !== -1) blobAttrsIn(html, refs);
  return refs;
}

async function unavailableBlobs(shas, visible, hasBlob) {
  const missing = [];
  for (const sha of shas) {
    if ((visible && !visible(sha)) || !(await hasBlob(sha))) missing.push(sha);
  }
  return missing;
}

async function refusedRefs(incoming, opts) {
  if (!incoming.size) return [];
  const missing = await unavailableBlobs(incoming, opts.visible, opts.hasBlob);
  if (!missing.length) return [];
  const accept = new Set(Array.isArray(opts.acceptMissing) ? opts.acceptMissing.filter(isSha) : []);
  const stored = opts.storedRefs ? await opts.storedRefs() : null;
  return missing.filter((sha) => !accept.has(sha) && !(stored && stored.has(sha)));
}

async function commentRefsRefused(html, opts) {
  const refs = htmlRefs(html);
  if (!refs.size) return { refs, missing: [] };
  const visible = await opts.visibility();
  let stored;
  const missing = [];
  for (const sha of refs) {
    if (visible && !visible(sha)) { missing.push(sha); continue; }
    if (await opts.hasBlob(sha)) continue;
    if (stored === undefined) stored = (await opts.storedRefs()) || new Set();
    if (!stored.has(sha)) missing.push(sha);
  }
  return { refs, missing };
}

function blobCharge(bytes) {
  return Math.max(BLOB_MIN_CHARGE, bytes);
}

const NO_HOLD = Object.freeze({ refused: false, settle() {}, release() {} });

function createBlobBudgets(limits) {
  const clock = limits.clock || Date.now;
  const ledgers = new Map();

  function ledger(token, now) {
    const list = (ledgers.get(token) || []).filter((e) => now - e.at < BUDGET_WINDOW_MS);
    if (list.length) ledgers.set(token, list); else ledgers.delete(token);
    return list;
  }

  function budgetOf(session) {
    if (session.role === "review") return limits.reviewBudget;
    if (session.scope) return limits.linkEditBudget;
    return 0;
  }

  function bytesUsed(token, now) {
    let used = 0;
    for (const e of ledger(token, now)) used += e.bytes;
    return used;
  }

  function uploaded(token, sha) {
    return ledger(token, clock()).some((e) => e.sha === sha);
  }

  function visibleTo(session, refs) {
    return (sha) => refs.has(sha) || uploaded(session.token, sha);
  }

  function reserve(session, declared) {
    const budget = budgetOf(session);
    if (!budget) return NO_HOLD;
    const token = session.token;
    const now = clock();
    const charge = blobCharge(isFinite(declared) && declared >= 0 ? declared : limits.maxBlobBytes);
    if (bytesUsed(token, now) + charge > budget) return { refused: true, settle() {}, release() {} };
    let entry = { at: now, bytes: charge, sha: "" };
    const list = ledger(token, now);
    list.push(entry);
    ledgers.set(token, list);
    return {
      refused: false,
      settle(sha, bytes) {
        if (!entry) return;
        entry.sha = sha;
        entry.bytes = blobCharge(bytes);
        entry = null;
      },
      release() {
        if (!entry) return;
        const current = ledgers.get(token);
        const at = current ? current.indexOf(entry) : -1;
        if (at !== -1) current.splice(at, 1);
        entry = null;
      }
    };
  }

  return { budgetOf, bytesUsed, uploaded, visibleTo, reserve };
}

module.exports = {
  BUDGET_WINDOW_MS,
  BLOB_MIN_CHARGE,
  isSha,
  sniffImageMime,
  refsIn,
  htmlRefs,
  unavailableBlobs,
  refusedRefs,
  commentRefsRefused,
  blobCharge,
  createBlobBudgets
};
