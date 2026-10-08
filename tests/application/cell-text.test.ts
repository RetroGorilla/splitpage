import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { CELL_TEXT_DERIVES, cellRuns, cellTextCommand, sanitisedMediaHtml } from "../../src/application/commands/cell-text.ts";
import type { CellText } from "../../src/application/commands/cell-text.ts";
import type { CellTextPorts } from "../../src/application/session/ports.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { normalizeCell } from "../../src/core/text/runs.ts";
import type { Marks, Run } from "../../src/core/text/runs.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import type { Frozen } from "../../src/core/document/freeze.ts";
import { migratedThenSet } from "../core/migrate-ports.ts";
import { harness, runConfined } from "./session-fakes.ts";

const STAMP = "2026-10-07T12:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

const decoded = new Map<string, Run[]>();

function html(runs: readonly Run[]): string {
  const cell = normalizeCell(runs);
  const out = toHtml(cell);
  decoded.set(out, cell);
  return out;
}

function run(text: string, marks: Marks = {}): Run {
  return { text: text, marks: marks };
}

interface Counting extends CellTextPorts {
  decodes: string[];
  asked: () => number;
}

function ports(name = "Adam"): Counting {
  const decodes: string[] = [];
  let asked = 0;
  return {
    decodes: decodes,
    asked: function () { return asked; },
    clock: { nowIso: function () { asked++; return STAMP; } },
    editor: { name: function () { asked++; return name; } },
    cells: function (h: string): Frozen<Run[]> {
      decodes.push(h);
      return deepFreeze(decoded.get(h) || [run(h)]);
    }
  };
}

const COMMENTED = html([run("Alpha "), run("bravo", { cmt: ["c1"] }), run(" delta")]);
const PLAIN = html([run("Every morning.")]);
const BOLD = html([run("Alpha "), run("bravo", { b: true })]);
const CARD = '<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';
const LEGACY = "Every <b>morning</b>.";
const MEDIA = "Hello " + CARD;
decoded.set(LEGACY, normalizeCell([run("Every "), run("morning", { b: true }), run(".")]));
decoded.set(MEDIA, normalizeCell([run("Hello ")]));

function fixture(): { title: string; docId: string; rows: Record<string, unknown>[]; comments: Record<string, unknown>[] } {
  return {
    title: "Harbour",
    docId: "d" + "1".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: PLAIN, status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r2", visualText: "Close", audioText: COMMENTED, status: "ready", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r3", audioText: "Third.", status: "todo" },
      { id: "r4", audioText: BOLD, status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r5", audioText: LEGACY, status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r6", audioText: MEDIA, status: "todo", updatedAt: OLD, updatedBy: "Sam" }
    ],
    comments: [{ id: "c1", anchorId: "c1", kind: "anchor", rowId: "r2", field: "audioText", body: "Tighter", replies: [] }]
  };
}

function opened(reconcile?: () => number): ReturnType<typeof harness> {
  const entry = function () { return migratedThenSet(fixture()); };
  const h = harness(undefined, reconcile ? { entry: entry, reconcile: reconcile } : { entry: entry });
  h.session.adopt({});
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function rowOf(h: ReturnType<typeof harness>, rowId: string): Record<string, unknown> | null {
  return h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row ? JSON.parse(JSON.stringify(row)) as Record<string, unknown> : null;
  });
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function textChanges(rowId: string, field: string, runsMoved = false) {
  return changeSet({
    cells: [
      { rowId: rowId, field: field },
      { rowId: rowId, field: "updatedAt" },
      { rowId: rowId, field: "updatedBy" }
    ],
    runsMoved: runsMoved,
    derive: ["production", "broll"]
  });
}

test("E2: a keystroke is one generation, one undo record and one effect pass; it stores toHtml(runs) and stamps through the ports", () => {
  const h = opened();
  const p = ports();
  const runs = normalizeCell([run("Every morning!")]);
  const out = runConfined(h.session, cellTextCommand("r1", "audioText", cellRuns(runs), p));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: textChanges("r1", "audioText") });
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"], "no reconciliation: the cell's comment ids did not change");
  const row = rowOf(h, "r1");
  assert.equal(row?.audioText, "Every morning!");
  assert.equal(row?.updatedAt, STAMP);
  assert.equal(row?.updatedBy, "Adam");
  assert.equal(rowOf(h, "r2")?.updatedAt, OLD, "no other scene is stamped");
  assert.equal(h.published[0]?.changes.saveNow, false, "typing waits for the autosave debounce");
  assert.deepEqual(p.decodes, [], "a cell with no comment anchor is never decoded to compare its comment ids");
  assert.deepEqual(CELL_TEXT_DERIVES, ["production", "broll"]);
  h.clock.advance(179);
  assert.deepEqual(h.refreshes, []);
  h.clock.advance(1);
  assert.deepEqual(h.refreshes, [["broll", "production"]], "the derivations run once, on the idle refresh");
});

