import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCaretPage } from "./split-caret-support.ts";
import { domToPos, posToDom } from "../../../src/features/common/cell-dom.ts";
import { cellSelection } from "../../../src/features/common/cell-selection.ts";
import { copyFromCell, cellFromClipboard, startCellClipboard } from "../../../src/features/clipboard/cell-clipboard.ts";
import { fromHtml, inertBody, storedHtmlFromDom, cleanPastedCell } from "../../../src/bootstrap/richtext.ts";
import { projection } from "../../../src/core/text/runs.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { fakePictures } from "../fakes.ts";
import { mountClipboardRoutes } from "../../../src/features/clipboard/routes.ts";

for (const backward of [false, true]) {
  test(`rule 89 review: both selection ends survive split, two remote repaints and a full repaint, backward ${backward}`, () => {
    const p = splitCaretPage(), fresh = "structure_2_00730070006c00690074_beat_0";
    const endpoints = (left: number, right: number) => {
      const selection = document.getSelection(); assert.ok(selection?.anchorNode); assert.ok(selection.focusNode);
      assert.deepEqual([domToPos(p.cell("audioText", backward ? fresh : "R1"), selection.anchorNode, selection.anchorOffset),
        domToPos(p.cell("audioText", backward ? "R1" : fresh), selection.focusNode, selection.focusOffset)], backward ? [right, left] : [left, right]);
    };
    try {
      p.select("audioText", backward ? 5 : 2, backward ? 2 : 5); p.split(); endpoints(2, 2);
      p.remote("audioText", "insert", 0, 0, "X"); endpoints(3, 2);
      p.remote("audioText", "mark", 1, 3); endpoints(3, 2);
      p.render.render(); endpoints(3, 2);
      const anchor = posToDom(p.cell("audioText", backward ? fresh : "R1"), backward ? 1 : 2);
      const head = posToDom(p.cell("audioText", backward ? "R1" : fresh), backward ? 2 : 1);
      document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
      document.dispatchEvent(new window.Event("selectionchange"));
      p.render.render(); endpoints(2, 1);
      const selection = document.getSelection(); assert.ok(selection?.rangeCount);
      const cell = document.activeElement; assert.ok(cell);
      cell.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Z", bubbles: true, cancelable: true }));
      cell.dispatchEvent(new window.KeyboardEvent("keypress", { key: "Z", bubbles: true, cancelable: true }));
      const event = new window.InputEvent("beforeinput", { inputType: "insertText", data: "Z", bubbles: true, cancelable: true });
      Object.defineProperty(event, "getTargetRanges", { value: () => [selection.getRangeAt(0).cloneRange()] });
      assert.equal(cell.dispatchEvent(event), false);
      cell.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Z", bubbles: true, cancelable: true }));
      endpoints(2, 1);
      assert.deepEqual([p.a.executed, p.reports], [[], [{ kind: "rejected", reason: "buffer-unsupported-target" }]]);
      p.h.join(); p.h.queue.flush("dup");
      for (const handle of [p.h.a, p.h.b, p.h.c]) assert.deepEqual(projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id, projection(fromHtml(row.audioText ?? ""))]),
        [["R1", "Xabc"], [fresh, "def"], ["R2", "uvwx"]]);
    } finally { p.close(); }
  });
}

for (const field of ["audioText", "visualText"] as const) for (const action of ["copy", "cut", "dragstart"] as const) {
  for (const scenario of [
    { name: "stored plain space", source: "Word ", stored: "Word ", typed: false, from: 0, to: 5, wanted: "Word " },
    { name: "stored nonbreaking space", source: "Word\u00a0", stored: "Word\u00a0", typed: false, from: 0, to: 5, wanted: "Word\u00a0" },
    { name: "selection ending at the first painted space", source: "Word  ", stored: "Word  ", typed: false, from: 1, to: 5, wanted: "ord " },
    { name: "typed plain space before remote paint", source: "Word", stored: "Word ", typed: true, from: 0, to: 5, wanted: "Word " }
  ]) for (const plain of [false, true]) {
    test(`rule 89 review: ${field} ${action} ${scenario.name} preserves characters through ${plain ? "plain" : "HTML"} paste decoding on two copies`, () => {
      const p = splitCaretPage(scenario.source);
      const cut = action === "cut";
      const outcomes: unknown[] = [];
      const owner = startCellClipboard({
        document: { read: read => p.a.session.read(read) },
        edits: { run: command => { const result = p.a.session.run(command); outcomes.push(result); return result; },
          text: { cells: fromHtml, clock: { nowIso: () => "2026-11-14T00:00:00.000Z" }, editor: { name: () => "Alice" } } },
        undo: { flush: () => {}, breakCoalescing: () => {} }, pictures: fakePictures().pictures,
        text: { cellOf: fromHtml, fromHtml, inertBody, storedHtmlFromDom, cleanPastedCell }, imageRefOf: () => null,
        ids: { id: () => "clipboard" }, nonce: () => "clipboard", selection: cellSelection,
        cells: { open: cell => {
          const rowId = cell.getAttribute("data-id"), field = cell.getAttribute("data-field"); assert.ok(rowId && field);
          return { rowId, field, sel: cellSelection(cell), cell: fromHtml(cell.innerHTML), html: cell.innerHTML };
        }, close: cell => cell },
        paintGuard: { whileShown: edit => edit() }, brollSeed: () => ({ audioRef: "", location: "" })
      });
      const routes = mountClipboardRoutes({ window, roots: [p.root], ports: {
        scriptCell: () => true, copy: copyFromCell, afterCut: () => {}, pasteBeats: () => false, pasteDraft: () => {},
        hasMedia: () => false, readMedia: async () => null, capture: () => null, stillOwns: () => true, notAdded: () => {},
        refused: () => {}, placeOf: () => null, restorePlace: () => {}, findCell: () => null, insertNow: () => {}
      } });
      try {
        if (scenario.typed) assert.equal(p.type(field, 4, 4, " "), true);
        p.select(field, scenario.from, scenario.to);
        const data = new Map<string, string>();
        const event = new window.Event(action, { bubbles: true, cancelable: true });
        Object.defineProperty(event, action === "dragstart" ? "dataTransfer" : "clipboardData", { value: { setData: (kind: string, value: string) => data.set(kind, value) } });
        p.cell(field).dispatchEvent(event);
        assert.equal(event.defaultPrevented, action !== "dragstart");
        assert.equal(p.cell(field).textContent, scenario.typed ? "Word\u00a0" : scenario.stored);
        assert.equal(data.get("text/html")?.includes("data-shared-cell-space"), false);
        assert.equal(data.get("text/plain"), scenario.wanted);
        const pasted = cellFromClipboard(plain ? "" : data.get("text/html"), data.get("text/plain"));
        assert.equal(projection(pasted.cell), scenario.wanted);
        assert.equal(cut ? (outcomes[0] as { kind: string }).kind : outcomes.length, cut ? "rejected" : 0);
        p.remote(field, "insert", 0, 0, projection(pasted.cell), "R2");
        p.h.join(); p.h.queue.flush("dup");
        for (const handle of [p.h.a, p.h.b, p.h.c]) assert.deepEqual(projectSharedDocumentWithRecovery(handle).document.rows.map(row => projection(fromHtml(row[field] ?? ""))),
          [scenario.stored, scenario.wanted + "uvwx"]);
        assert.deepEqual([p.a.executed.length, p.reports, p.missing, p.recovered], [scenario.typed ? 1 : 0, [], [], []]);
      } finally { routes.dispose(); owner.dispose(); p.close(); }
    });
  }
}
