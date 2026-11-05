import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutLoneSurrogates } from "../../../src/core/document/text-policy.ts";
import { countInTags, findInCell } from "../../../src/core/text/search.ts";
import { endsSentence } from "../../../src/core/text/sentences.ts";
import type { Run } from "../../../src/core/text/runs.ts";

type SearchPiece = { start: number; text: string };
type TaggedPiece = SearchPiece & { tag: string };
type SearchPieces = { free: SearchPiece[]; tagged: TaggedPiece[] };
function escapeRegExpLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAllMatches(text: string, needle: string, matchCase: boolean) {
  needle = withoutLoneSurrogates(needle);
  if (!needle) return [];
  const re = new RegExp(escapeRegExpLiteral(needle), matchCase ? "g" : "gi");
  const out: { start: number; end: number }[] = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function searchablePieces(cell: readonly Run[]) {
  const free: SearchPiece[] = [], tagged: TaggedPiece[] = [];
  let pos = 0, cur: SearchPiece | null = null, curTag: TaggedPiece | null = null;
  cell.forEach(function (r) {
    if (r.atom) { cur = null; curTag = null; pos += 1; return; }
    const tag = r.marks.tag;
    if (tag) {
      cur = null;
      if (curTag && curTag.tag === tag) curTag.text += r.text;
      else tagged.push(curTag = { tag: tag, start: pos, text: r.text });
    } else {
      curTag = null;
      if (cur) cur.text += r.text;
      else free.push(cur = { start: pos, text: r.text });
    }
    pos += r.text.length;
  });
  return { free: free, tagged: tagged };
}

function baseFindInCell(cell: readonly Run[], needle: string, matchCase: boolean) {
  if (!needle) return [];
  return matchesInPieces(searchablePieces(cell), needle, matchCase);
}

function matchesInPieces(pieces: SearchPieces, needle: string, matchCase: boolean) {
  const out: { from: number; to: number }[] = [];
  pieces.free.forEach(function (p) {
    findAllMatches(p.text, needle, matchCase).forEach(function (m) {
      out.push({ from: p.start + m.start, to: p.start + m.end });
    });
  });
  return out;
}

function baseCountInTags(cell: readonly Run[], needle: string, matchCase: boolean) {
  if (!needle) return 0;
  return countInPieces(searchablePieces(cell), needle, matchCase);
}

function countInPieces(pieces: SearchPieces, needle: string, matchCase: boolean) {
  return pieces.tagged.reduce(function (n, p) {
    return n + findAllMatches(p.text, needle, matchCase).length;
  }, 0);
}


test("seeded differential: extracted Find matches the base on 1000 cells and queries", () => {
  for (let seed = 1; seed <= 1000; seed++) {
    let state = seed;
    const pick = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    const cell: Run[] = [];
    const pieces = ["Alpha", "beta ", "??", "?i", "[.*]", "a", "\ud800", " "];
    for (let i = 0, count = 1 + pick(12); i < count; i++) {
      if (pick(5) === 0) cell.push({ atom: "broll", id: "bs1", text: "", marks: {} });
      else cell.push({ text: pieces[pick(pieces.length)] as string, marks: pick(3) === 0 ? { tag: "prop:Desk" } : pick(2) ? { b: true } : {} });
    }
    const needle = pieces[pick(pieces.length)] as string;
    const matchCase = !!pick(2);
    assert.deepEqual(findInCell(cell, needle, matchCase), baseFindInCell(cell, needle, matchCase), "seed=" + seed);
    assert.equal(countInTags(cell, needle, matchCase), baseCountInTags(cell, needle, matchCase), "seed=" + seed);
  }
});

const BASE_SENTENCE_END_RE = /[.!?]["'\u2019\u201d)\]]*$/;

test("R2-C: the frozen sentence oracle recognizes smart closing quotes", () => {
  assert.equal(BASE_SENTENCE_END_RE.test("Text.\u2019"), true);
  assert.equal(BASE_SENTENCE_END_RE.test("Text.\u201d"), true);
});

test("seeded differential: sentence endings match the teleprompter's base definition", () => {

  const endings = [".", "!", "?", "...", ".\u2019", ".\u201d", "?)", "x", "", " ", "\n", "']", "\u3002", "\u2019", "\u201d"];
  for (let seed = 1; seed <= 1000; seed++) {
    const text = "Text" + endings[seed % endings.length] + endings[Math.floor(seed / endings.length) % endings.length];
    assert.equal(endsSentence(text), BASE_SENTENCE_END_RE.test(text), "seed=" + seed);
  }
});
