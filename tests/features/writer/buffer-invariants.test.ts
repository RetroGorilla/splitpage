import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferedWriter } from "./buffer-support.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { applySharedUpdate, encodeSharedState, observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import type { SurfacePorts } from "../../../src/features/writer/flow-surface.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";

type Page = ReturnType<typeof bufferedWriter>;

function owns(page: Page): void {
  for (const element of page.root.querySelectorAll<HTMLElement>(".wr-beat")) {
    const rowId = element.dataset.id ?? "", painted = page.surface.paintedBase(rowId)?.text
      ?? ({ R1: "ab", R2: "next" } as Readonly<Record<string, string>>)[rowId];
    if (element.textContent?.replaceAll("\u200B", "") !== painted) {
      assert.equal(page.edits.some(edit => edit.isOpen()), true, "A differing surface must own an open edit");
    }
  }
}

function copies(page: Page, text: string): void {
  page.h.queue.flush("dup"); page.h.join();
  for (const handle of [page.h.a, page.h.b, page.h.c]) {
    const result = projectSharedDocumentWithRecovery(handle);
    assert.deepEqual(result.document.rows.map(row => row.audioText), [text, "next"]);
    assert.deepEqual(result.recovery, []);
  }
}

function mutate(page: Page, text: string): void {
  const beat = page.beat(); beat.textContent = text;
  const node = beat.firstChild; assert.ok(node instanceof window.Text);
  window.getSelection()?.setBaseAndExtent(node, text.length, node, text.length);
}

function clipboard(type: string): Event & { clipboardData: { getData: (type: string) => string; setData: (type: string, value: string) => void; types: string[] } } {
  const values = new Map([["text/plain", "paste"]]), event = new window.Event(type, { bubbles: true, cancelable: true });
  return Object.assign(event, { clipboardData: { getData: (key: string) => values.get(key) ?? "", setData: (key: string, value: string) => { values.set(key, value); }, types: ["text/plain"] } });
}

for (const [type, text] of [["insertText", "abQ"], ["deleteContentBackward", "a"], ["insertReplacementText", "aQ"]] as const) {
  for (const availability of ["available", "refuse", "throw", "missing", "second", "full"] as const) {
    test(`ownership invariant: ${type} without beforeinput, edit ${availability}`, () => {
      const first = availability === "second" || availability === "full" ? bufferedWriter() : null;
      const page = bufferedWriter("ab", availability !== "missing", undefined, undefined, first ? { h: first.h }
        : availability === "refuse" || availability === "throw" ? { open: () => () => { if (availability === "throw") throw new Error("open"); return null; } } : {});
      try {
        if (availability === "missing") page.ready();
        if (first) { first.start(2); first.native(2, 2, "Z", undefined, "insertCompositionText"); owns(first); }
        if (first && availability === "full") {
          transactSharedDocument(first.h.b, "local-command", () => { collabState(first.h.b).roots.meta.set("overflow", "x".repeat(70000)); });
          assert.deepEqual(applySharedUpdate(first.h.a, encodeSharedState(first.h.b)), { ok: false, reason: "queue-full" });
        }
        owns(page); mutate(page, text);
        page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data: "Q" }));
        owns(page); if (first) owns(first);
        if (availability === "available") {
          assert.deepEqual([page.text(), page.beat().textContent], [text, text]);
          assert.equal(page.a.executed.length, 1);
          assert.deepEqual(page.reports, []);
          page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0), "X")], ["remote"]);
          page.h.queue.flush("dup"); page.surface.repaint(); owns(page);
          assert.equal(page.beat().textContent, "X" + text);
          copies(page, "X" + text);
        } else {
          assert.deepEqual([page.text(), page.beat().textContent], ["ab", "ab"]);
          assert.equal(page.a.executed.length, 0);
          assert.equal(page.reports.length + page.missing.length, 1);
        }
      } finally { page.close(); first?.close(); }
    });
  }
}

for (const [type, text] of [["insertText", "abnQ"], ["deleteContentBackward", "ab"], ["insertReplacementText", "ab你"]] as const) {
  test(`ownership invariant: ${type} without beforeinput reuses the owned composition edit`, () => {
    const page = bufferedWriter();
    try {
      page.start(2); page.native(2, 2, "n", undefined, "insertCompositionText"); owns(page);
      mutate(page, text); page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data: "Q", isComposing: true })); owns(page);
      assert.deepEqual([page.text(), page.beat().textContent, page.edits.length], ["ab", text, 1]);
      page.end("finished"); owns(page);
      assert.deepEqual([page.text(), page.beat().textContent], [text, text]);
      copies(page, text);
    } finally { page.close(); }
  });
}

