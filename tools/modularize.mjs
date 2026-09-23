#!/usr/bin/env node
/* One-shot codemod: src/js fragments -> ES modules (issue #66).
 *
 * It is committed because it is the record of HOW the conversion was done.
 * It is not part of the build and nothing runs it again; `node build.mjs`
 * only bundles the modules it produced.
 *
 * Before: src/js/*.js were FRAGMENTS of one IIFE — 00-prelude.js opened
 * `(function () { "use strict";`, 21-events.js closed `})();`, and every
 * name in between shared that one function scope. After: each file is a real
 * module with explicit import/export, and esbuild bundles them back into the
 * same single <script> in index.html.
 *
 * The three things that make that conversion safe, and why:
 *
 * 1. FUNCTIONS become `export function` / `import`. All 963 of them were
 *    hoisted to the top of the IIFE, so any of them could call any other;
 *    ESM hoists function declarations across the whole graph at instantiation
 *    time, so mutual recursion across modules keeps working and the import
 *    cycles that fall out of it are harmless.
 *
 * 2. CROSS-FRAGMENT-ASSIGNED `var`s become properties of one shared object
 *    (src/js/_state.js). An ESM import binding is read-only: `state = next`
 *    in 18-local-files.js could not stay a write to a `var state` imported
 *    from 00-prelude.js. Every binding that was written from a fragment
 *    other than the one declaring it moves onto `S`, and every reference to
 *    it — read or write, in every fragment — becomes `S.name`. A `var` that
 *    only its own fragment ever assigns stays a `var`, exported when another
 *    fragment reads it.
 *
 * 3. EVALUATION ORDER is pinned by hand. Today's order is filename order,
 *    top to bottom, in one pass. A bundler picks its own module order out of
 *    the import graph, and with cycles that order is not filename order. So
 *    each module's eval-time work — its side-effecting statements and any
 *    `var` initialiser that is not a self-contained literal — moves into an
 *    exported `__init()`, and src/js/_entry.js calls the 41 `__init()`s in
 *    filename order. Whatever order the bundler evaluates the modules in, it
 *    only ever defines functions and assigns literals; everything that reads
 *    the DOM, localStorage or another fragment's value still happens in the
 *    order it happens in today. (PAGE_SHELL is the sharp edge: it has to be
 *    captured before anything touches the DOM, and 00-prelude's __init() is
 *    the first thing _entry.js calls.)
 *
 * It needs two parsers that the app itself does not: acorn to parse the
 * fragments and eslint-scope to resolve every identifier to the declaration
 * it actually means. They are deliberately NOT in package.json — build.mjs's
 * one dependency is esbuild and nothing else ships — so running this again
 * means installing them first:
 *
 *   npm install --no-save acorn eslint-scope
 *   node tools/modularize.mjs --src <a checkout of the old fragments> --out src/js
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";
import { analyze } from "eslint-scope";

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : argv[i + 1];
};
const SRC = argOf("--src", "src/js");
const OUT = argOf("--out", "src/js");

const chomp = (t) => (t.endsWith("\n") ? t.slice(0, -1) : t);

/* ---- 1. rebuild the single script exactly the way build.mjs used to ---- */

const names = readdirSync(SRC).filter((n) => /^[0-9]/.test(n) && n.endsWith(".js")).sort();
if (names.length < 2) throw new Error("no fragments in " + SRC);

let src = "";
const spans = [];
for (const n of names) {
  const text = chomp(readFileSync(join(SRC, n), "utf8"));
  const start = src.length;
  src += text;
  spans.push({ name: n, start, end: src.length });
  src += "\n";
}
src = src.slice(0, -1);

const fragIndexOf = (pos) => {
  for (let i = 0; i < spans.length; i++) if (pos >= spans[i].start && pos <= spans[i].end) return i;
  throw new Error("offset " + pos + " is outside every fragment");
};
const fragOf = (pos) => spans[fragIndexOf(pos)].name;

const comments = [];
const ast = acorn.parse(src, {
  ecmaVersion: 2023, sourceType: "script", ranges: true, onComment: comments
});

/* ---- 2. the IIFE, and the top-level bindings that shared its scope ---- */

const iife = ast.body[0] && ast.body[0].type === "ExpressionStatement" &&
  ast.body[0].expression.type === "CallExpression" && ast.body[0].expression.callee;
