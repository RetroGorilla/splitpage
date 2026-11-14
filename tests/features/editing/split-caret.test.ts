import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCaretPage } from "./split-caret-support.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { projection } from "../../../src/core/text/runs.ts";
import { readSharedPaintedText, readSharedPaintedSelectionText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { createMonitoredSharedDocument } from "../../adapters/collab/helpers.ts";
import { applySharedUpdate, encodeSharedState, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { domToPos, paintTrailingCellSpaces } from "../../../src/features/common/cell-dom.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";

test("the shared space paint preserves formatting and leaves space before a break or atom untouched", () => {
  for (const [html, expected] of [
    ["Word  ", 'Word<span data-shared-cell-space="" style="white-space: break-spaces;">  </span>'],
    ["<b>Word </b><i> </i>", '<b>Word<span data-shared-cell-space="" style="white-space: break-spaces;"> </span></b><i><span data-shared-cell-space="" style="white-space: break-spaces;"> </span></i>'],
    ["Word <br>", "Word <br>"],
    ['Word <img src="image">', 'Word <img src="image">']
  ]) {
    const cell = document.createElement("div"); cell.innerHTML = html ?? "";
    paintTrailingCellSpaces(cell); assert.equal(cell.innerHTML, expected);
  }
});

const CASES = [
  { name: "before", kind: "insert", from: 0, to: 0, point: [3, 3], expected: [4, 4], text: "Xabcdef" },
  { name: "after", kind: "insert", from: 6, to: 6, point: [3, 3], expected: [3, 3], text: "abcdefX" },
  { name: "at", kind: "insert", from: 3, to: 3, point: [3, 3], expected: [3, 3], text: "abcXdef" },
  { name: "spanning deletion", kind: "delete", from: 1, to: 5, point: [3, 3], expected: [1, 1], text: "af" },
  { name: "format around", kind: "mark", from: 1, to: 5, point: [3, 3], expected: [3, 3], text: "abcdef" },
  { name: "selection", kind: "insert", from: 0, to: 0, point: [2, 5], expected: [3, 6], text: "Xabcdef" },
  { name: "backward selection", kind: "insert", from: 0, to: 0, point: [5, 2], expected: [6, 3], text: "Xabcdef" },
  { name: "repeated characters", kind: "insert", from: 0, to: 0, point: [2, 4], expected: [3, 5], text: "aaaaaaa" }
] as const;

for (const points of [[2, 5], [5, 2]] as const) {
  test(`rule 89 a remote split preserves both ends across the two resulting narration cells: ${points}`, () => {
    const p = splitCaretPage(), fresh = "structure_2_00730070006c00690074_beat_0";
    try {
      p.select("audioText", points[0], points[1]); p.split();
      const selection = document.getSelection(); assert.ok(selection?.anchorNode); assert.ok(selection.focusNode);
      const start = p.cell("audioText", points[0] === 2 ? "R1" : fresh), end = p.cell("audioText", points[1] === 2 ? "R1" : fresh);
      assert.deepEqual([domToPos(start, selection.anchorNode, selection.anchorOffset), domToPos(end, selection.focusNode, selection.focusOffset), p.a.executed, p.reports],
        [2, 2, [], []]);
      p.h.join(); p.h.queue.flush("dup");
      for (const handle of [p.h.a, p.h.b, p.h.c]) assert.deepEqual(projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id, row.audioText, row.visualText]),
        [["R1", "abc", "abcdef"], [fresh, "def", ""], ["R2", "uvwx", "uvwx"]]);
    } finally { p.close(); }
  });
}

