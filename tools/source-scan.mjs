import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const SCRIPT_EXTENSIONS = new Map([
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS]
]);

export function extensionOf(path) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

export function isScript(path) {
  return SCRIPT_EXTENSIONS.has(extensionOf(path));
}

export function listRepoFiles(repo = REPO) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

export function parseScript(path, text) {
  const kind = SCRIPT_EXTENSIONS.get(extensionOf(path)) ?? ts.ScriptKind.JS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

function tokensOf(node, sf, out) {
  const children = node.getChildren(sf);
  if (children.length === 0) {
    out.push(node);
    return;
  }
  for (const child of children) tokensOf(child, sf, out);
}

export function scriptComments(path, text) {
  const sf = parseScript(path, text);
  const tokens = [];
  tokensOf(sf, sf, tokens);
  const seen = new Set();
  const comments = [];
  for (const token of tokens) {
    const ranges = [...(ts.getLeadingCommentRanges(text, token.pos) ?? []), ...(ts.getTrailingCommentRanges(text, token.end) ?? [])];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      comments.push({ start: range.pos, end: range.end, text: text.slice(range.pos, range.end) });
    }
  }
  return comments.sort((a, b) => a.start - b.start);
}

export function cssComments(text, offset = 0) {
  const comments = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      comments.push({ start: offset + i, end: offset + end, text: text.slice(i, end) });
      i = end;
    } else if (/^url\(\s*[^\s"')]/i.test(text.slice(i, i + 64)) && !/[\w-]/.test(text[i - 1] ?? "")) {
      const close = text.indexOf(")", i);
      i = close === -1 ? text.length : close + 1;
    } else {
      i++;
    }
  }
  return comments;
}

const RAW_TEXT = /^<(script|style)\b/i;

function scriptTypeIsJs(openTag) {
  const m = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openTag);
  if (!m) return true;
  const type = (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
  return type === "" || type === "module" || /(?:java|ecma)script$/.test(type);
}

function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return text.length;
}

export function htmlComments(text) {
  const comments = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      const end = close === -1 ? text.length : close + 3;
      comments.push({ start: lt, end, text: text.slice(lt, end) });
      i = end;
      continue;
    }
    if (!/[A-Za-z!/]/.test(text[lt + 1] ?? "")) { i = lt + 1; continue; }
    const openEnd = tagEnd(text, lt + 1);
    const raw = RAW_TEXT.exec(text.slice(lt, openEnd));
    if (!raw) { i = openEnd; continue; }
    const name = raw[1].toLowerCase();
    const closeRe = new RegExp("</" + name + "\\s*>", "ig");
    closeRe.lastIndex = openEnd;
    const close = closeRe.exec(text);
    const bodyEnd = close ? close.index : text.length;
    const body = text.slice(openEnd, bodyEnd);
    if (name === "style") comments.push(...cssComments(body, openEnd));
    else if (scriptTypeIsJs(text.slice(lt, openEnd))) {
      for (const c of scriptComments("inline.js", body)) comments.push({ start: openEnd + c.start, end: openEnd + c.end, text: c.text });
    }
    i = close ? close.index + close[0].length : text.length;
  }
  return comments;
}

const WORD_BREAK = new Set([" ", "\t", "\n", "\r", ";", "&", "|", "(", ")"]);

export function shellComments(text, dialect = "sh") {
  const ps = dialect === "ps1";
  const escape = ps ? "`" : "\\";
  const comments = [];
  const heredocs = [];
  let i = 0;
  if (!ps && text.startsWith("#!")) i = text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" && heredocs.length) {
      i++;
      while (heredocs.length && i < text.length) {
        const { tag, strip } = heredocs.shift();
        for (;;) {
          const eol = text.indexOf("\n", i);
          const line = text.slice(i, eol === -1 ? text.length : eol);
          i = eol === -1 ? text.length : eol + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === tag || eol === -1) break;
        }
      }
      continue;
    }
    if (c === escape) { i += 2; continue; }
    if (ps && c === "@" && (text[i + 1] === '"' || text[i + 1] === "'") && (text[i + 2] === "\n" || text[i + 2] === "\r")) {
      const close = text.indexOf("\n" + text[i + 1] + "@", i + 2);
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === escape ? 2 : 1;
      i++;
      continue;
    }
    if (!ps && c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const m = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(text.slice(i, i + 128));
      if (m) {
        heredocs.push({ tag: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" });
        i += m[0].length;
        continue;
      }
    }
    if (ps && c === "<" && text[i + 1] === "#") {
      const close = text.indexOf("#>", i + 2);
      const end = close === -1 ? text.length : close + 2;
      comments.push({ start: i, end, text: text.slice(i, end) });
      i = end;
      continue;
    }
    if (c === "#" && (i === 0 || WORD_BREAK.has(text[i - 1]))) {
      const eol = text.indexOf("\n", i);
      const end = eol === -1 ? text.length : eol;
      comments.push({ start: i, end, text: text.slice(i, end).replace(/\r$/, "") });
      i = end;
      continue;
    }
    i++;
  }
  return comments;
}

export function batchComments(text) {
  const comments = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (/^(?:@?rem(?:\s|$)|::)/i.test(trimmed)) {
      const lead = line.length - trimmed.length;
      comments.push({ start: offset + lead, end: offset + line.length, text: trimmed.replace(/\r$/, "") });
    }
    offset += line.length + 1;
  }
  return comments;
}

export function commentsIn(path, text) {
  const ext = extensionOf(path);
  if (isScript(path)) return scriptComments(path, text);
  if (ext === ".css") return cssComments(text);
  if (ext === ".html" || ext === ".htm") return htmlComments(text);
  if (ext === ".sh") return shellComments(text, "sh");
  if (ext === ".ps1") return shellComments(text, "ps1");
  if (ext === ".bat" || ext === ".cmd") return batchComments(text);
  return null;
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
