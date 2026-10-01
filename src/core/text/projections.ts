import { isDirRun, normalizeCell } from "./runs.ts";
import type { CellInput } from "./runs.ts";
import { withoutCues } from "./cues.ts";
import { buildTree } from "./tree.ts";
import type { TreeOptions, TreeParent } from "./tree.ts";
import type { TagName } from "../document/tags.ts";

export type PlainTextOptions = { directions?: string | null | undefined; cues?: string | null | undefined };

export type DocxOptions = TreeOptions & { annotate?: boolean | null | undefined };

export type DocxRun = {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  mark?: boolean;
  href?: string | null;
  dir?: true;
  cue?: true;
  tag?: TagName;
  cmt?: string[];
  broll?: string;
};

type DocxFormat = {
  b: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
  mark: boolean;
  href: string | null;
  dir: boolean;
  cue: boolean;
  tag: TagName | null;
  cmt: string[];
};

export const OMIT_CLOSES = /^[.,;:!?)\]}"'\u2019\u201d]/;

export function toPlainText(cell: CellInput, opts?: PlainTextOptions | null): string {
  const omit = !!(opts && opts.directions === "omit");
  const runs = opts && opts.cues === "omit" ? withoutCues(cell) : normalizeCell(cell);
  let out = "", gap = false;
  runs.forEach(function (r, i) {
    let t = r.text;
    if (isDirRun(r)) {
      if (omit) { gap = true; return; }
      if (!isDirRun(runs[i - 1])) t = "(" + t;
      if (!isDirRun(runs[i + 1])) t += ")";
    }
    if (gap) {
      gap = false;
      if (OMIT_CLOSES.test(t)) out = out.replace(/[ \t\u00a0]+$/, "");
      else if (/[\s\u00a0]$/.test(out)) t = t.replace(/^[ \t\u00a0]+/, "");
      else if (out && !/^[\s\u00a0]/.test(t)) t = " " + t;
    }
    out += t;
  });
  return out.replace(/\u00a0/g, " ").trim();
}

export function spokenText(cell: CellInput): string {
  return toPlainText(cell, { directions: "omit", cues: "omit" });
}

const MD_MARKS = ["href", "hl", "u", "b", "i", "s"] as const;

type MdMark = (typeof MD_MARKS)[number];

type MdValue = string | true;

type MdMarks = Partial<Record<MdMark, MdValue>>;

type MdChar = { ch: string; m: MdMarks };

type MdPiece = { text: string; m: MdMarks; ext?: Partial<Record<MdMark, number>> };

type MdOpen = { k: MdMark; v: MdValue; pair: number };

type MdToken =
  | { text: string; open?: undefined; close?: undefined; v?: undefined; pair?: undefined }
  | { open: MdMark; v: MdValue; pair: number; text?: undefined; close?: undefined }
  | { close: MdMark; v: MdValue; pair: number; text?: undefined; open?: undefined };

type MdRun = { ch: string; len: number; closes: boolean; left: boolean; right: boolean; both: boolean };

type MdFlank = { left: boolean; right: boolean };

const MD_DELIM: Partial<Record<MdMark, string>> = { b: "**", i: "*", s: "~~" };
const MD_HTML: Partial<Record<MdMark, string>> = { b: "strong", i: "em", s: "s", u: "u", hl: "mark" };
const MD_WS = /[\s\u00a0]/;
const MD_PUNCT = /[\p{P}\p{S}]/u;

function mdChars(cell: CellInput): MdChar[] {
  const chars: MdChar[] = [];
  const runs = normalizeCell(cell);
  runs.forEach(function (r, ri) {
    const m: MdMarks = {};
    MD_MARKS.forEach(function (k) { if (r.marks[k]) m[k] = r.marks[k]; });
    const dir = isDirRun(r);
    if (dir) m.i = true;
    if (r.marks.cue) m.i = true;
    if (dir && !isDirRun(runs[ri - 1])) chars.push({ ch: "(", m: { i: true } });
    Array.from(r.text).forEach(function (ch) { chars.push({ ch: ch, m: Object.assign({}, m) }); });
    if (dir && !isDirRun(runs[ri + 1])) chars.push({ ch: ")", m: { i: true } });
  });
  const n = chars.length;
  let i: number, j: number;
  for (i = 0; i < n; i++) {
    if ((chars[i] as MdChar).ch !== "\n") continue;
    j = i + 1;
    while (j < n && ((chars[j] as MdChar).ch === " " || (chars[j] as MdChar).ch === "\t")) j++;
    if (j < n && (chars[j] as MdChar).ch === "\n") {
      for (let k = i; k <= j; k++) (chars[k] as MdChar).m = {};
    }
  }
  MD_MARKS.forEach(function (key) {
    for (i = 0; i < n;) {
      if (!(chars[i] as MdChar).m[key]) { i++; continue; }
      j = i;
      while (j < n && (chars[j] as MdChar).m[key]) j++;
      let a = i, z = j - 1;
      while (a <= z && MD_WS.test((chars[a] as MdChar).ch)) Reflect.deleteProperty((chars[a++] as MdChar).m, key);
      while (z >= a && MD_WS.test((chars[z] as MdChar).ch)) Reflect.deleteProperty((chars[z--] as MdChar).m, key);
      i = j;
    }
  });
  return chars;
}