for (const [points, expected] of [[[5, 5], [2, 2]], [[6, 4], [3, 1]]] as const) {
  test(`rule 89 a remote split keeps the narration selection on the characters that moved to the new cell: ${points}`, () => {
    const p = splitCaretPage(), fresh = "structure_2_00730070006c00690074_beat_0";
    try {
      p.select("audioText", points[0], points[1]); p.split();
      assert.deepEqual([p.points("audioText", fresh), document.activeElement === p.cell("audioText", fresh), p.a.executed, p.reports, p.missing, p.recovered],
        [expected, true, [], [], [], []]);
      p.h.join(); p.h.queue.flush("dup");
      for (const handle of [p.h.a, p.h.b, p.h.c]) assert.deepEqual(projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id, row.audioText, row.visualText]),
        [["R1", "abc", "abcdef"], [fresh, "def", ""], ["R2", "uvwx", "uvwx"]]);
    } finally { p.close(); }
  });
}

for (const field of ["audioText", "visualText"] as const) {
  test(`rule 89 ${field}: queued caret restoration waits for the paint guard before changing either endpoint`, () => {
    const p = splitCaretPage("aaaaaa");
    try {
      p.select(field, 2, 4); p.defer(); p.remote(field, "insert", 0, 0, "a");
      assert.deepEqual(p.points(field), [2, 4]);
      p.flush();
      assert.deepEqual([p.points(field), p.a.executed, p.reports, p.missing, p.recovered], [[3, 5], [], [], [], []]);
      p.h.join(); p.h.queue.flush("dup");
      for (const handle of [p.h.a, p.h.b, p.h.c]) assert.equal(projectSharedDocumentWithRecovery(handle).document.rows[0]?.[field], "aaaaaaa");
    } finally { p.close(); }
  });
  test(`rule 89 ${field}: a stale selection snapshot does not take focus back from the title`, () => {
    const p = splitCaretPage();
    try {
      p.select(field, 2); p.remote(field, "insert", 0, 0, "X");
      const title = document.getElementById("doc-title"); assert.ok(title); title.focus();
      p.remote(field, "insert", 0, 0, "Y");
      assert.deepEqual([document.activeElement === title, p.a.executed, p.reports, p.missing, p.recovered], [true, [], [], [], []]);
      p.h.queue.flush("dup"); p.h.join();
      for (const handle of [p.h.a, p.h.b, p.h.c]) assert.equal(readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, p.key(field)))?.text, "YXabcdef");
    } finally { p.close(); }
  });
  test(`rule 89 ${field}: disposing the binding prevents a queued paint callback from restoring focus`, () => {
    const p = splitCaretPage("aaaaaa");
    try {
      p.select(field, 2); p.defer(); p.remote(field, "insert", 0, 0, "a");
      assert.equal(p.buffer.dispose(), true); p.cell(field).blur(); p.flush();
      assert.deepEqual([document.activeElement === document.body, p.a.executed, p.reports, p.missing, p.recovered], [true, [], [], [], []]);
      p.h.queue.flush("dup"); p.h.join();
      for (const handle of [p.h.a, p.h.b, p.h.c]) assert.equal(readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, p.key(field)))?.text, "aaaaaaa");
    } finally { p.close(); }
  });
  test(`rule 89 ${field}: repaint keeps a typed trailing space visible while its shared character stays plain`, () => {
    const p = splitCaretPage("Word");
    try {
      assert.equal(p.type(field, 4, 4, " "), true);
      const target = sharedBufferedTarget(p.h.a, p.key(field)), space = readSharedPaintedText(p.h.a, target)?.identity(4);
      assert.ok(space);
      p.remote(field, "insert", 0, 0, "X");
      assert.deepEqual([p.cell(field).innerHTML, p.points(field), p.reports, p.missing, p.recovered, p.a.executed.length], ['XWord<span data-shared-cell-space="" style="white-space: break-spaces;"> </span>', [6, 6], [], [], [], 1]);
      assert.equal(readSharedPaintedText(p.h.a, target)?.identity(5), space);
      assert.equal(p.type(field, 6, 6, "Q"), true);
      assert.equal(readSharedPaintedText(p.h.a, target)?.identity(5), space);
      p.h.queue.flush("dup"); p.h.join();
      for (const handle of [p.h.a, p.h.b, p.h.c]) assert.equal(projectSharedDocumentWithRecovery(handle).document.rows[0]?.[field], "XWord Q");
      assert.deepEqual([p.points(field), p.reports, p.a.executed.map(entry => entry.operations.map(op => op.kind))],
        [[7, 7], [], [["text-insert", "scalar"], ["text-insert", "scalar"]]]);
    } finally { p.close(); }
  });
  for (const joined of [false, true]) for (const scenario of CASES) {
    test(`rule 89 ${field}: idle ${scenario.name} follows the same shared characters after a real Split repaint, joined ${joined}`, () => {
      const p = splitCaretPage(scenario.name === "repeated characters" ? "aaaaaa" : "abcdef");
      try {
        if (joined) p.join();
        p.select(field, scenario.point[0], scenario.point[1]);
        p.remote(field, scenario.kind, scenario.from, scenario.to, scenario.name === "repeated characters" ? "a" : "X");
        const text = scenario.text + (joined ? field === "audioText" ? " uvwx" : "\nuvwx" : "");
        assert.deepEqual([p.points(field), projection(fromHtml(p.cell(field).innerHTML, { media: true })), document.activeElement === p.cell(field), p.a.executed, p.reports, p.missing, p.recovered],
          [scenario.expected, text, true, [], [], [], []]);
        p.h.join(); p.h.queue.flush("dup");
        for (const handle of [p.h.a, p.h.b, p.h.c]) {
          const doc = projectSharedDocumentWithRecovery(handle);
          assert.equal(projection(fromHtml(doc.document.rows[0]?.[field] ?? "", { media: true })), text);
          assert.equal(readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, p.key(field)))?.text, text);
          assert.deepEqual(doc.recovery, []);
        }
      } finally { p.close(); }
    });
  }
  test(`rule 89 ${field}: a join carries the focused second beat's caret to its shared characters in the joined row`, () => {
    const p = splitCaretPage();
    try {
      p.select(field, 2, 2, "R2"); p.join();
      assert.deepEqual([p.points(field), document.activeElement === p.cell(field), p.a.executed, p.reports, p.missing, p.recovered], [[9, 9], true, [], [], [], []]);
      p.h.join(); p.h.queue.flush("dup");
      for (const handle of [p.h.a, p.h.b, p.h.c]) assert.equal(readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, p.key(field)))?.text,
        field === "audioText" ? "abcdef uvwx" : "abcdef\nuvwx");
    } finally { p.close(); }
  });
  for (const deleted of ["R1", "R2"] as const) {
    test(`rule 89 joined ${field}: deletion of all ${deleted} characters follows the name-box fallback for each selection end`, () => {
      const p = splitCaretPage("aaaaaa", "aaaaaa");
      try {
        p.join(); p.select(field, 5, 9); p.remote(field, "delete", 0, 6, "", deleted);
        const expected = field === "audioText" ? deleted === "R1" ? [0, 3] : [5, 7] : deleted === "R1" ? [0, 2] : [5, 6];
        assert.deepEqual([p.points(field), p.a.executed, p.reports, p.missing, p.recovered], [expected, [], [], [], []]);
        p.h.join(); p.h.queue.flush("dup");
        const text = field === "audioText" ? deleted === "R1" ? " aaaaaa" : "aaaaaa " : "aaaaaa";
        for (const handle of [p.h.a, p.h.b, p.h.c]) assert.equal(readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, p.key(field)))?.text, text);
      } finally { p.close(); }
    });
  }
  for (const member of ["R1", "R2"] as const) {
    test(`rule 89 joined ${field}: a repeated-character insertion in ${member} keeps both selection ends on their units`, () => {
      const p = splitCaretPage("aaaaaa", "aaaaaa");
      try {
        p.join(); p.select(field, 5, 9);
        p.remote(field, "insert", 0, 0, "a", member);
        const expected = member === "R1" ? [6, 10] : [5, 10];
        assert.deepEqual([p.points(field), p.a.executed, p.reports, p.missing, p.recovered], [expected, [], [], [], []]);
        p.h.join(); p.h.queue.flush("dup");
        const text = field === "audioText" ? member === "R1" ? "aaaaaaa aaaaaa" : "aaaaaa aaaaaaa"
          : member === "R1" ? "aaaaaaa\naaaaaa" : "aaaaaa\naaaaaaa";
        for (const handle of [p.h.a, p.h.b, p.h.c]) {
          const doc = projectSharedDocumentWithRecovery(handle);
          assert.equal(projection(fromHtml(doc.document.rows[0]?.[field] ?? "", { media: true })), text);
          assert.deepEqual(doc.recovery, []);
        }
      } finally { p.close(); }
    });
  }
}

