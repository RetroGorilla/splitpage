"use strict";

const { codePointPrefix } = require("./text");
const { htmlTokens, attrValue, VOID_TAGS } = require("./html-tokens");

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

function commentName(value, max) {
  return codePointPrefix(commentText(value, Infinity).replace(/\p{Cs}/gu, "").trim(), max).trimEnd();
}

function commentQuote(value, max) {
  return codePointPrefix(commentText(String(value == null ? "" : value).replace(/\p{Cs}/gu, ""), Infinity), max);
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
    quotedText: commentQuote(input.quotedText, COMMENT_QUOTE_MAX),
    author: commentName(input.author, COMMENT_NAME_MAX) || fallbackAuthor || "Anonymous",
    body,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    assignee: commentName(input.assignee, COMMENT_NAME_MAX),
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
    author: commentName(input.author, COMMENT_NAME_MAX) || fallbackAuthor || "Anonymous",
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

module.exports = {
  COMMENT_NAME_MAX,
  DOC_COMMENTS_MAX,
  COMMENT_REPLIES_MAX,
  commentName,
  commentIdOf,
  cleanComment,
  cleanReply,
  placeAnchor
};
