import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSharedEmptyScript } from "../../../src/bootstrap/wiring/ports/empty-script.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { bufferStamps } from "../../collab/buffer-readers.ts";
import { createMonitoredSharedDocument, deliveryReplica } from "../../adapters/collab/helpers.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { inspectEmptyScriptViews, removedEmptyScript } from "./support.ts";
import { emptyScriptHistories, emptyScriptDocument, emptyScriptRecovery, emptyScriptRow, firstEmptyScriptBeat, secondEmptyScriptBeat } from "./literals.ts";
import { cellSelection } from "../../../src/features/common/cell-selection.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { EmptyScriptPorts } from "../../../src/features/empty-script/ports.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

function mounted(handle: SharedDocumentHandle, session: ReturnType<typeof sharedHarness>["session"], host: HTMLElement, writer: string,
  place: EmptyScriptPorts["place"], author = sharedAuthorPort({ handle: () => handle, name: () => writer === "1" ? "Alice" : writer === "2" ? "Bob" : "Cara" })) {
  const notices: string[] = [];
  const control = mountSharedEmptyScript({ handle, session, author, writer: () => writer, stamps: bufferStamps(writer === "1" ? "Alice" : writer === "2" ? "Bob" : "Cara") },
    { host, edits: { allowed: () => true }, notices: { show: text => { notices.push(text); } }, place });
  const area = host.previousElementSibling; assert.ok(area instanceof HTMLElement);
  const input = area.querySelector("textarea"); assert.ok(input);
  return { control, input, area, notices };
}

function type(target: HTMLTextAreaElement, text: string, during?: () => void, focus = true) {
  if (focus) target.focus();
  assert.equal(target.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true })), true);
  during?.(); target.value = text; target.setSelectionRange(text.length, text.length);
  target.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
}

function agrees(h: ReturnType<typeof removedEmptyScript>, name: typeof emptyScriptHistories[number], rows: readonly Record<string, unknown>[], order: "dup" | "rev") {
  h.queue.flush(order);
  const late = createMonitoredSharedDocument();
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
    const readings = [h.a, h.b, late].map(handle => projectSharedDocumentWithRecovery(handle));
    for (const projected of readings) assert.deepEqual(projected, { document: emptyScriptDocument(rows), recovery: emptyScriptRecovery(name) });
    assertReplicasAgree("rule 91 " + name, readings.map((output, index) => ({ replica: index === 0 ? "A" : index === 1 ? "B" : "C", order: index === 2 ? "late-C" : order === "rev" ? "D2" : "D1", output })));
    return readings;
  } finally { destroySharedDocument(late); }
}

for (const name of emptyScriptHistories) for (const order of ["dup", "rev"] as const) for (const mode of ["writer", "split"] as const) {
  test("rule 91: " + name + " offers typing in " + mode + "/" + order, () => {
    const h = removedEmptyScript(name, order);
    try {
      for (const handle of [h.a, h.b]) inspectEmptyScriptViews(handle, ui => {
        const page = mounted(handle, ui.session, mode === "writer" ? ui.writerRoot : ui.splitRoot, handle === h.a ? "1" : "2", (row, offset) => ui.place(mode, row, offset));
        try { assert.equal(page.area.hidden, false); assert.equal(page.input.disabled, false); page.input.focus(); assert.equal(document.activeElement, page.input); }
        finally { assert.equal(page.control.dispose(), true); }
      });
      const shown = inspectEmptyScriptViews(h.a, ui => {
        const page = mounted(h.a, ui.session, mode === "writer" ? ui.writerRoot : ui.splitRoot, "1", (row, offset) => ui.place(mode, row, offset));
        try {
          assert.equal(ui.session.read(doc => doc?.rows.length), 0);
          type(page.input, "Hi");
          assert.equal(page.area.hidden, true);
          const node = document.getSelection()?.anchorNode;
          const cell = mode === "writer" ? (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>(".wr-beat") : document.activeElement;
          assert.ok(cell instanceof HTMLElement);
          assert.equal(cell.dataset.id, firstEmptyScriptBeat);
          assert.deepEqual(cellSelection(cell), { from: 2, to: 2 });
          assert.deepEqual(page.notices, []);
          assert.deepEqual([...collabState(h.a).ingress.holds], []);
        } finally { assert.equal(page.control.dispose(), true); }
      });
      assert.equal(shown.writerBeats, 1); assert.equal(shown.splitCells, 2); assert.equal(shown.writerHeadings, 0);
      agrees(h, name, [emptyScriptRow(firstEmptyScriptBeat, "Hi")], order);
      const other = inspectEmptyScriptViews(h.b); assert.equal(other.writerBeats, 1); assert.equal(other.splitCells, 2); assert.equal(other.writerHeadings, 0);
    } finally { h.close(); }
  });
}

for (const name of emptyScriptHistories) for (const order of ["dup", "rev"] as const) test("rule 91: simultaneous first input keeps both copies' text after " + name + "/" + order, () => {
  const h = removedEmptyScript(name, order), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  document.body.innerHTML = "<section><div></div><div></div></section>";
  const hosts = document.querySelectorAll<HTMLElement>("section > div"), one = hosts[0], two = hosts[1]; assert.ok(one && two);
  const placed: unknown[] = [];
  const pa = mounted(h.a, a.session, one, "1", (row, offset) => { placed.push(["A", row, offset]); return true; });
  const pb = mounted(h.b, b.session, two, "2", (row, offset) => { placed.push(["B", row, offset]); return true; });
  try {
    type(pa.input, "one", () => { type(pb.input, "two", undefined, false); h.queue.deliverFrom("B", order); assert.equal(a.session.read(doc => doc?.rows.length), 0); });
    agrees(h, name, [emptyScriptRow(firstEmptyScriptBeat, "one"), emptyScriptRow(secondEmptyScriptBeat, "two", "Bob")], order);
    assert.deepEqual(placed, [["B", secondEmptyScriptBeat, 3], ["A", firstEmptyScriptBeat, 3]]);
    assert.deepEqual([pa.notices, pb.notices, [...collabState(h.a).ingress.holds], [...collabState(h.b).ingress.holds]], [[], [], [], []]);
    for (const handle of [h.a, h.b]) { const visible = inspectEmptyScriptViews(handle); assert.equal(visible.writerBeats, 2); assert.equal(visible.splitCells, 4); assert.equal(visible.writerHeadings, 0); }
  } finally { pa.control.dispose(); pb.control.dispose(); a.session.dispose(); b.session.dispose(); h.close(); }
});

test("rule 91: composition holds ingress and refuses unmount until its initial text is committed", () => {
  const h = removedEmptyScript("only scene", "dup"), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  document.body.innerHTML = "<div id=one></div><div id=two></div>";
  const one = document.getElementById("one"), two = document.getElementById("two"); assert.ok(one && two);
  const pa = mounted(h.a, a.session, one, "1", () => true), pb = mounted(h.b, b.session, two, "2", () => true);
  try {
    pa.input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    pa.input.value = "漢";
    pa.input.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: "漢", isComposing: true, bubbles: true }));
    type(pb.input, "two"); h.queue.deliverFrom("B", "dup");
    assert.equal(a.session.read(doc => doc?.rows.length), 0); assert.equal(pa.control.dispose(), false);
    assert.equal(pa.area.isConnected, true); assert.equal(pa.input.value, "漢");
    pa.input.dispatchEvent(new window.CompositionEvent("compositionend", { data: "漢", bubbles: true }));
    agrees(h, "only scene", [emptyScriptRow(firstEmptyScriptBeat, "漢"), emptyScriptRow(secondEmptyScriptBeat, "two", "Bob")], "dup");
    assert.deepEqual(pa.notices, ["buffer-composition"]);
    assert.equal(pa.control.dispose(), true);
  } finally { pa.control.dispose(); pb.control.dispose(); a.session.dispose(); b.session.dispose(); h.close(); }
});