for (const name of ["keydown", "copy", "cut", "paste", "drop", "focusout", "compositionstart", "mousedown", "mouseup", "selectionchange"] as const) {
  test(`ownership invariant: unowned DOM is checked at ${name}`, () => {
    const page = bufferedWriter("ab", true, () => null);
    try {
      mutate(page, "abQ");
      const event = name === "copy" || name === "cut" || name === "paste" ? clipboard(name)
        : name === "keydown" ? new window.KeyboardEvent(name, { key: "ArrowRight", bubbles: true })
        : name === "compositionstart" ? new window.CompositionEvent(name, { bubbles: true }) : new window.Event(name, { bubbles: true });
      (name === "selectionchange" ? document : name === "mouseup" ? window : page.root).dispatchEvent(event);
      owns(page);
      if (name === "compositionstart") { assert.equal(page.text(), "ab"); page.end("Q"); }
      assert.deepEqual([page.text(), page.beat().textContent], ["abQ", "abQ"]);
    } finally { page.close(); }
  });
}

const requests: readonly (readonly [string, (page: Page) => void])[] = [
  ["paste", page => { assert.equal(page.root.dispatchEvent(clipboard("paste")), false); }],
  ["cut", page => { assert.equal(page.root.dispatchEvent(clipboard("cut")), false); }],
  ["drop", page => { assert.equal(page.root.dispatchEvent(new window.Event("drop", { bubbles: true, cancelable: true })), false); }],
  ["copy", page => {
    page.surface.place({ anchor: beatPos("R1", 2), head: beatPos("R1", 3) });
    const event = clipboard("copy"); page.root.dispatchEvent(event); assert.equal(event.clipboardData.getData("text/plain"), "n");
  }],
  ["focusout", page => { page.root.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })); }],
  ["paint", page => { page.surface.paint(); page.surface.repaint(); page.surface.refreshBeat("R1"); }],
  ["close and undo admission", page => { assert.equal(page.surface.settle?.(), false); }],
  ["finish", page => { page.surface.finish(); }],
  ["dispose", page => { page.surface.dispose(); }],
  ["format port", page => { page.surface.format("b"); }],
  ["operation port", page => { page.surface.apply("must-wait", () => { assert.fail("Composition cannot plan a command"); }, null); }],
  ["session command admission", page => {
    assert.deepEqual(page.a.session.run({ name: "must-wait", needs: "edit", plan: () => { assert.fail("Composition cannot enter the session"); } }), { kind: "rejected", reason: "buffer-pending" });
  }],
  ...[
    { key: "Enter" }, { key: "Tab" }, { key: "z", ctrlKey: true }, { key: "z", ctrlKey: true, shiftKey: true },
    { key: "y", ctrlKey: true }, { key: "b", ctrlKey: true }, { key: "v", ctrlKey: true }, { key: "x", ctrlKey: true },
    { key: "ArrowDown", altKey: true }, { key: "Backspace", altKey: true }, { key: "Delete" }, { key: "Backspace" }
  ].map(key => ["key " + JSON.stringify(key), (page: Page) => {
    const at = key.key === "Backspace" ? 0 : 3;
    page.surface.place({ anchor: beatPos("R1", at), head: beatPos("R1", at) });
    assert.equal(page.root.dispatchEvent(new window.KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true })), false);
  }] as const),
  ...["insertParagraph", "insertLineBreak", "historyUndo", "historyRedo", "formatBold", "formatItalic", "formatUnderline", "insertFromPaste", "insertFromDrop", "deleteByCut", "deleteByDrag"].map(type =>
    [type, (page: Page) => { assert.equal(page.root.dispatchEvent(new window.InputEvent("beforeinput", { inputType: type, isComposing: true, bubbles: true, cancelable: true })), false); }] as const)
];