test("the stored form is exactly toHtml of the runs, formatting and comment marks included", () => {
  const h = opened();
  const runs = normalizeCell([run("Alpha "), run("bravo", { cmt: ["c1"], b: true }), run(" & <delta>", { i: true })]);
  assert.equal(runConfined(h.session, cellTextCommand("r2", "audioText", cellRuns(runs), ports())).kind, "applied");
  assert.equal(rowOf(h, "r2")?.audioText, toHtml(runs));
  assert.match(String(rowOf(h, "r2")?.audioText), /&amp; &lt;delta&gt;/);
});

test("E3: runs that store the same HTML are a no-op: no write, no stamp, no effects", () => {
  const h = opened();
  const before = snapshot(h);
  const p = ports();
  assert.deepEqual(runConfined(h.session, cellTextCommand("r1", "audioText", cellRuns(decoded.get(PLAIN) || []), p)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, cellTextCommand("r2", "audioText", cellRuns(normalizeCell([run("Alpha "), run("bravo", { cmt: ["c1"] }), run(" delta")])), p)), { kind: "noop" });
  assert.equal(p.asked(), 0, "the stamp ports are never asked");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.equal(h.clock.armed(), 0, "no refresh was scheduled");
  assert.equal(snapshot(h), before);
});

test("E3: a scene that is gone is a no-op, and with no document the command is refused", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, cellTextCommand("gone", "audioText", cellRuns([run("x")]), ports())), { kind: "noop" });
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
  const empty = harness();
  assert.deepEqual(runConfined(empty.session, cellTextCommand("r1", "audioText", cellRuns([run("x")]), ports())), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(empty.log, []);
});

test("a field the row does not have yet is written even when empty, as syncFieldFromDom always did", () => {
  const h = opened();
  assert.equal(rowOf(h, "r3")?.visualText, undefined);
  const out = runConfined(h.session, cellTextCommand("r3", "visualText", cellRuns([]), ports()));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: textChanges("r3", "visualText") });
  const row = rowOf(h, "r3");
  assert.equal(row?.visualText, "");
  assert.deepEqual(Object.keys(row || {}), ["id", "audioText", "status", "visualText", "updatedAt", "updatedBy"], "the field, then the stamp, in that order");
});

test("the command is not refused in review mode: a reviewer's comment anchor is stored through it", () => {
  const h = opened();
  h.deny("review");
  const runs = normalizeCell([run("Every "), run("morning", { cmt: ["c9"] }), run(".")]);
  const out = runConfined(h.session, cellTextCommand("r1", "audioText", cellRuns(runs), ports("Reviewer")));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: textChanges("r1", "audioText", true) });
  assert.equal(rowOf(h, "r1")?.updatedBy, "Reviewer");
});

function refusedInReview(rowId: string, field: string, text: CellText, why: string): void {
  const h = opened();
  h.deny("review");
  const before = snapshot(h);
  const p = ports("Reviewer");
  assert.deepEqual(runConfined(h.session, cellTextCommand(rowId, field, text, p)), { kind: "rejected", reason: "review" }, why);
  assert.equal(p.asked(), 0, why + ": no stamp was taken");
  assert.equal(h.session.generation(), 0, why);
  assert.deepEqual(h.log, [], why + ": no undo record, no reconciliation, no effects");
  assert.deepEqual(h.published, [], why);
  assert.equal(h.clock.armed(), 0, why + ": no refresh was scheduled");
  assert.equal(snapshot(h), before, why + ": the document is unchanged");
}

function appliedInReview(rowId: string, text: CellText, why: string): Record<string, unknown> | null {
  const h = opened();
  h.deny("review");
  const out = runConfined(h.session, cellTextCommand(rowId, "audioText", text, ports("Reviewer")));
  assert.equal(out.kind, "applied", why);
  assert.equal(h.session.generation(), 1, why);
  return rowOf(h, rowId);
}