test("rule 91: a cancelled composition and a cancelled native key create nothing and release their holds", () => {
  const h = removedEmptyScript("last beat", "dup"), a = sharedHarness(adapterReplica(h.a));
  document.body.innerHTML = "<div id=host></div>";
  const host = document.getElementById("host"); assert.ok(host);
  const page = mounted(h.a, a.session, host, "1", () => true);
  try {
    page.input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })); page.input.value = "cancel";
    page.input.dispatchEvent(new window.CompositionEvent("compositionend", { data: "", bubbles: true }));
    page.input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true }));
    assert.equal(page.control.finish(), false);
    page.input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "x", bubbles: true }));
    assert.deepEqual(a.executed, []); assert.deepEqual([...collabState(h.a).ingress.holds], []);
    agrees(h, "last beat", [], "dup"); assert.equal(page.area.hidden, false);
  } finally { page.control.dispose(); a.session.dispose(); h.close(); }
});

test("seeded rule 91: three simultaneous starts, both delivery orders, duplicates and a late joiner", () => {
  let seed = 0x91c6;
  for (let step = 0; step < 20; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const name = emptyScriptHistories[step % emptyScriptHistories.length]; assert.ok(name);
    const order = seed & 1 ? "dup" : "rev", h = removedEmptyScript(name, order);
    assert.equal(applySharedUpdate(h.c, encodeSharedState(h.a)).ok, true); h.queue.addReplica("C", deliveryReplica(h.c));
    registerSharedOperationFamilies(h.c, createFlowLoadRuntime());
    const sessions = [h.a, h.b, h.c].map(handle => sharedHarness(adapterReplica(handle)));
    document.body.innerHTML = "<div id=hosts><div></div><div></div><div></div></div>";
    const hosts = [...document.querySelectorAll<HTMLElement>("#hosts > div")];
    const pages = sessions.map((session, index) => { const handle = [h.a, h.b, h.c][index], host = hosts[index]; assert.ok(handle && host); return mounted(handle, session.session, host, String(index + 1), () => true); });
    try {
      for (const index of seed & 2 ? [2, 0, 1] : [1, 2, 0]) { const page = pages[index], text = ["one", "two", "three"][index]; assert.ok(page && text); type(page.input, text); }
      agrees(h, name, [emptyScriptRow(firstEmptyScriptBeat, "one"), emptyScriptRow(secondEmptyScriptBeat, "two", "Bob"), emptyScriptRow("structure_3_00770033005f0031_beat_0", "three", "Cara")], order);
      for (const page of pages) assert.deepEqual(page.notices, []);
    } finally { for (const page of pages) page.control.dispose(); for (const session of sessions) session.session.dispose(); h.close(); }
  }
});
