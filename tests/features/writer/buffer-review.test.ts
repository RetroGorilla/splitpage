import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferedWriter } from "./buffer-support.ts";
import { writerFor } from "./painted-base-support.ts";
import { observeSharedTransactions } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerSplits } from "../../application/session/shared-session-support.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { operation } from "../../adapters/collab/executor-support.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import { createMonitoredSharedDocument } from "../../adapters/collab/helpers.ts";
import { encodeSharedState, applySharedUpdate, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import * as Y from "yjs";

test("native caret follows its joined owner and the changed separator register", () => {
  const page = bufferedWriter();
  try {
    page.surface.place({ anchor: beatPos("R2", 4), head: beatPos("R2", 4) });
    page.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    page.native(4, 4, "Q", undefined, "insertCompositionText", "R2");
    const record = collabState(page.h.b).roots.beats.get("R2"); assert.ok(record instanceof Y.Map);
    const joins = record.get("joins"); assert.ok(joins instanceof Y.Map);
    transactSharedDocument(page.h.b, "local-command", () => { joins.set("joined-tail", { into: "R1", glue: " " }); });
    transactSharedDocument(page.h.b, "local-command", () => { collabState(page.h.b).roots.meta.set("joinGlue:joined-tail", ""); });
    page.h.queue.flush("dup"); page.end("Q");
    assert.deepEqual(projectSharedDocumentWithRecovery(page.h.a).document.rows.map(row => [row.id, row.audioText]), [["R1", "abnextQ"]]);
    const selected = { anchor: beatPos("R1", 7), head: beatPos("R1", 7) };
    assert.deepEqual(page.outcomes.at(-1)?.selection, selected);
    assert.deepEqual(page.surface.selection(), selected);
    page.h.queue.flush("dup"); page.h.join();
    for (const handle of [page.h.b, page.h.c]) assert.deepEqual(projectSharedDocumentWithRecovery(handle), projectSharedDocumentWithRecovery(page.h.a));
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

for (const [label, kind, typedAt, splitAt, rows, caret, next] of [
  ["split before caret", "split", 4, 2, ["ab", "cdQ", "next"], ["structure_2_0073_beat_0", 3], ["ab", "cdQY", "next"]],
  ["split after caret", "split", 1, 3, ["aQbc", "d", "next"], ["R1", 2], ["aQYbc", "d", "next"]],
  ["split at caret", "split", 2, 2, ["abQ", "cd", "next"], ["R1", 3], ["abQY", "cd", "next"]],
  ["prefix split", "split-before", 1, 2, ["aQb", "cd", "next"], ["structure_2_0073_beat_0", 2], ["aQYb", "cd", "next"]]
] as const) for (const order of ["D1", "rev", "dup"] as const) for (const writers of [2, 3]) {
  test(`native caret follows projected owner: ${label}, ${writers} writers, ${order}, late join`, () => {
    const page = bufferedWriter("abcd"), late = createMonitoredSharedDocument();
    try {
      registerSplits(page.h.b);
      if (writers === 3) {
        page.h.join();
        assert.deepEqual(executeSharedOperations(page.h.c, [operation({ kind: "scalar", id: "third", by: "Carol",
          target: { scope: "beat", record: "R2" }, field: "lengthSeconds", value: 7 })]), { ok: true });
      }
      page.start(typedAt); page.native(typedAt, typedAt, "Q", undefined, "insertCompositionText");
      const at = page.h.point("B", "R1", splitAt);
      assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind, id: "s", by: "Bob", target: page.h.target("R1"),
        at: { left: at, right: at, affinity: "before" }, beat: "tail", boundary: "tail", observed: [], fields: {} })]), { ok: true });
      page.h.queue.flush(order); page.end("Q");
      const doc = projectSharedDocumentWithRecovery(page.h.a).document;
      assert.deepEqual(doc.rows.map(row => row.audioText), rows);
      if (writers === 3) assert.equal(doc.rows.find(row => row.id === "R2")?.lengthSeconds, 7);
      const selected = { anchor: beatPos(caret[0], caret[1]), head: beatPos(caret[0], caret[1]) };
      assert.deepEqual(page.outcomes.at(-1)?.selection, selected);
      assert.deepEqual(page.surface.selection(), selected);
      assert.equal(page.native(caret[1], caret[1], "Y", undefined, "insertText", caret[0]), true);
      assert.deepEqual(projectSharedDocumentWithRecovery(page.h.a).document.rows.map(row => row.audioText), next);
      page.h.queue.flush(order); page.h.join();
      assert.equal(applySharedUpdate(late, encodeSharedState(page.h.a)).ok, true);
      const expected = projectSharedDocumentWithRecovery(page.h.a);
      for (const handle of [page.h.b, page.h.c, late]) assert.deepEqual(projectSharedDocumentWithRecovery(handle), expected);
      assert.deepEqual(page.reports, []);
    } finally { destroySharedDocument(late); page.close(); }
  });
}

