import type { BrollRun, Marks, Run, TextRun } from "../../../src/core/text/runs.ts";

export const NBSP = "\u{A0}";
export const ZWSP = "\u{200B}";
export const ZWJ = "\u{200D}";
export const OBJ = "\u{FFFC}";
export const GRIN = "\u{1F600}";
export const COMBINED_E = "e\u{301}";
export const TECHNOLOGIST = "\u{1F469}\u{200D}\u{1F4BB}";
export const THUMB = "\u{1F44D}\u{1F3FD}";
export const SHALOM = "\u{5E9}\u{5DC}\u{5D5}\u{5DD}";

export function T(text: string, marks?: Marks): TextRun {
  return { text: text, marks: marks || {} };
}

export function B(id: string, text?: string, marks?: Marks): BrollRun {
  return { atom: "broll", id: id, text: text || "B-roll:", marks: marks || {} };
}

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const WORDS = [
  "the", "red", "mug", "a" + NBSP + "b", "line\nbreak", " ", "  ", "\u{E9}", "x<y", "&", "\n", "tab\t",
  GRIN, COMBINED_E, TECHNOLOGIST, THUMB, SHALOM, "(aside)", "sfx: rain", "music:"
];

export function randomCell(r: () => number): Run[] {
  const n = Math.floor(r() * 12);
  const cell: Run[] = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.07) {
      cell.push(B("bs" + Math.floor(r() * 3), r() < 0.5 ? "B-roll:" : "b-roll -", r() < 0.3 ? { b: true, cmt: ["c1"] } : {}));
      continue;
    }
    const m: Marks = {};
    if (r() < 0.3) m.b = true;
    if (r() < 0.2) m.i = true;
    if (r() < 0.1) m.u = true;
    if (r() < 0.1) m.s = true;
    if (r() < 0.1) m.hl = true;
    if (r() < 0.1) m.dir = true;
    if (r() < 0.1) m.cue = true;
    if (r() < 0.1) m.href = "https://e.x/" + Math.floor(r() * 2);
    if (r() < 0.2) m.tag = "t:prop:Item " + Math.floor(r() * 2);
    if (r() < 0.25) m.cmt = ["c" + Math.floor(r() * 3)].concat(r() < 0.3 ? ["c9"] : []);
    cell.push(T((WORDS[Math.floor(r() * WORDS.length)] as string) + (r() < 0.5 ? " " : ""), m));
  }
  return cell;
}

export function randomCells(seed: number, count: number): Run[][] {
  const r = rng(seed);
  const out: Run[][] = [];
  for (let i = 0; i < count; i++) out.push(randomCell(r));
  return out;
}
