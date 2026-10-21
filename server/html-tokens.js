"use strict";

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

module.exports = { htmlTokens, attrValue, VOID_TAGS };
