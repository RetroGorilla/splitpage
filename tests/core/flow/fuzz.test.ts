import { test } from "node:test";
import assert from "node:assert/strict";
import { createRichText } from "../../../src/adapters/richtext/richtext.ts";
import { createImageIngestion } from "../../../src/core/document/media.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { scenesInOrder } from "../../../src/core/document/scenes.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { cellLength, projection } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import {
  backspaceAt, beatPos, caretAt, comparePos, deleteForwardAt, enterAt, enterInHeading, flowOf, headingPos, insertBeats,
  joinWithPrevious, lineBreakAt, moveBeats, pasteText, replaceMatch, replaceRange,
  selectionToOwnBeat, setMarkAcross, startBeat, startParagraph, typeWithMarks
} from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowPos, FlowRow } from "../../../src/core/flow/flow.ts";
import { flowCommand } from "../../../src/application/commands/flow.ts";
import { createUndo } from "../../../src/application/editing/undo/undo.ts";
import { syncCommentAnchors } from "../../../src/core/text/anchors.ts";
import { jsdomParser } from "../../adapters/richtext/jsdom.mjs";
import { countingIds, migratedThenSet } from "../migrate-ports.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";

const rich = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(() => null), ids: countingIds() });
const cells = rich.createCellReader(deepFreeze, { media: true });
const stamps = { clock: { nowIso: () => "2026-11-04T12:00:00.000Z" }, editor: { name: () => "Editor" } };

function random(seed: number): (limit: number) => number {
  let state = seed;
  return limit => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
}

function fixture(seed: number): { doc: FlowDoc; pick: (limit: number) => number; ports: FlowPorts } {
  const pick = random(seed);
  const rows: FlowRow[] = [];
  const comments: { id: string; rowId: string; field: string; body: string; kind: string; anchorId: string }[] = [];
  for (let i = 0, count = 1 + pick(10); i < count; i++) {
    const id = "r" + i, cmt = "c" + i;
    const text = ["", "Alpha beta.", "Two words", "Third!", "x\ny", " leading ", "A😀B?"][pick(7)] as string;
    const runs: Run[] = text ? [{ text, marks: { ...(pick(2) ? { b: true } : {}), ...(pick(2) ? { cmt: [cmt] } : {}) } }] : [];
    const audioText = toHtml(runs);
    rows.push({ id, audioText, visualText: pick(2) ? "Street" : "", status: ["todo", "ready", "shot"][pick(3)],
      ...(pick(3) === 0 ? { paragraphStart: true } : {}) });
    comments.push({ id: cmt, rowId: id, field: "audioText", body: "Keep", kind: "anchor", anchorId: cmt });
  }
  const sections = rows.filter((_, i) => i === 0 || pick(4) === 0).map((row, i) => ({ id: "s" + i, name: "Scene " + i, firstSceneId: row.id }));
  let next = 0;
  return { doc: { rows, sections: pick(2) ? sections : undefined, comments }, pick,
    ports: { cells, newId: () => "n" + seed + "-" + (++next), hasVisual: row => !!row.visualText || !!row.imageRef } };
}

function applied(doc: FlowDoc, outcome: FlowOutcome): FlowDoc {
  if (!outcome || !("rows" in outcome)) return doc;
  return { rows: outcome.rows, sections: outcome.sections, comments: doc.comments.filter(c => !outcome.removedComments.includes(c.id)) };
}

function structural(doc: FlowDoc): void {
  assert.ok(doc.rows.length);
  assert.equal(new Set(doc.rows.map(row => row.id)).size, doc.rows.length);
  const rendered = flowOf(doc);
  assert.deepEqual(rendered.flatMap(block => block.kind === "paragraph" ? block.beats.map(row => row.id) : []), doc.rows.map(row => row.id));
  for (const block of rendered) if (block.kind === "paragraph") assert.ok(block.beats.length);
  for (const scene of scenesInOrder(doc) ?? []) assert.ok(doc.rows.some(row => row.id === scene.firstSceneId));
  if (Array.isArray(doc.sections)) {
    const sections = doc.sections as { id: string; firstSceneId: string }[];
    assert.equal(new Set(sections.map(scene => scene.firstSceneId)).size, sections.length);
    for (const scene of sections) assert.ok(doc.rows.some(row => row.id === scene.firstSceneId), "raw scene anchor " + scene.id);
    assert.equal(sections.length, scenesInOrder(doc)?.length ?? 0, "no scene silently normalized away");
  }
  assert.ok(!JSON.stringify(doc.rows).includes("\u200b"));
}

function content(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => key === "updatedAt" || key === "updatedBy" ? undefined : item)) as unknown;
}