if (!iife || iife.type !== "FunctionExpression") throw new Error("src/js is not one IIFE any more — already converted?");
const topStatements = iife.body.body;

const scopeManager = analyze(ast, { ecmaVersion: 2023, sourceType: "script" });
const iifeScope = scopeManager.acquire(iife);

/* parent links, for the two syntactic shapes that a bare `name` -> `S.name`
   rewrite cannot be blind about: object shorthand and destructuring. */
const parents = new Map();
(function link(node, parent) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) link(n, parent); return; }
  if (typeof node.type !== "string") return;
  parents.set(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "range" || key === "loc" || key === "type") continue;
    link(node[key], node);
  }
})(ast, null);

const bindings = new Map(); /* name -> info */
for (const v of iifeScope.variables) {
  if (v.name === "arguments" || !v.defs.length) continue;
  if (v.defs.length > 1) throw new Error("two declarations of " + v.name + " — the fragments relied on that?");
  const def = v.defs[0];
  const declFrag = fragOf(def.name.range[0]);
  const info = {
    name: v.name,
    isFunction: def.type === "FunctionName",
    declFrag,
    declNode: def.node,
    refs: [],
    readFrags: new Set(),
    writeFrags: new Set()
  };
  for (const ref of v.references) {
    const frag = fragOf(ref.identifier.range[0]);
    info.refs.push({ id: ref.identifier, frag });
    if (ref.isWrite()) info.writeFrags.add(frag);
    if (ref.isRead()) info.readFrags.add(frag);
  }
  info.usedBy = new Set([...info.readFrags, ...info.writeFrags]);
  info.shared = [...info.usedBy].some((f) => f !== declFrag);
  /* An import binding cannot be assigned. Anything another fragment writes
     has to live somewhere both fragments can write: the shared state object. */
  info.onState = !info.isFunction && [...info.writeFrags].some((f) => f !== declFrag);
  bindings.set(v.name, info);
}

const stateNames = [...bindings.values()].filter((b) => b.onState).map((b) => b.name).sort();
const STATE = "S";
if (bindings.has(STATE)) throw new Error("the name " + STATE + " is taken");

/* ---- 3. which initialisers may run whenever the bundler feels like it ----

   "Static" means the expression cannot observe anything: no calls, no member
   reads, no reference to another binding. Those can stay where they are and
   run at module-evaluation time in whatever order the bundle lands in.
   Everything else moves into __init(). */

function isStatic(node) {
  if (!node) return false;
  switch (node.type) {
    case "Literal": return true;
    case "Identifier": return node.name === "undefined";
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      /* the body does not run yet — but a closure over a live binding is
         only safe because the binding it closes over is either on S or is
         assigned before the closure is ever called (see __init ordering). */
      return true;
    case "UnaryExpression": return isStatic(node.argument);
    case "BinaryExpression": return isStatic(node.left) && isStatic(node.right);
    case "TemplateLiteral": return node.expressions.every(isStatic);
    case "ArrayExpression": return node.elements.every((e) => e && isStatic(e));
    case "ObjectExpression":
      return node.properties.every((p) => p.type === "Property" && !p.computed && isStatic(p.value));
    case "NewExpression":
      return node.callee.type === "Identifier" &&
        ["Map", "Set", "WeakMap", "WeakSet"].includes(node.callee.name) &&
        node.arguments.length === 0;
    default: return false;
  }
}

/* ---- 4. plan the edits ---- */

const perFragment = names.map((name, i) => ({
  name, index: i, span: spans[i],
  edits: [],            /* { start, end, text } in concat coordinates */
  moves: [],            /* { start, end, text } statements lifted into __init */
  hoists: [],           /* "export var foo;" lines */
  imports: new Map(),   /* fragment name -> Set of imported names */
  needsState: false
}));
const byName = new Map(perFragment.map((f) => [f.name, f]));

/* 4a. every reference to a binding that moved onto S */
for (const info of bindings.values()) {
  if (!info.onState) continue;
  for (const ref of info.refs) {
    const frag = byName.get(ref.frag);
    frag.needsState = true;
    const parent = parents.get(ref.id);
    if (parent && parent.type === "Property" && parent.shorthand) {
      if (parent.value === ref.id && parents.get(parent).type === "ObjectPattern") {
        throw new Error("destructuring assignment into " + info.name + " — hand-convert it");
      }
      frag.edits.push({ start: ref.id.range[0], end: ref.id.range[1], text: info.name + ": " + STATE + "." + info.name });
    } else {
      frag.edits.push({ start: ref.id.range[0], end: ref.id.range[1], text: STATE + "." + info.name });
    }
  }
}

