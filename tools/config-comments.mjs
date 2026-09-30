import ts from "typescript";
import { Parser, parseAllDocuments, LineCounter, isMap, isSeq, isScalar } from "yaml";
import { shellComments, batchComments, extensionOf } from "./source-scan.mjs";

export function configKind(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = extensionOf(path);
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".json" || ext === ".jsonc") return "jsonc";
  if (/^Dockerfile(?:\.[\w-]+)?$/.test(name) || /\.dockerfile$/i.test(name)) return "dockerfile";
  return null;
}

export function isWorkflow(path) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || /(^|\/)action\.ya?ml$/.test(path);
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function scriptComments(script, dialect, { shebang = false } = {}) {
  if (dialect === "bat") return batchComments(script);
  const comments = [];
  let body = script;
  if (!shebang && body.startsWith("#!")) {
    const eol = body.indexOf("\n");
    const end = eol === -1 ? body.length : eol;
    comments.push({ start: 0, end, text: body.slice(0, end).replace(/\r$/, "") });
    body = " ".repeat(end) + body.slice(end);
  }
  if (dialect === "sh") body = body.replace(/<<</g, "   ");
  return [...comments, ...shellComments(body, dialect)];
}

export function shellDialect(shell) {
  const name = String(shell ?? "bash").trim().split(/\s+/)[0].toLowerCase();
  if (name === "pwsh" || name === "powershell") return "ps1";
  if (name === "cmd") return "bat";
  return "sh";
}

function scalarText(node) {
  if (isScalar(node)) return node.value == null ? "" : String(node.value);
  if (isSeq(node)) return node.items.map(scalarText).join(" ");
  return "";
}

function runComments(doc, lineCounter) {
  const found = [];
  const visit = (node, ctx) => {
    if (isSeq(node)) { for (const item of node.items) visit(item, ctx); return; }
    if (!isMap(node)) return;
    const local = { ...ctx };
    const defaults = node.getIn(["defaults", "run", "shell"]);
    if (defaults != null) local.shell = String(defaults);
    if (/windows/i.test(scalarText(node.get("runs-on", true)))) local.windows = true;
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? pair.key.value : null;
      if (key === "steps" && isSeq(pair.value)) {
        for (const step of pair.value.items) {
          if (!isMap(step)) continue;
          const run = step.get("run", true);
          if (!isScalar(run) || typeof run.value !== "string") continue;
          const shell = step.get("shell") ?? local.shell ?? (local.windows ? "pwsh" : "bash");
          const block = run.type === "BLOCK_LITERAL" || run.type === "BLOCK_FOLDED";
          const first = lineCounter.linePos(run.range[0]).line + (block ? 1 : 0);
          for (const c of scriptComments(run.value, shellDialect(shell))) {
            found.push({ start: run.range[0], end: run.range[1], text: c.text, line: first + lineAt(run.value, c.start) - 1 });
          }
        }
      }
      visit(pair.value, local);
    }
  };
  visit(doc.contents, {});
  return found;
}

function cstComments(token, out) {
  if (Array.isArray(token)) { for (const t of token) cstComments(t, out); return; }
  if (!token || typeof token !== "object") return;
  if (token.type === "comment") { out.push({ start: token.offset, end: token.offset + token.source.length, text: token.source }); return; }
  for (const [key, value] of Object.entries(token)) if (key !== "source") cstComments(value, out);
}

export function yamlComments(path, text) {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter });
  const list = Array.isArray(docs) ? docs : [docs];
  const errors = list.flatMap((d) => d.errors ?? []);
  if (errors.length) throw new Error(`${path}: ${errors[0].message.split("\n")[0]}`);
  const comments = [];
  cstComments([...new Parser().parse(text)], comments);
  if (isWorkflow(path)) for (const doc of list) comments.push(...runComments(doc, lineCounter));
  return comments.sort((a, b) => a.start - b.start);
}