const REVIEW_TEXT_CHANGES: readonly [string, string, string, CellText][] = [
  ["a typed character", "r1", "audioText", cellRuns(normalizeCell([run("Every morning!")]))],
  ["a deleted word", "r2", "audioText", cellRuns(normalizeCell([run("Alpha "), run("bravo", { cmt: ["c1"] })]))],
  ["an emptied cell", "r1", "audioText", cellRuns([])],
  ["a new anchor with a typed character", "r1", "audioText", cellRuns(normalizeCell([run("Every "), run("morning", { cmt: ["c9"] }), run("!")]))],
  ["a removed anchor with a changed word", "r2", "audioText", cellRuns(normalizeCell([run("Alpha bravo gamma")]))],
  ["bold added", "r1", "audioText", cellRuns(normalizeCell([run("Every "), run("morning", { b: true }), run(".")]))],
  ["bold removed under a new anchor", "r4", "audioText", cellRuns(normalizeCell([run("Alpha "), run("bravo", { cmt: ["c9"] })]))],
  ["a highlight on commented words", "r2", "audioText", cellRuns(normalizeCell([run("Alpha "), run("bravo", { cmt: ["c1"], hl: true }), run(" delta")]))],
  ["a link", "r1", "audioText", cellRuns(normalizeCell([run("Every "), run("morning", { href: "https://example.com/" }), run(".")]))],
  ["a stage direction", "r1", "audioText", cellRuns(normalizeCell([run("Every morning.", { dir: true })]))],
  ["the same runs stored in another form, with no anchor change", "r5", "audioText", cellRuns(normalizeCell([run("Every "), run("morning", { b: true }), run(".")]))],
  ["a cell that holds media, with a new anchor", "r1", "audioText", sanitisedMediaHtml('<span class="cmt-anchor" data-cmt="c9">Every</span> morning. ' + CARD)],
  ["a stored media cell whose card is gone, with a new anchor", "r6", "audioText", cellRuns(normalizeCell([run("Hello", { cmt: ["c9"] }), run(" ")]))],
  ["a field the scene does not have yet", "r3", "visualText", cellRuns([])]
];

test("without edit capability, a change to a cell's text or formatting is refused before anything is written: no stamp, no undo record, no effects", () => {
  REVIEW_TEXT_CHANGES.forEach(function ([why, rowId, field, text]) { refusedInReview(rowId, field, text, why); });
});

test("without edit capability, a change that only adds, moves or removes comment anchors is applied", () => {
  const added = appliedInReview("r1", cellRuns(normalizeCell([run("Every "), run("morning", { cmt: ["c9"] }), run(".")])), "an added anchor");
  assert.equal(added?.updatedBy, "Reviewer");
  const moved = appliedInReview("r2", cellRuns(normalizeCell([run("Alpha bravo "), run("delta", { cmt: ["c1"] })])), "a moved anchor");
  assert.equal(moved?.audioText, 'Alpha bravo <span class="cmt-anchor" data-cmt="c1">delta</span>');
  const removed = appliedInReview("r2", cellRuns(normalizeCell([run("Alpha bravo delta")])), "a removed anchor");
  assert.equal(removed?.audioText, "Alpha bravo delta");
  const across = appliedInReview("r4", cellRuns(normalizeCell([run("Alp"), run("ha ", { cmt: ["c9"] }), run("bra", { b: true, cmt: ["c9"] }), run("vo", { b: true })])), "an anchor across a bold edge");
  assert.match(String(across?.audioText), /c9/);
  const legacy = appliedInReview("r5", cellRuns(normalizeCell([run("Every "), run("morning", { b: true, cmt: ["c9"] }), run(".")])), "an anchor in a cell stored in another form");
  assert.match(String(legacy?.audioText), /data-cmt="c9"/);
  assert.equal(legacy?.updatedBy, "Reviewer");
});

test("without edit capability, the same text is still a no-op and a scene that is gone is still a no-op, not a refusal", () => {
  const h = opened();
  h.deny("review");
  const p = ports("Reviewer");
  assert.deepEqual(runConfined(h.session, cellTextCommand("r1", "audioText", cellRuns(decoded.get(PLAIN) || []), p)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, cellTextCommand("r2", "audioText", cellRuns(normalizeCell([run("Alpha "), run("bravo", { cmt: ["c1"] }), run(" delta")])), p)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, cellTextCommand("gone", "audioText", cellRuns([run("x")]), p)), { kind: "noop" });
  assert.deepEqual(h.log, []);
});

test("with edit capability, every change the review check refuses is applied as before", () => {
  REVIEW_TEXT_CHANGES.forEach(function ([why, rowId, field, text]) {
    const h = opened();
    const out = runConfined(h.session, cellTextCommand(rowId, field, text, ports()));
    assert.equal(out.kind, "applied", why);
    assert.equal(rowOf(h, rowId)?.[field], text.kind === "runs" ? toHtml(text.runs) : text.html, why);
    assert.equal(rowOf(h, rowId)?.updatedBy, "Adam", why);
  });
});