/* 4b. imports: a name this fragment uses but another fragment declares */
for (const info of bindings.values()) {
  if (info.onState) continue; /* reached through S, not through a name import */
  for (const frag of info.usedBy) {
    if (frag === info.declFrag) continue;
    const f = byName.get(frag);
    if (!f.imports.has(info.declFrag)) f.imports.set(info.declFrag, new Set());
    f.imports.get(info.declFrag).add(info.name);
  }
}

/* 4c. the IIFE's own wrapper text */
const first = perFragment[0], last = perFragment[perFragment.length - 1];
first.edits.push({ start: 0, end: iife.body.range[0] + 1, text: "" });
last.edits.push({ start: iife.body.range[1] - 1, end: src.length, text: "" });

/* 4d. statement by statement */
const commentsSorted = comments.slice().sort((a, b) => a.range[0] - b.range[0]);
function leadingEdge(stmt, prevEnd) {
  let edge = stmt.range[0];
  for (let i = commentsSorted.length - 1; i >= 0; i--) {
    const c = commentsSorted[i];
    if (c.range[1] > edge) continue;
    if (c.range[0] < prevEnd) break;
    const between = src.slice(c.range[1], edge);
    if (!/^\s*$/.test(between)) break;
    if (between.indexOf("\n") === -1 && c.range[1] !== edge) break;
    if (prevEnd > 0 && src.slice(prevEnd, c.range[0]).indexOf("\n") === -1) break;
    edge = c.range[0];
  }
  /* back up over the indentation on the comment's own line */
  let bol = edge;
  while (bol > prevEnd && src[bol - 1] !== "\n") bol--;
  if (/^[ \t]*$/.test(src.slice(bol, edge))) edge = bol;
  return edge;
}

/* Was this fragment written indented inside the IIFE, or flush left? Every
   fragment but 20i-topbar.js took the two spaces; de-indenting the one that
   did not would eat a level of its real structure. */
for (const frag of perFragment) frag.indented = null;
for (const stmt of topStatements) {
  const frag = perFragment[fragIndexOf(stmt.range[0])];
  const col = stmt.range[0] - src.lastIndexOf("\n", stmt.range[0] - 1) - 1;
  if (frag.indented !== false) frag.indented = col >= 2;
}
for (const frag of perFragment) if (frag.indented === null) frag.indented = true;

const prevEndByFrag = new Map();
for (const stmt of topStatements) {
  const fi = fragIndexOf(stmt.range[0]);
  const frag = perFragment[fi];
  const prevEnd = prevEndByFrag.get(fi) ?? frag.span.start;
  const edge = leadingEdge(stmt, prevEnd);
  prevEndByFrag.set(fi, stmt.range[1]);

  if (stmt.type === "ExpressionStatement" && stmt.directive === "use strict") {
    frag.edits.push({ start: edge, end: stmt.range[1] + (src[stmt.range[1]] === "\n" ? 1 : 0), text: "" });
    continue;
  }

  if (stmt.type === "FunctionDeclaration") {
    const info = bindings.get(stmt.id.name);
    if (info && info.shared) frag.edits.push({ start: stmt.range[0], end: stmt.range[0], text: "export " });
    continue;
  }

  if (stmt.type === "VariableDeclaration") {
    const decls = stmt.declarations;
    const anyOnState = decls.some((d) => bindings.get(d.id.name).onState);
    const allStatic = decls.every((d) => isStatic(d.init));
    const anyShared = decls.some((d) => bindings.get(d.id.name).shared);

    if (!anyOnState && allStatic) {
      if (anyShared) frag.edits.push({ start: stmt.range[0], end: stmt.range[0], text: "export " });
      continue;
    }

    /* drop the `var` keyword: the statement becomes assignments. Names that
       are not on S need a declaration somewhere, so hoist a bare one. */
    frag.edits.push({ start: stmt.range[0], end: decls[0].range[0], text: "" });
    for (const d of decls) {
      const info = bindings.get(d.id.name);
      if (info.onState) continue;
      frag.hoists.push((info.shared ? "export var " : "var ") + info.name + ";");
    }
    if (allStatic) continue; /* safe to assign at module-evaluation time */
    frag.moves.push({ start: edge, end: stmt.range[1] });
    continue;
  }

  /* everything else is eval-time work: it moves into __init() */
  frag.moves.push({ start: edge, end: stmt.range[1] });
}