function sameMdMarks(a: MdMarks, b: MdMarks): boolean {
  for (let i = 0; i < MD_MARKS.length; i++) {
    const k = MD_MARKS[i] as MdMark;
    if ((a[k] || null) !== (b[k] || null)) return false;
  }
  return true;
}

function mdTokens(cell: CellInput): MdToken[] {
  const pieces: MdPiece[] = [];
  mdChars(cell).forEach(function (c) {
    const last = pieces[pieces.length - 1];
    if (last && sameMdMarks(last.m, c.m)) last.text += c.ch;
    else pieces.push({ text: c.ch, m: c.m });
  });
  for (let p = pieces.length - 1; p >= 0; p--) {
    const piece = pieces[p] as MdPiece, next = pieces[p + 1];
    const ext: Partial<Record<MdMark, number>> = piece.ext = {};
    for (let q = 0; q < MD_MARKS.length; q++) {
      const k = MD_MARKS[q] as MdMark;
      if (!piece.m[k]) continue;
      ext[k] = piece.text.length + (next && next.m[k] === piece.m[k] ? (next.ext as Partial<Record<MdMark, number>>)[k] as number : 0);
    }
  }
  const tokens: MdToken[] = [], stack: MdOpen[] = [];
  let pairs = 0;
  pieces.forEach(function (piece) {
    const ext = piece.ext as Partial<Record<MdMark, number>>;
    let cut = 0;
    while (cut < stack.length && piece.m[(stack[cut] as MdOpen).k] === (stack[cut] as MdOpen).v) cut++;
    while (stack.length > cut) tokens.push(mdClose(stack.pop() as MdOpen));
    const open = MD_MARKS.filter(function (k) {
      if (!piece.m[k]) return false;
      for (let s = 0; s < stack.length; s++) if ((stack[s] as MdOpen).k === k) return false;
      return true;
    });
    open.sort(function (a, b) { return ((ext[b] as number) - (ext[a] as number)) || (MD_MARKS.indexOf(a) - MD_MARKS.indexOf(b)); });
    open.forEach(function (k) {
      const pair = pairs++;
      const v = piece.m[k] as MdValue;
      tokens.push({ open: k, v: v, pair: pair });
      stack.push({ k: k, v: v, pair: pair });
    });
    tokens.push({ text: piece.text });
  });
  while (stack.length) tokens.push(mdClose(stack.pop() as MdOpen));
  return tokens;
}

function mdClose(open: MdOpen): MdToken {
  return { close: open.k, v: open.v, pair: open.pair };
}

function mdRender(tokens: readonly MdToken[], asHtml: Record<number, true>): string[] {
  let linkDepth = 0;
  return tokens.map(function (t) {
    if (t.text !== undefined) return linkDepth ? t.text.replace(/([[\]()])/g, "\\$1") : t.text;
    const k = (t.open || t.close) as MdMark;
    if (k === "href") {
      if (t.open) { linkDepth++; return "["; }
      linkDepth--;
      return "](" + t.v + ")";
    }
    if (MD_DELIM[k] && !asHtml[t.pair]) return MD_DELIM[k];
    return t.open ? "<" + MD_HTML[k] + ">" : "</" + MD_HTML[k] + ">";
  });
}

function mdFlank(prev: string | null, next: string | null): MdFlank {
  const wsPrev = prev === null || MD_WS.test(prev), wsNext = next === null || MD_WS.test(next);
  const pPrev = !wsPrev && MD_PUNCT.test(prev as string), pNext = !wsNext && MD_PUNCT.test(next as string);
  return { left: !wsNext && (!pNext || wsPrev || pPrev), right: !wsPrev && (!pPrev || wsNext || pNext) };
}

function mdRuns(tokens: readonly MdToken[], strs: readonly string[], asHtml: Record<number, true>): MdRun[] {
  const runOf: MdRun[] = [];
  for (let i = 0; i < tokens.length;) {
    const ti = tokens[i] as MdToken;
    const k = (ti.open || ti.close) as MdMark;
    if (!MD_DELIM[k] || asHtml[ti.pair as number]) { i++; continue; }
    const ch = MD_DELIM[k].charAt(0);
    let j = i, len = 0, closes = false;
    while (j < tokens.length) {
      const u = tokens[j] as MdToken, uk = (u.open || u.close) as MdMark;
      const delim = MD_DELIM[uk];
      if (!delim || asHtml[u.pair as number] || delim.charAt(0) !== ch) break;
      len += delim.length;
      if (u.close) closes = true;
      j++;
    }
    const prev = i > 0 ? (/[\s\S]$/u.exec(strs[i - 1] as string) as RegExpExecArray)[0] : null;
    const next = j < strs.length ? (/^[\s\S]/u.exec(strs[j] as string) as RegExpExecArray)[0] : null;
    const asText = mdFlank(prev, next);
    const asBr = mdFlank(prev === "\n" ? ">" : prev, next === "\n" ? "<" : next);
    const run: MdRun = {
      ch: ch, len: len, closes: closes,
      left: asText.left && asBr.left,
      right: asText.right && asBr.right,
      both: (asText.left && asText.right) || (asBr.left && asBr.right)
    };
    for (let c = i; c < j; c++) runOf[c] = run;
    i = j;
  }
  return runOf;
}