export function jsoncComments(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const comments = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd(), text: scanner.getTokenText() });
    }
  }
  return comments;
}

const DIRECTIVE = /^#\s*(syntax|escape|check)\s*=\s*(\S.*?)\s*$/i;
const HEREDOC = /<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))/g;
const SHELL_FORM = new Set(["RUN", "CMD", "ENTRYPOINT"]);

function shellBody(keyword, rest) {
  let body = rest;
  if (keyword === "HEALTHCHECK") {
    const m = /^(?:--\S+\s+)*CMD\s+([\s\S]*)$/i.exec(body);
    if (!m) return null;
    body = m[1];
  } else if (!SHELL_FORM.has(keyword)) {
    return null;
  }
  if (keyword === "RUN") body = body.replace(/^(?:--\S+\s+)+/, "");
  return body.trimStart().startsWith("[") ? null : body;
}

export function dockerfileComments(text) {
  const raw = text.split("\n");
  const lines = raw.map((l) => l.replace(/\r$/, ""));
  const starts = [];
  raw.reduce((offset, l) => { starts.push(offset); return offset + l.length + 1; }, 0);
  const comments = [];
  const at = (i, from, to, value, extra = {}) => comments.push({ start: starts[i] + from, end: starts[i] + to, text: value, line: i + 1, ...extra });
  let escape = "\\";
  let dialect = "sh";
  let i = 0;
  for (; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]);
    if (!m) break;
    at(i, 0, lines[i].length, lines[i], { directive: true });
    if (m[1].toLowerCase() === "escape") escape = m[2];
  }
  let parts = [];
  let first = -1;
  while (i < lines.length) {
    const line = lines[i];
    const lead = line.length - line.trimStart().length;
    if (line.trimStart().startsWith("#")) { at(i, lead, line.length, line.slice(lead)); i++; continue; }
    if (line.trim() === "") { i++; continue; }
    if (first === -1) first = i;
    const trimmed = line.trimEnd();
    const continued = trimmed.endsWith(escape);
    parts.push(continued ? trimmed.slice(0, -escape.length) : line);
    i++;
    if (continued && i < lines.length) continue;
    const instruction = parts.join("");
    const start = first;
    parts = [];
    first = -1;
    const m = /^\s*([A-Za-z]+)\s*([\s\S]*)$/.exec(instruction);
    if (!m) continue;
    const keyword = m[1].toUpperCase();
    if (keyword === "SHELL") {
      try { dialect = shellDialect(String(JSON.parse(m[2])[0]).split(/[\\/]/).pop().replace(/\.exe$/i, "")); } catch { dialect = "sh"; }
      continue;
    }
    const docs = keyword === "RUN" || keyword === "COPY" || keyword === "ADD" ? [...m[2].matchAll(HEREDOC)] : [];
    for (const d of docs) {
      const tag = d[2] ?? d[3] ?? d[4];
      const bodyStart = i;
      while (i < lines.length && (d[1] === "-" ? lines[i].replace(/^\t+/, "") : lines[i]) !== tag) i++;
      if (keyword === "RUN" && escape !== "`") {
        const body = lines.slice(bodyStart, i).join("\n");
        for (const c of scriptComments(body, dialect, { shebang: true })) {
          const line = bodyStart + lineAt(body, c.start) - 1;
          at(line, 0, lines[line].length, c.text);
        }
      }
      i++;
    }
    const body = shellBody(keyword, m[2].replace(HEREDOC, (s) => " ".repeat(s.length)));
    if (body === null || escape === "`") continue;
    for (const c of scriptComments(body, dialect, { shebang: true })) at(start, 0, lines[start].length, c.text);
  }
  return comments;
}

export function configCommentsIn(path, text) {
  const kind = configKind(path);
  if (kind === "yaml") return yamlComments(path, text);
  if (kind === "jsonc") return jsoncComments(text);
  if (kind === "dockerfile") return dockerfileComments(text);
  return null;
}