test("native ownership: an acquisition throw prevents mutation and reports refusal", () => {
  const failure = new Error("opening refused");
  const page = bufferedWriter("ab", true, undefined, undefined, { open: () => () => { throw failure; } });
  try {
    assert.equal(page.native(2, 2, "Q"), false);
    assert.deepEqual([page.text(), page.beat().textContent, page.edits.length], ["ab", "ab", 0]);
    assert.deepEqual(page.reports, [{ kind: "failed", error: failure }]);
  } finally { page.close(); }
});

test("native ownership: the second surface cannot take text while the first owns an edit", () => {
  const first = bufferedWriter(), second = bufferedWriter("ab", true, undefined, undefined, { h: first.h });
  try {
    first.start(2); first.native(2, 2, "Z", undefined, "insertCompositionText");
    assert.equal(second.native(2, 2, "Q"), false);
    assert.deepEqual([first.beat().textContent, second.beat().textContent, first.text()], ["abZ", "ab", "ab"]);
    assert.equal(second.edits.length, 0);
    assert.equal(second.reports[0]?.kind, "failed");
    first.end("Z"); second.surface.repaint();
    assert.deepEqual([first.text(), first.beat().textContent, second.beat().textContent], ["abZ", "abZ", "abZ"]);
    assert.equal(second.native(3, 3, "Q"), true);
    assert.equal(second.text(), "abZQ");
  } finally { second.close(); first.close(); }
});

test("completed no-op with a throwing drain repaints and the next key opens a fresh edit", () => {
  const page = bufferedWriter(), failure = new Error("drain subscriber");
  let stop = () => {};
  try {
    page.start(2);
    page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0), "X")], ["b1"]);
    page.h.queue.flush("D1");
    stop = observeSharedTransactions(page.h.a, () => { throw failure; });
    page.end("unchanged"); stop();
    assert.deepEqual([page.text(), page.beat().textContent], ["Xab", "Xab"]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    assert.equal(page.reports[0]?.kind, "failed");
    assert.deepEqual(page.surface.selection(), { anchor: beatPos("R1", 3), head: beatPos("R1", 3) });
    assert.equal(page.native(3, 3, "Q"), true);
    assert.deepEqual([page.text(), page.beat().textContent], ["XabQ", "XabQ"]);
  } finally { stop(); page.close(); }
});

const composingKeys: readonly (readonly [string, KeyboardEventInit])[] = [
  ["Enter", { key: "Enter", isComposing: true, keyCode: 229 }],
  ["Enter without event flags", { key: "Enter" }],
  ["Backspace boundary", { key: "Backspace" }],
  ["Delete boundary", { key: "Delete" }],
  ["Tab", { key: "Tab" }],
  ["undo", { key: "z", ctrlKey: true }],
  ["redo shift", { key: "z", ctrlKey: true, shiftKey: true }],
  ["redo y", { key: "y", ctrlKey: true }],
  ["status", { key: "Enter", ctrlKey: true }],
  ["structure", { key: "ArrowDown", altKey: true }],
  ["join", { key: "Backspace", altKey: true }],
  ["heading", { key: "Enter", ctrlKey: true, shiftKey: true }],
  ["format", { key: "b", ctrlKey: true }]
];

