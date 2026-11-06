import { deleteRange, explode, implode, clampRange } from "./edits.ts";
import type { EditedCell } from "./edits.ts";
import { isWhoRun, normalizeCell, whoName } from "./runs.ts";
import type { CellInput, Marks, Run } from "./runs.ts";

export type WhoSentence = { tags: string[]; names: string[] };

const BOUNDARY_BEFORE_RE = /[\s\p{P}]/u;
const PUNCT_RE = /\p{P}/u;
const SENTENCE_END_RE = /[.!?]/;
const SENTENCE_CLOSER_RE = /["'’”)\]]/;
const SPACE_RE = /[ \t\xA0]/;

export function startsWho(before: string): boolean {
  if (!before) return true;
  return BOUNDARY_BEFORE_RE.test(before.charAt(before.length - 1));
}

export function insertWho(cell: CellInput, from: number, to: number, name: string, marks?: Marks): EditedCell | null {
  const clean = whoName(name);
  if (!clean) return null;
  const r = clampRange(cell, from, to);
  const chars = explode(deleteRange(cell, r.from, r.to));
  const atom = { atom: "who" as const, name: clean, text: "@" + clean, marks: marks || {} };
  return { cell: implode(chars.slice(0, r.from).concat([{ atom: atom }], chars.slice(r.from))), end: r.from + 1 };
}

function plainStart(r: Run | undefined): string | null {
  return !r || r.atom || r.marks.tag ? null : r.text.charAt(0);
}

export function withoutWho(cell: CellInput): Run[] {
  const runs = normalizeCell(cell);
  if (!runs.some(isWhoRun)) return runs;
  const chars = explode(runs);
  const out: typeof chars = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!c) continue;
    if (!c.atom || c.atom.atom !== "who") { out.push(c); continue; }
    const prev = out[out.length - 1];
    const next = chars[i + 1];
    const nextBlank = !next || next.atom || next.ch === "\n" || SPACE_RE.test(next.ch) || PUNCT_RE.test(next.ch);
    if (prev && !prev.atom && SPACE_RE.test(prev.ch) && !prev.marks.tag && nextBlank) out.pop();
    else if ((!prev || (!prev.atom && prev.ch === "\n")) && next && !next.atom && SPACE_RE.test(next.ch)) i++;
  }
  return implode(out);
}

export function whoSentences(cell: CellInput): WhoSentence[] {
  const runs = normalizeCell(cell);
  if (!runs.some(isWhoRun)) return [];
  const out: WhoSentence[] = [];
  let cur: WhoSentence = { tags: [], names: [] };
  function flush(): void {
    if (cur.names.length) out.push(cur);
    cur = { tags: [], names: [] };
  }
  runs.forEach(function (r, ri) {
    if (isWhoRun(r)) { cur.names.push(r.name); return; }
    if (r.atom) return;
    if (r.marks.tag) { if (cur.tags.indexOf(r.marks.tag) === -1) cur.tags.push(r.marks.tag); return; }
    const text = r.text;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch === "\n") { flush(); continue; }
      if (!SENTENCE_END_RE.test(ch)) continue;
      let j = i + 1;
      while (j < text.length && SENTENCE_CLOSER_RE.test(text.charAt(j))) j++;
      const after = j < text.length ? text.charAt(j) : plainStart(runs[ri + 1]);
      if (after === null ? !runs[ri + 1] : /\s/.test(after)) {
        i = j - 1;
        flush();
      }
    }
  });
  flush();
  return out;
}