function offsets(row: FlowRow): number[] {
  const out = [0];
  for (const point of projection(cells(row.audioText))) out.push((out[out.length - 1] as number) + point.length);
  return out;
}

test("seeded flow: 240 documents × 16 operations preserve structure, outside text and real session undo", t => {
  const started = performance.now();
  let cases = 0;
  for (let seed = 1; seed <= 240; seed++) {
    for (let operation = 0; operation < 16; operation++) {
      try {
        const { doc, pick, ports } = fixture(seed);
        const a = pick(doc.rows.length), b = a + pick(doc.rows.length - a);
        const first = doc.rows[a] as FlowRow, last = doc.rows[b] as FlowRow;
        const starts = offsets(first);
        const from = starts[pick(starts.length)] as number;
        const ends = offsets(last).filter(offset => a !== b || offset >= from);
        const to = ends[pick(ends.length)] as number;
        const range = pick(2) ? { anchor: beatPos(first.id, from), head: beatPos(last.id, to) }
          : { anchor: beatPos(last.id, to), head: beatPos(first.id, from) };
        const pos = beatPos(first.id, from);
        const operations: ((current: FlowDoc) => FlowOutcome)[] = [
          current => replaceRange(current, range, [{ text: "Q\u200b", marks: {} }], ports),
          current => setMarkAcross(current, range, "i", ports),
          current => startParagraph(current, pos, ports),
          current => startBeat(current, pos, ports),
          current => enterAt(current, caretAt(pos), ports),
          current => lineBreakAt(current, range, ports),
          current => pasteText(current, range, ["First", "Second"], ports),
          current => selectionToOwnBeat(current, { anchor: pos, head: beatPos(first.id, cellLength(cells(first.audioText))) }, ports),
          current => joinWithPrevious(current, first.id, ports),
          current => backspaceAt(current, beatPos(first.id, 0), ports, { tick: "delete" }),
          current => deleteForwardAt(current, beatPos(first.id, cellLength(cells(first.audioText))), ports),
          current => replaceMatch(current, range, "Q", ports),
          current => insertBeats(current, pos, [{ id: "inserted", audioText: "New", visualText: "Visual" }], ports),
          current => moveBeats(current, [last.id], pos, ports),
          current => typeWithMarks(current, pos, "Q\u200b", { u: true }, ports),
          current => replaceRange(current, range, [], ports)
        ];
        const run = operations[operation] as (current: FlowDoc) => FlowOutcome;
        const original = JSON.stringify(doc);
        const result = run(doc);
        const next = applied(doc, result);
        assert.equal(JSON.stringify(doc), original, "pure input");
        structural(next);
        if (result && "rows" in result) {
          const rows = new Map(result.rows.map(row => [row.id, row]));
          if ([0, 1, 5, 6, 11, 15].includes(operation)) {
            for (let i = 0; i < doc.rows.length; i++) {
              const old = doc.rows[i] as FlowRow;
              if (i < a || i > b) assert.equal(rows.get(old.id)?.audioText, old.audioText, "outside range and id");
            }
            if (rows.has(first.id)) assert.equal(projection(cells(rows.get(first.id)?.audioText)).slice(0, from), projection(cells(first.audioText)).slice(0, from));
            if (rows.has(last.id) && ![5, 6].includes(operation)) assert.ok(projection(cells(rows.get(last.id)?.audioText)).endsWith(projection(cells(last.audioText)).slice(to)));
          }
          if ([0, 15].includes(operation)) {
            const expected = doc.rows.filter((row, i) => {
              if (a === b || i < a || i > b) return true;
              const length = cellLength(cells(row.audioText));
              const left = i === a ? from : 0, right = i === b ? to : length;
              return (i === a || i === b) && left === right || !(left === 0 && right === length) || (operation === 0 && i === a);
            }).map(row => row.id);
            if (expected.length) assert.deepEqual(next.rows.map(row => row.id), expected, "only fully selected beats removed");
          } else if ([1, 11, 14].includes(operation)) {
            assert.deepEqual(next.rows.map(row => row.id), doc.rows.map(row => row.id));
          } else if (operation === 13) {
            assert.deepEqual(next.rows.filter(row => doc.rows.some(old => old.id === row.id)).map(row => row.id).sort(), doc.rows.map(row => row.id).sort());
            assert.ok(next.rows.length <= doc.rows.length + 1, "only the destination split adds a beat");
          }
        }
        const h = harness(undefined, { entry: () => migratedThenSet(doc), reconcile: live => syncCommentAnchors(live, cells),
          record: () => { undo.noteEdit(); undo.flush(); } });
        h.session.adopt({});
        const undo = createUndo({ held: h.session.held, runs: html => cells(String(html ?? "")), now: () => 1000, cleared: () => {} });
        undo.adopt(h.session.held());
        const unroute = undo.routeReplays(h.session.replay, null);
        const before = content(h.session.held());
        const out = runConfined(h.session, flowCommand("flow-fuzz", run, stamps));
        assert.ok(["applied", "noop", "rejected"].includes(out.kind), JSON.stringify(out));
        if (out.kind === "applied" && JSON.stringify(content(h.session.held())) !== JSON.stringify(before)) {
          const after = content(h.session.held());
          assert.equal(undo.sizes().undo, 1);
          assert.equal(undo.undo().ok, true);
          assert.deepEqual(content(h.session.held()), before, "undo content and structure");
          assert.equal(undo.redo().ok, true);
          assert.deepEqual(content(h.session.held()), after, "redo content and structure");
        }
        unroute();
        h.session.dispose();
        cases++;
      } catch (error) {
        throw new Error("seed=" + seed + " operation=" + operation, { cause: error });
      }
    }
  }
  t.diagnostic(cases + " cases in " + (performance.now() - started).toFixed(0) + " ms; seeds 1..240");
});

