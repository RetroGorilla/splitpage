import ts from "typescript";
import { Parser, parseAllDocuments, LineCounter, isAlias, isMap, isSeq, isScalar } from "yaml";
import { shellComments, batchComments, extensionOf, scriptComments as jsComments } from "./source-scan.mjs";

export const DOCKERFILE_PATH = /(^|\/)(?![^/]*\.(?:md|txt)$)(?:Dockerfile(?:[._-][\w.-]*)?|[\w.-]+\.dockerfile)$/i;
export const COMPOSE_PATH = /(^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/;

export function configKind(path) {
  const ext = extensionOf(path);
  if (DOCKERFILE_PATH.test(path)) return "dockerfile";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".json" || ext === ".jsonc") return "jsonc";
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
  if (dialect === "js") return [...comments, ...jsComments("step.js", body)];
  return [...comments, ...shellComments(body, dialect)];
}

export function shellDialect(shell) {
  const name = String(shell ?? "bash").trim().split(/\s+/)[0].toLowerCase();
  if (name === "pwsh" || name === "powershell") return "ps1";
  if (name === "cmd") return "bat";
  if (name === "node") return "js";
  return "sh";
}

export function runnerOs(node, resolve = (n) => n) {
  const runsOn = resolve(node);
  if (runsOn == null) return null;
  let labels = runsOn;
  if (isMap(runsOn)) {
    labels = resolve(runsOn.get("labels", true));
    if (labels == null) return "unknown";
  }
  const texts = (isSeq(labels) ? labels.items : [labels]).map(resolve).map((n) => (isScalar(n) && n.value != null ? String(n.value) : null));
  if (texts.some((t) => t === null || t.includes("${{"))) return "unknown";
  if (texts.some((t) => /windows/i.test(t))) return "windows";
  if (texts.some((t) => /ubuntu|linux|macos|darwin/i.test(t))) return "other";
  return "unknown";
}

function stepComments(path, script, shell, os, line) {
  if (shell != null) return scriptComments(script, shellDialect(shell));
  if (os === "windows") return scriptComments(script, "ps1");
  if (os === "other") return scriptComments(script, "sh");
  const asBash = scriptComments(script, "sh");
  const asPowerShell = scriptComments(script, "ps1");
  const key = (list) => JSON.stringify(list.map((c) => [c.start, c.text]));
  if (key(asBash) !== key(asPowerShell)) {
    throw new Error(`${path}:${line}: cannot tell whether this run: step is bash or PowerShell, and its comments differ between the two; set shell: on the step or defaults.run.shell`);
  }
  return asBash;
}

const QUOTING = {
  QUOTE_SINGLE: { escape: /''/, unescape: (s) => s.replace(/''/g, "'") },
  QUOTE_DOUBLE: {
    escape: /\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S]|$)/,
    unescape: (s) => s.replace(/\\([\\"/ t])/g, (m, c) => (c === "t" ? "\t" : c))
  }
};

function valueLines(text, node, lineCounter) {
  const value = node.value;
  let offset = node.range[0];
  let source = text.slice(node.range[0], node.range[1]);
  if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") {
    const eol = source.indexOf("\n");
    offset += eol === -1 ? source.length : eol + 1;
    source = eol === -1 ? "" : source.slice(eol + 1);
  } else if (node.type === "QUOTE_DOUBLE" || node.type === "QUOTE_SINGLE") {
    offset += 1;
    source = source.slice(1, -1);
  }
  const quoting = QUOTING[node.type];
  const candidates = (content) => {
    if (!content) return [];
    if (!quoting) return [content];
    return [content, quoting.unescape(content), ...content.split(quoting.escape).map((s) => s.trim()).filter(Boolean)];
  };
  const marks = [];
  let pos = 0;
  let at = 0;
  for (const raw of source.split("\n")) {
    const lead = raw.length - raw.trimStart().length;
    for (const candidate of candidates(raw.trim())) {
      const hit = value.indexOf(candidate, pos);
      if (hit === -1) continue;
      marks.push([hit, lineCounter.linePos(offset + at + lead).line]);
      pos = hit + candidate.length;
      break;
    }
    at += raw.length + 1;
  }
  const first = marks.length ? marks[0][1] : lineCounter.linePos(offset).line;
  return (index) => {
    let line = first;
    for (const [start, l] of marks) {
      if (start > index) break;
      line = l;
    }
    return line;
  };
}

const GITHUB_SCRIPT = /^actions\/github-script@/i;

function runComments(path, doc, text, lineCounter) {
  const found = [];
  const seen = new Set();
  const resolve = (node) => (isAlias(node) ? node.resolve(doc) : node);
  const stringNode = (node) => {
    const n = resolve(node);
    return isScalar(n) && typeof n.value === "string" ? n : null;
  };
  const stringValue = (node) => {
    const n = resolve(node);
    return isScalar(n) && n.value != null ? String(n.value) : null;
  };
  const report = (node, comments) => {
    const lineIn = valueLines(text, node, lineCounter);
    for (const c of comments) {
      const line = lineIn(c.start);
      const key = `${line}\0${c.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ start: node.range[0], end: node.range[1], text: c.text, line });
    }
  };
  const visit = (node, ctx) => {
    if (isSeq(node)) { for (const item of node.items) visit(item, ctx); return; }
    if (!isMap(node)) return;
    const local = { ...ctx };
    const defaults = stringValue(["defaults", "run", "shell"].reduce((n, k) => (isMap(n) ? resolve(n.get(k, true)) : null), node));
    if (defaults != null) local.shell = defaults;
    const os = runnerOs(node.get("runs-on", true), resolve);
    if (os !== null) local.os = os;
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? pair.key.value : null;
      const steps = key === "steps" ? resolve(pair.value) : null;
      if (isSeq(steps)) {
        for (const item of steps.items) {
          const step = resolve(item);
          if (!isMap(step)) continue;
          const uses = stringValue(step.get("uses", true));
          const inputs = resolve(step.get("with", true));
          const script = uses && GITHUB_SCRIPT.test(uses) && isMap(inputs) ? stringNode(inputs.get("script", true)) : null;
          if (script) report(script, scriptComments(script.value, "js"));
          const run = stringNode(step.get("run", true));
          if (!run) continue;
          const block = run.type === "BLOCK_LITERAL" || run.type === "BLOCK_FOLDED";
          const first = lineCounter.linePos(run.range[0]).line + (block ? 1 : 0);
          report(run, stepComments(path, run.value, stringValue(step.get("shell", true)) ?? local.shell, local.os, first));
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
  if (errors.length) throw new Error(`cannot parse ${path}: ${errors[0].message.split("\n")[0]}`);
  const comments = [];
  cstComments([...new Parser().parse(text)], comments);
  if (isWorkflow(path)) for (const doc of list) comments.push(...runComments(path, doc, text, lineCounter));
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