/* ---- 5. render each module ---- */

/* Two-space indentation came from sitting inside the IIFE. Strip it as a set
   of edits, so it composes with the other rewrites instead of having to be
   re-applied to already-moved text. Never inside a string or template that
   spans lines — and not at all in a fragment that never took the indentation
   in the first place (20i-topbar.js is written flush left inside the IIFE). */
const protectedLines = new Set();
(function findMultilineLiterals(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) findMultilineLiterals(n); return; }
  if (typeof node.type !== "string") return;
  if (node.type === "TemplateLiteral" || (node.type === "Literal" && typeof node.value === "string")) {
    const text = src.slice(node.range[0], node.range[1]);
    if (text.indexOf("\n") !== -1) {
      const firstLine = src.slice(0, node.range[0]).split("\n").length;
      const span = text.split("\n").length - 1;
      for (let k = 1; k <= span; k++) protectedLines.add(firstLine + k);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "range" || key === "loc" || key === "type") continue;
    findMultilineLiterals(node[key]);
  }
})(ast);

/* offset of the start of every line, and its 1-based line number */
const lineStarts = [0];
for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);

function applyEdits(text, edits, base) {
  const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "", at = 0;
  for (const e of sorted) {
    const s = e.start - base, en = e.end - base;
    if (s < at) throw new Error("overlapping edits at " + e.start + " (" + fragOf(e.start) + ")");
    out += text.slice(at, s) + e.text;
    at = en;
  }
  return out + text.slice(at);
}

mkdirSync(OUT, { recursive: true });

for (const frag of perFragment) {
  const base = frag.span.start;

  /* statements lifted into __init(), plus the blank line each one leaves */
  const moves = frag.moves.slice().sort((a, b) => a.start - b.start);
  const removals = moves.map((m) => {
    let start = m.start, end = m.end;
    if (src[end] === "\n") end++;
    if (src[start - 1] === "\n" && src[start - 2] === "\n") start--;
    return { start, end, text: "" };
  });

  /* de-indent edits, skipping anything that would collide with a rewrite */
  const dedents = [];
  for (let ln = 0; frag.indented && ln < lineStarts.length; ln++) {
    const at = lineStarts[ln];
    if (at < frag.span.start || at >= frag.span.end) continue;
    if (protectedLines.has(ln + 1)) continue;
    const width = src.startsWith("  ", at) ? 2 : (src[at] === "\t" ? 1 : 0);
    if (!width) continue;
    if (frag.edits.some((e) => at < e.end && at + width > e.start)) continue;
    dedents.push({ start: at, end: at + width, text: "" });
  }

  const movedChunks = moves.map((m) => {
    const inside = frag.edits.concat(dedents).filter((e) => e.start >= m.start && e.end <= m.end);
    return applyEdits(src.slice(m.start, m.end), inside, m.start).replace(/^[ \t]+/, "");
  });

  const inRemoval = (e) => removals.some((r) => e.start >= r.start && e.end <= r.end);
  const bodyEdits = frag.edits.filter((e) => !inRemoval(e))
    .concat(removals)
    .concat(dedents.filter((e) => !inRemoval(e)));
  let bodyText = applyEdits(src.slice(frag.span.start, frag.span.end), bodyEdits, base);
  bodyText = bodyText.replace(/^[\s\uFEFF]+/, "").replace(/[ \t\n]+$/, "");

  const lines = [];
  if (frag.needsState) lines.push('import { ' + STATE + ' } from "./_state.js";');
  for (const from of [...frag.imports.keys()].sort()) {
    const namesIn = [...frag.imports.get(from)].sort();
    const one = "import { " + namesIn.join(", ") + ' } from "./' + from + '";';
    lines.push(one.length <= 92 ? one
      : "import {\n  " + namesIn.join(",\n  ") + '\n} from "./' + from + '";');
  }
  if (lines.length) lines.push("");
  if (frag.hoists.length) {
    lines.push("/* Declared here, assigned in __init() below: these initialisers read the");
    lines.push("   DOM, read storage, or depend on another module's value, so they have to");
    lines.push("   run in fragment order rather than in whatever order the bundle lands in. */");
    lines.push(...frag.hoists);
    lines.push("");
  }
  if (bodyText) { lines.push(bodyText); lines.push(""); }
  lines.push("/* Eval-time work for this module. _entry.js calls every module's __init()");
  lines.push("   in filename order — the order these statements used to run in. */");
  if (!movedChunks.length) {
    lines.push("export function __init() {}");
  } else {
    lines.push("export function __init() {");
    for (let i = 0; i < movedChunks.length; i++) {
      if (i) lines.push("");
      lines.push(movedChunks[i].split("\n").map((l) => (l.trim() ? "  " + l : "")).join("\n"));
    }
    lines.push("}");
  }

  writeFileSync(join(OUT, frag.name), lines.join("\n") + "\n");
}