test("seed 10 regression: a range line break never edits the beat before the range", () => {
  const { ports } = fixture(10);
  const doc: FlowDoc = { rows: [{ id: "a", audioText: "Before" }, { id: "b", audioText: "Chosen" }, { id: "c", audioText: "After" }], comments: [] };
  const next = applied(doc, lineBreakAt(doc, { anchor: beatPos("b", 0), head: beatPos("c", 0) }, ports));
  assert.equal(next.rows[0]?.audioText, "Before");
  assert.equal(next.rows.find(row => row.id === "c")?.audioText, "After");
  assert.equal(projection(cells(next.rows[1]?.audioText)), "\n");
});

test("seed 51 regression: pasted paragraphs cannot insert into the next unselected beat", () => {
  const { ports } = fixture(51);
  const doc: FlowDoc = { rows: [{ id: "a", audioText: "Chosen" }, { id: "b", audioText: "After" }], comments: [] };
  const next = applied(doc, pasteText(doc, { anchor: beatPos("a", 0), head: beatPos("a", 6) }, ["First", "Second"], ports));
  assert.equal(next.rows.find(row => row.id === "b")?.audioText, "After");
  assert.deepEqual(next.rows.map(row => projection(cells(row.audioText))), ["First", "Second", "After"]);
});

test("seeded headings and block moves: 1200 ranges preserve raw scene anchors and outside words", t => {
  const started = performance.now();
  for (let seed = 1; seed <= 240; seed++) {
    const { doc, pick, ports } = fixture(seed);
    const positions: FlowPos[] = doc.rows.flatMap(row => offsets(row).map(offset => beatPos(row.id, offset)));
    for (const scene of scenesInOrder(doc) ?? []) {
      positions.push(headingPos(scene.id, 0), headingPos(scene.id, 2), headingPos(scene.id, scene.name.length));
    }
    const anchor = positions[pick(positions.length)] as FlowPos, head = positions[pick(positions.length)] as FlowPos;
    const range = { anchor, head };
    const a = pick(doc.rows.length), b = a + pick(doc.rows.length - a);
    const operations = [
      () => replaceRange(doc, range, [], ports),
      () => replaceRange(doc, range, [{ text: "New", marks: {} }], ports),
      () => pasteText(doc, caretAt(anchor), ["First", "Second"], ports),
      () => enterInHeading(doc, anchor, ports),
      () => moveBeats(doc, doc.rows.slice(a, b + 1).map(row => row.id), head, ports)
    ];
    for (let operation = 0; operation < operations.length; operation++) {
      try {
        const next = applied(doc, (operations[operation] as () => FlowOutcome)());
        structural(next);
        if (operation <= 1) {
          const from = comparePos(doc, anchor, head) < 0 ? anchor : head;
          const to = from === anchor ? head : anchor;
          for (const row of doc.rows) {
            if (comparePos(doc, beatPos(row.id, cellLength(cells(row.audioText))), from) < 0 || comparePos(doc, beatPos(row.id, 0), to) > 0) {
              assert.equal(next.rows.find(beat => beat.id === row.id)?.audioText, row.audioText);
            }
          }
        }
      } catch (error) {
        throw new Error("heading seed=" + seed + " operation=" + operation, { cause: error });
      }
    }
  }
  t.diagnostic("1200 heading/block cases in " + (performance.now() - started).toFixed(0) + " ms; seeds 1..240");
});
