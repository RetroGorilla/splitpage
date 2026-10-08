import { BROLL_MARKER_RE } from "../document/broll.ts";
import { safeHref, withoutLoneSurrogates } from "../document/text-policy.ts";
import type { TagName } from "../document/tags.ts";

export const FORMAT_MARKS = Object.freeze(["hl", "b", "i", "u", "s"] as const);

export type FormatMark = (typeof FORMAT_MARKS)[number];

export const OBJ = "\uFFFC";

export type Marks = {
  b?: true;
  i?: true;
  u?: true;
  s?: true;
  hl?: true;
  dir?: true;
  cue?: true;
  href?: string;
  tag?: string;
  cmt?: readonly string[];
};

export type MarkName = keyof Marks;

export type TextRun = { atom?: undefined; text: string; marks: Marks };

export type BrollRun = { atom: "broll"; id: string; text: string; marks: Marks };

export type Run = TextRun | BrollRun;

export type RunInput = { atom?: unknown; id?: unknown; text?: unknown; marks?: unknown };

export type CellInput = readonly (RunInput | null | undefined)[] | null | undefined;

export type NormalizeOptions = {
  hasTag?: ((id: string) => boolean) | undefined;
  hasComment?: ((id: string) => boolean) | undefined;
};

export function defaultTagId(cat: string, name: string): string { return "t:" + cat + ":" + name; }

export function defaultTagOf(id: unknown): TagName | null {
  const m = /^t:([a-z]+):([\s\S]+)$/.exec(String(id));
  return m ? { cat: m[1] as string, name: m[2] as string } : null;
}

export function tagNameOf(id: unknown): TagName | null {
  return defaultTagOf(id);
}

export function namedTagId(cat: string, name: string): string {
  return defaultTagId(cat, name);
}

function cellChars(t: unknown): string {
  return String(t == null ? "" : t).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/g, "");
}

export function cleanText(t: unknown): string {
  return withoutLoneSurrogates(cellChars(t));
}

function holdsLoneSurrogate(r: Run): boolean {
  return !r.atom && withoutLoneSurrogates(r.text) !== r.text;
}

function withoutLoneHalves(r: Run): Run {
  return r.atom ? r : { text: withoutLoneSurrogates(r.text), marks: r.marks };
}

export function cleanMarks(marks: unknown, forAtom?: boolean): Marks {
  const out: Marks = {};
  if (!marks || typeof marks !== "object") return out;
  const m = marks as Record<string, unknown>;
  FORMAT_MARKS.forEach(function (k) { if (m[k] === true) out[k] = true; });
  if (!forAtom && m.dir === true) out.dir = true;
  if (!forAtom && m.cue === true) out.cue = true;
  if (typeof m.href === "string") {
    const href = safeHref(m.href);
    if (href) out.href = href;
  }
  if (!forAtom && typeof m.tag === "string" && m.tag) out.tag = m.tag;
  if (Array.isArray(m.cmt)) {
    let ids = (m.cmt as unknown[]).filter(function (id) { return typeof id === "string" && id; }) as string[];
    ids = ids.filter(function (id, i) { return ids.indexOf(id) === i; }).sort();
    if (ids.length) out.cmt = ids;
  }
  return out;
}

export function sameMarks(a: Marks, b: Marks): boolean {
  const ka = Object.keys(a) as MarkName[], kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i] as MarkName;
    if (k === "cmt") {
      const ac = a.cmt as readonly string[];
      if (!b.cmt || ac.length !== b.cmt.length) return false;
      for (let j = 0; j < ac.length; j++) if (ac[j] !== b.cmt[j]) return false;
    } else if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

export function orderedMarks(m: Marks): Marks {
  const out: Record<string, unknown> = {};
  (["b", "i", "u", "s", "hl", "dir", "cue", "href", "tag", "cmt"] as const).forEach(function (k) { if (m[k] !== undefined) out[k] = m[k]; });
  return out as Marks;
}

export const CUE_LINE_RE = /^[ \t\u00a0]*(sfx|music)[ \t\u00a0]*:/i;

export function isCueRun(r: Run | null | undefined): boolean { return !!(r && !r.atom && r.marks.cue); }

export function isDirRun(r: Run | null | undefined): boolean { return !!(r && !r.atom && r.marks.dir); }