for (const [name, key] of composingKeys) {
  test(`shared composition excludes the ${name} command and keeps the final replacement`, () => {
    const commands: string[] = [];
    const page = bufferedWriter("ab", true, command => { commands.push(command); return null; }, undefined,
      { key: event => { commands.push(event.key); return true; } });
    try {
      page.start(2); page.native(2, 2, "n", undefined, "insertCompositionText");
      if (name === "Backspace boundary") page.surface.place({ anchor: beatPos("R1", 0), head: beatPos("R1", 0) });
      page.root.dispatchEvent(new window.KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
      assert.deepEqual([page.text(), page.a.executed, commands, page.notices], ["ab", [], [], []]);
      page.native(2, 3, "你", undefined, "insertCompositionText"); page.end("你");
      assert.deepEqual([page.text(), page.beat().textContent], ["ab你", "ab你"]);
      assert.deepEqual(page.reports, []);
    } finally { page.close(); }
  });

  test(`standalone composition still excludes the ${name} command and keeps the final replacement`, () => {
    const page = writerFor();
    try {
      page.writer.repaint(); page.writer.caret("a", 5);
      const beat = page.root.querySelector<HTMLElement>('.wr-beat[data-id="a"]'); assert.ok(beat);
      page.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
      beat.textContent = "Alphan";
      page.root.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: "n", bubbles: true }));
      const text = beat.firstChild; assert.ok(text instanceof window.Text);
      const at = name === "Backspace boundary" ? 0 : 6;
      window.getSelection()?.setBaseAndExtent(text, at, text, at);
      page.root.dispatchEvent(new window.KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
      assert.deepEqual(page.doc.rows.map(row => row.audioText), ["Alpha", "Bravo"]);
      beat.textContent = "Alpha你";
      page.root.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: "你", bubbles: true }));
      page.root.dispatchEvent(new window.CompositionEvent("compositionend", { data: "你", bubbles: true }));
      assert.deepEqual(page.doc.rows.map(row => row.audioText), ["Alpha你", "Bravo"]);
    } finally { page.writer.dispose(); }
  });
}