const HISTORIES = [
  { seed: "aaaaaa", insert: 0, value: "a", cut: [1, 4], mark: [5, 6], caret: [2, 5], text: "aaaa ", expected: [2, 3] },
  { seed: "abcdef", insert: 3, value: "X", cut: [1, 5], mark: [0, 1], caret: [3, 6], text: "aXf ", expected: [1, 3] },
  { seed: "aaaaaa", insert: 3, value: "a", cut: [0, 6], mark: [6, 7], caret: [2, 5], text: "a ", expected: [0, 0] },
  { seed: "abcdef", insert: 6, value: "X", cut: [2, 4], mark: [0, 6], caret: [2, 5], text: "abefX ", expected: [2, 3] }
] as const;

for (const field of ["audioText", "visualText"] as const) {
  test(`rule 89 seeded three-writer histories preserve selection identities, plain space and a separate late joiner: ${field}`, () => {
    let seed = 0x89ca17;
    const limits: readonly string[] = [], violations: string[] = [];
    const visited = new Set<number>();
    for (let round = 0; round < 24; round++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const index = (seed >>> 8) % HISTORIES.length, history = HISTORIES[index]; assert.ok(history); visited.add(index);
      const joined = (seed & 4) !== 0, order = (["D1", "rev", "dup"] as const)[seed % 3]; assert.ok(order);
      const p = splitCaretPage(history.seed), late = createMonitoredSharedDocument();
      try {
        assert.equal(p.type(field, 6, 6, " "), true); p.h.queue.flush("dup"); p.h.join();
        if (joined) p.join();
        p.select(field, history.caret[0], history.caret[1]);
        const actions = [() => p.write("B", field, "insert", history.insert, history.insert, history.value),
          () => { p.write("C", field, "mark", history.mark[0], history.mark[1]); p.write("C", field, "delete", history.cut[0], history.cut[1]); }];
        for (const at of seed & 1 ? [1, 0] : [0, 1]) { const action = actions[at]; assert.ok(action); action(); }
        p.deliver(order);
        assert.deepEqual([p.points(field), p.a.executed.length, p.reports, p.missing, p.recovered], [history.expected, 1, [], [], []]);
        const expected = history.text + (joined ? field === "audioText" ? " uvwx" : "\nuvwx" : "");
        assert.equal(applySharedUpdate(late, encodeSharedState(p.h.a)).ok, true);
        for (const handle of [p.h.a, p.h.b, p.h.c, late]) {
          const doc = projectSharedDocumentWithRecovery(handle);
          assert.equal(projection(fromHtml(doc.document.rows[0]?.[field] ?? "", { media: true })), expected);
          assert.equal(readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, p.key(field)))?.text, expected);
          assert.deepEqual(doc.recovery, []);
        }
        assertReplicasAgree("Split caret complete projection", [
          { order, replica: "A", output: projectSharedDocumentWithRecovery(p.h.a) },
          { order, replica: "B", output: projectSharedDocumentWithRecovery(p.h.b) },
          { order: "late-C", replica: "C", output: projectSharedDocumentWithRecovery(late) }
        ]);
      } catch (error) { violations.push("round " + round); throw error; }
      finally { destroySharedDocument(late); p.close(); }
    }
    assert.deepEqual([...visited].sort(), [0, 1, 2, 3]);
    assert.deepEqual(violations, limits);
  });
}