export function normalizeCell(cell: CellInput, opts?: NormalizeOptions | null): Run[] {
  opts = opts || {};
  let runs: Run[] = [];
  (Array.isArray(cell) ? cell as readonly (RunInput | null | undefined)[] : []).forEach(function (r) {
    if (!r || typeof r !== "object") return;
    if (r.atom === "broll") {
      const text = cleanText(r.text).replace(/\n/g, " ").trim();
      const id = String(r.id == null ? "" : r.id).replace(/[^A-Za-z0-9_-]/g, "");
      const am = cleanMarks(r.marks, true);
      if (opts.hasComment && am.cmt) am.cmt = am.cmt.filter(opts.hasComment);
      if (am.cmt && !am.cmt.length) delete am.cmt;
      if (id && BROLL_MARKER_RE.test(text)) {
        runs.push({ atom: "broll", id: id, text: text, marks: orderedMarks(am) });
      } else if (text) {
        runs.push({ text: text, marks: am });
      }
      return;
    }
    const t = cellChars(r.text);
    if (!t) return;
    const m = cleanMarks(r.marks, false);
    if (opts.hasTag && m.tag && !opts.hasTag(m.tag)) delete m.tag;
    if (opts.hasComment && m.cmt) {
      m.cmt = m.cmt.filter(opts.hasComment);
      if (!m.cmt.length) delete m.cmt;
    }
    runs.push({ text: t, marks: m });
  });

  let j: number, k: number;
  for (let i = 0; i < runs.length;) {
    const tag = (runs[i] as Run).atom ? null : (runs[i] as Run).marks.tag;
    if (!tag) { i++; continue; }
    j = i;
    while (j < runs.length && !(runs[j] as Run).atom && (runs[j] as Run).marks.tag === tag) j++;
    if (j - i > 1) {
      const cmt: string[] = [];
      let href: string | null = null, dir = false;
      for (k = i; k < j; k++) {
        const marks = (runs[k] as Run).marks;
        (marks.cmt || []).forEach(function (c) { if (cmt.indexOf(c) === -1) cmt.push(c); });
        if (!href && marks.href) href = marks.href;
        if (marks.dir) dir = true;
      }
      cmt.sort();
      for (k = i; k < j; k++) {
        const marks = (runs[k] as Run).marks;
        if (cmt.length) marks.cmt = cmt.slice(); else delete marks.cmt;
        if (href) marks.href = href; else delete marks.href;
        if (dir) marks.dir = true;
      }
    }
    i = j;
  }

  runs = settleCues(runs);

  const out: Run[] = [];
  runs.forEach(function (r) {
    if (!r.atom) r.marks = orderedMarks(r.marks);
    const last = out[out.length - 1];
    if (!r.atom && last && !last.atom && sameMarks(last.marks, r.marks)) {
      last.text += r.text;
    } else {
      out.push(r);
    }
  });
  return out.some(holdsLoneSurrogate) ? normalizeCell(out.map(withoutLoneHalves), opts) : out;
}

export function settleCues(runs: Run[]): Run[] {
  if (!runs.some(isCueRun)) return runs;
  const out: Run[] = [];
  let line: Run[] = [];
  function flush(): void {
    if (line.some(isCueRun)) {
      const text = line.map(function (p) { return p.atom ? OBJ : p.text; }).join("");
      const on = CUE_LINE_RE.test(text);
      line.forEach(function (p) {
        if (p.atom) return;
        if (on) p.marks.cue = true; else delete p.marks.cue;
      });
    }
    out.push(...line);
    line = [];
  }
  runs.forEach(function (r) {
    if (r.atom) { line.push(r); return; }
    r.text.split(/(\n)/).forEach(function (t) {
      if (!t) return;
      const piece: TextRun = { text: t, marks: Object.assign({}, r.marks) };
      if (t === "\n") {
        flush();
        delete piece.marks.cue;
        out.push(piece);
      } else {
        line.push(piece);
      }
    });
  });
  flush();
  return out;
}

export function projection(cell: CellInput): string {
  let out = "";
  normalizeCell(cell).forEach(function (r) { out += r.atom ? OBJ : r.text; });
  return out;
}

export function cellLength(cell: CellInput): number {
  return projection(cell).length;
}

export function commentIds(cell: CellInput): string[] {
  const ids: string[] = [];
  normalizeCell(cell).forEach(function (r) {
    (r.marks.cmt || []).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
  });
  return ids.sort();
}

export function tagIds(cell: CellInput): string[] {
  const ids: string[] = [];
  normalizeCell(cell).forEach(function (r) {
    if (!r.atom && r.marks.tag && ids.indexOf(r.marks.tag) === -1) ids.push(r.marks.tag);
  });
  return ids;
}

export function sameCell(a: CellInput, b: CellInput): boolean {
  return JSON.stringify(normalizeCell(a)) === JSON.stringify(normalizeCell(b));
}