/* ---- 6. the two generated modules ---- */

function wrapComment(text, indent, width) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length + indent.length + 3 > width) { lines.push(line); line = w; }
    else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => indent + (i === 0 ? "/* " : "   ") + l).join("\n") + " */";
}

const stateDoc = stateNames.map((n) => {
  const b = bindings.get(n);
  const shortFrag = (f) => f.replace(/\.js$/, "");
  const doc = shortFrag(b.declFrag) + " declares it; " +
    [...b.writeFrags].sort().map(shortFrag).join(", ") + " assign it.";
  return wrapComment(doc, "  ", 78) + "\n  " + n + ": undefined";
}).join(",\n\n");

writeFileSync(join(OUT, "_state.js"), `/* The state the modules share and all of them may write.
 *
 * Generated by tools/modularize.mjs (issue #66) and maintained by hand from
 * here on. Every name below used to be a plain \`var\` in the one IIFE that
 * src/js was, written from more than one fragment. An ES module's import
 * binding is read-only, so a name like that cannot be imported and assigned
 * — it lives here instead, and every fragment reads and writes it as
 * \`S.name\`.
 *
 * A \`var\` that only its own module ever assigns is NOT here: it stays a
 * \`var\` in that module and is exported for the modules that read it.
 * Nothing goes on S to be convenient; a name is here because two modules
 * write it.
 *
 * Every property is spelled out with an \`undefined\` initialiser, mirroring
 * what \`var\` hoisting used to give these names before their first
 * assignment ran, and so this file is a readable list of what the app's
 * modules actually share.
 */
export const ${STATE} = {
${stateDoc}
};
`);

const entryImports = names.map((n) => {
  const alias = "init_" + n.replace(/\.js$/, "").replace(/[^A-Za-z0-9]/g, "_");
  return { n, alias };
});
writeFileSync(join(OUT, "_entry.js"), `/* The bundle's entry point: it fixes the order the app boots in.
 *
 * src/js used to be fragments of a single IIFE, concatenated in filename
 * order, so "load order" and "filename order" were the same thing. A bundler
 * evaluates modules in the order the import graph gives it, and this graph
 * has cycles (963 top-level functions that could all call each other), so
 * that order is NOT filename order and must not be relied on.
 *
 * So no module does anything at evaluation time except declare functions and
 * assign self-contained literals. Everything that reads the DOM, reads
 * storage, registers a listener or depends on another module's value sits in
 * that module's exported __init(), and this file calls them in the order the
 * fragments used to run in. 00-prelude first — it captures PAGE_SHELL, which
 * has to be the page as it was served, before anything touches the DOM —
 * and 21-events last, which wires every listener and calls init().
 *
 * Generated by tools/modularize.mjs (issue #66); keep it in filename order.
 */
${entryImports.map((e) => `import { __init as ${e.alias} } from "./${e.n}";`).join("\n")}

${entryImports.map((e) => `${e.alias}();`).join("\n")}
`);

/* ---- 7. what happened ---- */
const fnCount = [...bindings.values()].filter((b) => b.isFunction).length;
const varCount = [...bindings.values()].filter((b) => !b.isFunction).length;
console.log("modules written:   " + names.length + " + _state.js + _entry.js");
console.log("top-level funcs:   " + fnCount + " (" + [...bindings.values()].filter((b) => b.isFunction && b.shared).length + " exported)");
console.log("top-level vars:    " + varCount + " (" + [...bindings.values()].filter((b) => !b.isFunction && b.shared && !b.onState).length + " exported, " + stateNames.length + " moved onto S)");
console.log("statements lifted into __init(): " + perFragment.reduce((n, f) => n + f.moves.length, 0));