test("a cell holding media stores its sanitised HTML as given, through the same command", () => {
  const h = opened();
  const p = ports();
  const stored = "Hello <strong>there</strong> " + CARD;
  const out = runConfined(h.session, cellTextCommand("r1", "audioText", sanitisedMediaHtml(stored), p));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: textChanges("r1", "audioText") });
  assert.equal(rowOf(h, "r1")?.audioText, stored);
  assert.deepEqual(p.decodes, [], "no comment anchor on either side: nothing decoded");
  assert.deepEqual(runConfined(h.session, cellTextCommand("r1", "audioText", sanitisedMediaHtml(stored), p)), { kind: "noop" });
  assert.equal(h.session.generation(), 1);
});

test("a cell edit that adds or drops a comment anchor reconciles in the transaction; one that keeps them does not", () => {
  let reconciled = 0;
  const h = opened(function () { reconciled++; return 0; });
  const p = ports();
  const kept = normalizeCell([run("Alpha "), run("bravo!", { cmt: ["c1"] }), run(" delta")]);
  html(kept);
  assert.deepEqual(runConfined(h.session, cellTextCommand("r2", "audioText", cellRuns(kept), p)).kind, "applied");
  assert.equal(reconciled, 0);
  assert.deepEqual(p.decodes, [COMMENTED], "the stored cell is decoded once to read its comment ids");
  const dropped = normalizeCell([run("Alpha delta")]);
  const out = runConfined(h.session, cellTextCommand("r2", "audioText", cellRuns(dropped), p));
  assert.deepEqual(out, { kind: "applied", generation: 2, changes: textChanges("r2", "audioText", true) });
  assert.equal(reconciled, 1);
  assert.deepEqual(h.log.slice(-6), ["reconcile", "undo.record", "dirty:2", "draft:2", "save:2", "publish:edit"]);
  const media = '<span class="cmt-anchor" data-cmt="c1">Alpha</span> ' + CARD;
  decoded.set(media, normalizeCell([run("Alpha", { cmt: ["c1"] }), run(" ")]));
  assert.equal(runConfined(h.session, cellTextCommand("r2", "audioText", sanitisedMediaHtml(media), p)).kind, "applied");
  assert.equal(reconciled, 2, "a media cell's anchors are read through the cell port too");
});

test("E3: a stamp port that throws fails the command and rolls the cell back, with no effects", () => {
  const h = opened();
  const before = snapshot(h);
  const broken: CellTextPorts = {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { throw new Error("no editor"); } },
    cells: ports().cells
  };
  const out = runConfined(h.session, cellTextCommand("r1", "audioText", cellRuns([run("Changed")]), broken));
  assert.equal(out.kind, "failed");
  assert.equal(out.kind === "failed" && out.error instanceof Error ? out.error.message : "", "no editor");
  assert.equal(runConfined(h.session, cellTextCommand("r3", "visualText", cellRuns([run("New")]), broken)).kind, "failed");
  assert.equal(snapshot(h), before, "the text, the stamp and an absent field are as they were");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.equal(h.clock.armed(), 0);
});

test("INV-06: a burst of keystrokes through the typing command runs each derivation once per idle window", () => {
  const h = opened();
  const p = ports();
  let text = "Every morning";
  for (let i = 0; i < 6; i++) {
    text += "!";
    assert.equal(runConfined(h.session, cellTextCommand("r1", "audioText", cellRuns([run(text)]), p)).kind, "applied");
    h.clock.advance(100);
  }
  assert.equal(h.session.generation(), 6, "every key is its own accepted edit");
  assert.equal(h.log.filter(function (l) { return l === "undo.record"; }).length, 6, "and its own undo record, which 12a coalesces into one group");
  assert.deepEqual(h.refreshes, [], "nothing derived while the keys keep coming");
  h.clock.advance(80);
  assert.deepEqual(h.refreshes, [["broll", "production"]], "one refresh for the burst, 180 ms after the last key");
  for (let i = 0; i < 25; i++) {
    text += "?";
    runConfined(h.session, cellTextCommand("r1", "audioText", cellRuns([run(text)]), p));
    h.clock.advance(60);
  }
  h.clock.advance(180);
  assert.equal(h.refreshes.length, 3, "1,500 ms of steady typing: once at the 1,000 ms cap and once after the last key");
  h.refreshes.forEach(function (jobs) { assert.deepEqual(jobs, ["broll", "production"]); });
  assert.deepEqual(p.decodes, [], "and no keystroke decoded a cell to compare comment ids");
});