function mdRuleOf3(a: MdRun, b: MdRun): boolean {
  return (a.both || b.both) && (a.len + b.len) % 3 === 0 && !(a.len % 3 === 0 && b.len % 3 === 0);
}

function mdSettle(tokens: readonly MdToken[]): string {
  const asHtml: Record<number, true> = {};
  for (;;) {
    const strs = mdRender(tokens, asHtml);
    const runOf = mdRuns(tokens, strs, asHtml);
    const openRun: Record<number, MdRun> = {}, outer: Record<string, MdRun[]> = { "*": [], "~": [] };
    let bad: number | null = null, badPairing: number | null = null;
    for (let i = 0; i < tokens.length && bad === null; i++) {
      const t = tokens[i] as MdToken, run = runOf[i];
      if (!run) continue;
      const nest = outer[run.ch] as MdRun[];
      if (t.open) {
        const out = nest[nest.length - 1];
        if (!run.left || run.closes) bad = t.pair;
        else if (badPairing === null && run.both && out && !mdRuleOf3(run, out)) badPairing = t.pair;
        openRun[t.pair] = run;
        nest.push(run);
      } else {
        const pair = t.pair as number;
        nest.pop();
        if (!run.right) bad = pair;
        else if (badPairing === null && mdRuleOf3(openRun[pair] as MdRun, run)) badPairing = pair;
      }
    }
    if (bad === null) bad = badPairing;
    if (bad === null) return strs.join("");
    asHtml[bad] = true;
  }
}

export function toMarkdown(cell: CellInput): string {
  return mdSettle(mdTokens(cell)).replace(/\n{3,}/g, "\n\n").trim();
}

export function toDocxRuns(cell: CellInput, opts?: DocxOptions | null): DocxRun[] {
  const t = buildTree(cell, opts);
  const annotate = !!(opts && opts.annotate);
  const runs: DocxRun[] = [];
  (function walk(node: TreeParent, fmt: DocxFormat): void {
    node.kids.forEach(function (n) {
      if (n.text !== undefined || n.atom) {
        const text = (n.atom ? n.atom.text : n.text).replace(/\u00a0/g, " ");
        if (!text) return;
        const run: DocxRun = { text: text, b: fmt.b, i: fmt.i, u: fmt.u, s: fmt.s, mark: fmt.mark, href: fmt.href };
        if (fmt.dir) run.dir = true;
        if (fmt.cue) run.cue = true;
        if (annotate) {
          if (fmt.tag) run.tag = fmt.tag;
          if (fmt.cmt.length) run.cmt = fmt.cmt.slice();
          if (n.atom && n.atom.atom === "broll") run.broll = n.atom.id;
        }
        runs.push(run);
        return;
      }
      if (n.br) { runs.push(fmt.dir ? { text: "\n", dir: true } : { text: "\n" }); return; }
      const k = n.el.k;
      walk(n, {
        b: fmt.b || k === "b", i: fmt.i || k === "i", u: fmt.u || k === "u", s: fmt.s || k === "s",
        mark: fmt.mark || k === "hl", href: k === "href" ? n.el.v as string : fmt.href, dir: fmt.dir || k === "dir",
        cue: fmt.cue || k === "cue",
        tag: k === "tag" ? t.tagOf(n.el.v as string) : fmt.tag,
        cmt: k === "cmt" ? fmt.cmt.concat(n.el.v as string) : fmt.cmt
      });
    });
  })(t.root, { b: false, i: false, u: false, s: false, mark: false, href: null, dir: false, cue: false, tag: null, cmt: [] });
  return bracketDirections(runs);
}

function bracketDirections(runs: DocxRun[]): DocxRun[] {
  if (!runs.some(function (r) { return r.dir; })) return runs;
  function bracket(ch: string): DocxRun {
    return { text: ch, b: false, i: false, u: false, s: false, mark: false, href: null, dir: true };
  }
  const out: DocxRun[] = [];
  runs.forEach(function (r, i) {
    const starts = r.dir && !(runs[i - 1] && (runs[i - 1] as DocxRun).dir);
    const ends = r.dir && !(runs[i + 1] && (runs[i + 1] as DocxRun).dir);
    if (starts) out.push(bracket("("));
    out.push(r);
    if (ends) out.push(bracket(")"));
  });
  return out;
}