for (const key of [{ key: "Enter", isComposing: true }, { key: "Enter", keyCode: 229 }]) {
  test(`a composing key flag prevents command entry before compositionstart: ${JSON.stringify(key)}`, () => {
    const page = bufferedWriter("ab", true, () => { assert.fail("A composing key cannot plan a command"); });
    try {
      page.root.dispatchEvent(new window.KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
      assert.deepEqual([page.text(), page.a.executed, page.edits], ["ab", [], []]);
    } finally { page.close(); }
  });
}

test("native ownership invariant after every step: throw, refusal, rule 27, full queue and second surface", () => {
  function invariant(page: ReturnType<typeof bufferedWriter>): void {
    for (const beat of page.root.querySelectorAll<HTMLElement>(".wr-beat")) {
      const base = page.surface.paintedBase(beat.dataset.id ?? "");
      const painted = base?.text ?? ({ R1: "ab", R2: "next" } as Readonly<Record<string, string>>)[beat.dataset.id ?? ""];
      if ((beat.textContent ?? "").replaceAll("\u200B", "") !== painted) {
        assert.equal(page.edits.some(edit => edit.isOpen()), true, "Only the surface owning an open edit may differ from its paint");
      }
    }
  }
  for (const acquisition of ["throw", "refuse", "missing"] as const) {
    const page = bufferedWriter("ab", acquisition !== "missing", undefined, undefined,
      acquisition === "missing" ? {} : { open: () => () => { if (acquisition === "throw") throw new Error("open"); return null; } });
    try {
      if (acquisition === "missing") page.ready();
      invariant(page);
      assert.equal(page.native(2, 2, "Q"), false); invariant(page);
      assert.deepEqual([page.text(), page.beat().textContent, page.edits.length], ["ab", "ab", 0]);
      if (acquisition === "missing") { assert.equal(page.native(2, 2, "Q"), true); invariant(page); assert.equal(page.text(), "abQ"); }
      else if (acquisition === "refuse") assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-unavailable" }]);
    } finally { page.close(); }
  }
  const first = bufferedWriter(), second = bufferedWriter("ab", true, undefined, undefined, { h: first.h });
  const step = (run: () => void): void => { run(); invariant(first); invariant(second); };
  try {
    step(() => { first.start(2); });
    step(() => { first.native(2, 2, "Z", undefined, "insertCompositionText"); });
    step(() => { assert.equal(second.native(2, 2, "Q"), false); });
    step(() => {
      transactSharedDocument(first.h.b, "local-command", () => collabState(first.h.b).roots.meta.set("large", "x".repeat(70000)));
      assert.deepEqual(applySharedUpdate(first.h.a, encodeSharedState(first.h.b)), { ok: false, reason: "queue-full" });
      assert.equal(first.edits[0]?.isOpen(), true);
    });
    step(() => { first.native(3, 3, "Y", undefined, "insertCompositionText"); });
    step(() => { first.end("ZY"); });
    step(() => { second.surface.repaint(); });
    assert.deepEqual([first.text(), first.beat().textContent, second.beat().textContent], ["abZY", "abZY", "abZY"]);
  } finally { second.close(); first.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) for (const writers of [2, 3]) {
  test(`native caret declared removed end: original recovery only, ${writers} writers, ${order}, late join`, () => {
    const page = bufferedWriter("abcd"), late = createMonitoredSharedDocument();
    try {
      if (writers === 3) {
        page.h.join();
        assert.deepEqual(executeSharedOperations(page.h.c, [operation({ kind: "scalar", id: "third", by: "Carol",
          target: { scope: "beat", record: "R2" }, field: "lengthSeconds", value: 7 })]), { ok: true });
      }
      page.start(1, 3); page.native(1, 3, "Z", undefined, "insertCompositionText");
      const record = collabState(page.h.b).roots.beats.get("R1"); assert.ok(record instanceof Y.Map);
      const removals = record.get("removals"); assert.ok(removals instanceof Y.Map);
      transactSharedDocument(page.h.b, "local-command", () => { removals.set("fixture-removal", true); });
      page.h.queue.flush(order); page.end("Z");
      const result = projectSharedDocumentWithRecovery(page.h.a);
      assert.deepEqual(result.document.rows.map(row => row.audioText), ["next"]);
      if (writers === 3) assert.equal(result.document.rows[0]?.lengthSeconds, 7);
      assert.deepEqual(result.recovery.map(entry => entry.kind === "removed-beat" ? [entry.row.id, entry.row.audioText] : entry.kind), [["R1", "aZd"]]);
      assert.equal(page.outcomes.at(-1)?.selection, undefined);
      assert.deepEqual(page.surface.selection(), { anchor: beatPos("R2", 0), head: beatPos("R2", 0) });
      assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
      page.native(0, 0, "Y", undefined, "insertText", "R2");
      assert.deepEqual(projectSharedDocumentWithRecovery(page.h.a).document.rows.map(row => row.audioText), ["Ynext"]);
      page.h.queue.flush(order); page.h.join();
      assert.equal(applySharedUpdate(late, encodeSharedState(page.h.a)).ok, true);
      for (const handle of [page.h.b, page.h.c, late]) assert.deepEqual(projectSharedDocumentWithRecovery(handle), projectSharedDocumentWithRecovery(page.h.a));
    } finally { destroySharedDocument(late); page.close(); }
  });
}