for (const [name, request] of requests) {
  test(`composition invariant: ${name} cannot settle preedit and the final replacement lands`, () => {
    const page = bufferedWriter("ab", true, () => { assert.fail("Composition cannot reach a command"); });
    try {
      page.start(2); page.native(2, 2, "n", undefined, "insertCompositionText"); owns(page);
      const before = encodeSharedState(page.h.a); request(page); owns(page);
      assert.deepEqual(encodeSharedState(page.h.a), before);
      assert.deepEqual([page.text(), page.beat().textContent, page.a.executed.length], ["ab", "abn", 0]);
      assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
      page.native(2, 3, "你", undefined, "insertCompositionText"); owns(page); page.end("你"); owns(page);
      assert.deepEqual([page.text(), page.beat().textContent], ["ab你", "ab你"]);
      assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
      copies(page, "ab你");
    } finally { page.close(); }
  });
}

for (const type of ["copy", "cut", "paste"] as const) {
  test(`composition invariant: mounted ${type} uses the same guard and keeps the final replacement`, () => {
    const mounted: { value?: Parameters<NonNullable<SurfacePorts["clipboard"]>["mount"]>[0] } = {};
    const page = bufferedWriter("ab", true, () => { assert.fail("Composition cannot plan a clipboard command"); }, {
      mount: handlers => { mounted.value = handlers; return () => {}; },
      copy: () => { assert.fail("A model clipboard cannot capture uncommitted preedit"); }, paste: () => { assert.fail("Composition cannot paste"); }
    });
    try {
      page.start(2); page.native(2, 2, "n", undefined, "insertCompositionText");
      page.surface.place({ anchor: beatPos("R1", 2), head: beatPos("R1", 3) });
      const event = clipboard(type); assert.ok(mounted.value);
      mounted.value[type](event as unknown as ClipboardEvent); owns(page);
      assert.equal(event.defaultPrevented, true);
      if (type === "copy") assert.equal(event.clipboardData.getData("text/plain"), "n");
      assert.deepEqual([page.text(), page.beat().textContent, page.a.executed.length], ["ab", "abn", 0]);
      page.native(2, 3, "你", undefined, "insertCompositionText"); page.end("你"); owns(page);
      assert.deepEqual([page.text(), page.beat().textContent], ["ab你", "ab你"]);
      copies(page, "ab你");
    } finally { page.close(); }
  });
}

test("ownership invariant: another field is repainted with refusal while the owned preedit stays untouched", () => {
  const page = bufferedWriter();
  try {
    page.start(2); page.native(2, 2, "n", undefined, "insertCompositionText");
    page.beat("R2").textContent = "nextQ";
    page.root.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: "Q", bubbles: true })); owns(page);
    assert.deepEqual([page.text(), page.beat().textContent, page.beat("R2").textContent?.replaceAll("\u200B", "")], ["ab", "abn", "next"]);
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-pending" }]);
    page.native(2, 3, "你", undefined, "insertCompositionText"); page.end("你"); owns(page);
    assert.deepEqual([page.text(), page.beat("R2").textContent?.replaceAll("\u200B", "")], ["ab你", "next"]);
  } finally { page.close(); }
});

for (const ending of ["Q", ""] as const) test(`ownership invariant: repaint during the completed edit's drain does not adopt retired DOM, ending ${ending}`, () => {
  const page = bufferedWriter();
  let stop = () => {};
  try {
    page.start(2); page.native(2, 2, "Q", undefined, "insertCompositionText");
    page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0), "X")], ["remote"]);
    page.h.queue.flush("dup");
    stop = observeSharedTransactions(page.h.a, () => { page.surface.repaint(); });
    page.end(ending); stop(); owns(page);
    assert.deepEqual([page.text(), page.beat().textContent, page.reports], ending ? ["XabQ", "XabQ", []] : ["Xab", "Xab", []]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    page.native(ending ? 4 : 3, ending ? 4 : 3, "Y"); owns(page);
    assert.equal(page.text(), ending ? "XabQY" : "XabY");
  } finally { stop(); page.close(); }
});

test("composition without end after blur stays held through focus return until compositionend or cancellation", () => {
  for (const ending of ["你", ""] as const) {
    const page = bufferedWriter();
    try {
      page.start(2); page.native(2, 2, "n", undefined, "insertCompositionText");
      page.root.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
      page.root.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
      page.surface.finish(); page.surface.dispose(); owns(page);
      assert.deepEqual([page.text(), page.beat().textContent, [...collabState(page.h.a).ingress.holds]], ["ab", "abn", ["buffer"]]);
      page.native(2, 3, "你", undefined, "insertCompositionText"); page.end(ending); owns(page);
      assert.equal(page.text(), ending ? "ab你" : "ab");
      assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    } finally { page.close(); }
  }
});
