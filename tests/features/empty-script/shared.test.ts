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
import { holdSharedBuffer } from "../../../src/adapters/collab/ingress.ts";
import { sharedCommandRefusalNotice } from "../../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { fakeNotices } from "../fakes.ts";

function mounted(handle: SharedDocumentHandle, session: ReturnType<typeof sharedHarness>["session"], host: HTMLElement, writer: string,
  place: EmptyScriptPorts["place"], author = sharedAuthorPort({ handle: () => handle, name: () => writer === "1" ? "Alice" : writer === "2" ? "Bob" : "Cara" })) {
  const notices: string[] = [], display = fakeNotices();
  const control = mountSharedEmptyScript({ handle, session, author, writer: () => writer, stamps: bufferStamps(writer === "1" ? "Alice" : writer === "2" ? "Bob" : "Cara") },
    { host, edits: { allowed: () => true }, notices: { show: (message, kind) => { assert.equal(kind, "warn"); notices.push(message); return display.notices.show(message, kind); } }, report: outcome => { assert.notEqual(outcome.kind, "rejected"); notices.push(outcome.kind); }, place });
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

function agrees(h: ReturnType<typeof removedEmptyScript>, name: typeof emptyScriptHistories[number], rows: readonly Record<string, unknown>[], order: "D1" | "dup" | "rev") {
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
    const h = removedEmptyScript(name, order), late = createMonitoredSharedDocument();
    try {
      assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
      for (const handle of [h.a, h.b, late]) inspectEmptyScriptViews(handle, ui => {
        const page = mounted(handle, ui.session, mode === "writer" ? ui.writerRoot : ui.splitRoot, handle === h.a ? "1" : handle === h.b ? "2" : "3", (row, offset) => ui.place(mode, row, offset));
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
    } finally { destroySharedDocument(late); h.close(); }
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
    pa.input.focus();
    pa.input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    pa.input.blur(); assert.deepEqual(pa.notices, []);
    pa.input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Process", bubbles: true }));
    type(pb.input, "two"); h.queue.deliverFrom("B", "dup");
    assert.equal(a.session.read(doc => doc?.rows.length), 0);
    assert.equal(pa.input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertCompositionText", data: "漢", bubbles: true, cancelable: true })), true);
    pa.input.value = "漢";
    pa.input.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: "漢", isComposing: true, bubbles: true }));
    assert.equal(a.session.read(doc => doc?.rows.length), 0); assert.equal(pa.control.dispose(), false);
    assert.equal(pa.area.isConnected, true); assert.equal(pa.input.value, "漢");
    pa.input.dispatchEvent(new window.CompositionEvent("compositionend", { data: "漢", bubbles: true }));
    agrees(h, "only scene", [emptyScriptRow(firstEmptyScriptBeat, "漢"), emptyScriptRow(secondEmptyScriptBeat, "two", "Bob")], "dup");
    assert.deepEqual(pa.notices, ["This is not available in a shared session yet."]);
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

for (const refusal of ["empty-script-no-author", "empty-script-identity-unavailable", "empty-script-placement-unavailable", "viewing-only"] as const) {
  test("rule 91: refused first input keeps its text and writes nothing: " + refusal, () => {
    const h = removedEmptyScript("last beat", "dup"), a = sharedHarness(adapterReplica(h.a));
    if (refusal === "empty-script-placement-unavailable") collabState(h.a).doc.getArray<unknown>("order").insert(0, [0]);
    if (refusal === "viewing-only") a.deny("viewing-only");
    document.body.innerHTML = "<div id=host></div>";
    const host = document.getElementById("host"); assert.ok(host);
    const page = mounted(h.a, a.session, host, refusal === "empty-script-identity-unavailable" ? "invalid" : "1", () => true,
      refusal === "empty-script-no-author" ? { next: () => null } : undefined);
    try {
      const before = encodeSharedState(h.a);
      type(page.input, "kept");
      assert.equal(page.input.value, "kept"); assert.equal(page.area.hidden, false);
      assert.deepEqual(page.notices, ["This is not available in a shared session yet."]); assert.deepEqual(a.executed, []);
      assert.deepEqual(encodeSharedState(h.a), before);
    } finally { page.input.value = ""; page.control.dispose(); a.session.dispose(); h.close(); }
  });
}

test("rule 91: a session refusal shows once through the shared notice and retains the draft", () => {
  const h = removedEmptyScript("last beat", "D1"), display = fakeNotices(), refused: string[] = [];
  const notice = sharedCommandRefusalNotice(display.notices);
  const a = sharedHarness(adapterReplica(h.a), { refused: reason => { refused.push(reason); notice(reason); } });
  a.deny("viewing-only");
  document.body.innerHTML = "<div id=host></div>";
  const host = document.getElementById("host"); assert.ok(host);
  const page = mounted(h.a, a.session, host, "1", () => true);
  try {
    const before = encodeSharedState(h.a);
    type(page.input, "kept");
    assert.equal(page.input.value, "kept"); assert.equal(page.area.hidden, false);
    assert.deepEqual(refused, ["viewing-only"]);
    assert.deepEqual(display.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
    assert.deepEqual(page.notices, []); assert.deepEqual(a.executed, []);
    assert.deepEqual(encodeSharedState(h.a), before); agrees(h, "last beat", [], "D1");
  } finally { page.input.value = ""; page.control.dispose(); a.session.dispose(); h.close(); }
});

test("rule 91: first input cannot take another buffer's ingress hold", () => {
  const h = removedEmptyScript("last beat", "dup"), a = sharedHarness(adapterReplica(h.a)), release = holdSharedBuffer(h.a);
  document.body.innerHTML = "<div id=host></div>";
  const host = document.getElementById("host"); assert.ok(host);
  const page = mounted(h.a, a.session, host, "1", () => true);
  try {
    assert.equal(page.input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true })), false);
    assert.deepEqual(a.executed, []); assert.deepEqual(page.notices, ["This is not available in a shared session yet."]);
    assert.equal(page.control.dispose(), true); assert.deepEqual([...collabState(h.a).ingress.holds], ["buffer"]);
  } finally { release(); page.control.dispose(); a.session.dispose(); h.close(); }
});

for (const order of ["D1", "rev"] as const) test("rule 91: refused input fallback can never publish its unadmitted text, while a held draft survives/" + order, () => {
  const h = removedEmptyScript("last beat", order), a = sharedHarness(adapterReplica(h.a));
  let releaseOther: (() => void) | null = holdSharedBuffer(h.a), ready = false;
  const author = sharedAuthorPort({ handle: () => h.a, name: () => "Alice" });
  document.body.innerHTML = "<div id=host></div>";
  const host = document.getElementById("host"); assert.ok(host);
  const page = mounted(h.a, a.session, host, "1", () => true, { next: () => ready ? author.next() : null });
  const nativeInput = (text: string) => {
    page.input.value = text;
    return page.input.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
  };
  try {
    const before = encodeSharedState(h.a);
    assert.equal(nativeInput("rejected"), true); assert.equal(page.input.value, "");
    assert.deepEqual(page.notices, ["This is not available in a shared session yet."]); assert.deepEqual(a.executed, []);
    assert.deepEqual([...collabState(h.a).ingress.holds], ["buffer"]);
    releaseOther(); releaseOther = null;
    assert.equal(page.control.finish(), true); assert.deepEqual(a.executed, []); assert.deepEqual(encodeSharedState(h.a), before);
    agrees(h, "last beat", [], order);
    assert.equal(nativeInput("kept"), true); assert.equal(page.input.value, "kept");
    assert.equal(nativeInput("kept again"), true); assert.equal(page.input.value, "kept again");
    assert.deepEqual(a.executed, []); assert.deepEqual([...collabState(h.a).ingress.holds], ["buffer"]);
    assert.deepEqual(page.notices, ["This is not available in a shared session yet.", "This is not available in a shared session yet.", "This is not available in a shared session yet."]);
    ready = true; assert.equal(page.control.finish(), true);
    agrees(h, "last beat", [emptyScriptRow(firstEmptyScriptBeat, "kept again")], order);
    assert.deepEqual([...collabState(h.a).ingress.holds], []);
  } finally { releaseOther?.(); page.input.value = ""; page.control.dispose(); a.session.dispose(); h.close(); }
});

for (const text of ["   ", "  both ends  "]) for (const order of ["D1", "rev"] as const) for (const mode of ["writer", "split"] as const) {
  test("rule 91: first input keeps whitespace in " + mode + "/" + order + "/" + JSON.stringify(text), () => {
    const h = removedEmptyScript("last beat", order);
    try {
      inspectEmptyScriptViews(h.a, ui => {
        const page = mounted(h.a, ui.session, mode === "writer" ? ui.writerRoot : ui.splitRoot, "1", (row, offset) => ui.place(mode, row, offset));
        try {
          type(page.input, text); assert.equal(page.area.hidden, true); assert.equal(page.input.value, "");
          const node = document.getSelection()?.anchorNode;
          const cell = mode === "writer" ? (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>(".wr-beat") : document.activeElement;
          assert.ok(cell instanceof HTMLElement); assert.equal(cell.dataset.id, firstEmptyScriptBeat);
          assert.deepEqual(cellSelection(cell), { from: text.length, to: text.length }); assert.deepEqual(page.notices, []);
        } finally { assert.equal(page.control.dispose(), true); }
      });
      agrees(h, "last beat", [emptyScriptRow(firstEmptyScriptBeat, text)], order);
    } finally { h.close(); }
  });
}

test("rule 91: a failed first command is surfaced and its native text is retained", () => {
  const h = removedEmptyScript("last beat", "dup"), a = sharedHarness(adapterReplica(h.a));
  document.body.innerHTML = "<div id=host></div>";
  const host = document.getElementById("host"); assert.ok(host);
  const failure = new Error("command failed");
  const page = mounted(h.a, { ...a.session, run: () => ({ kind: "failed", error: failure }) }, host, "1", () => true);
  try {
    page.input.value = "kept"; assert.throws(() => page.control.finish(), failure);
    assert.equal(page.input.value, "kept"); assert.deepEqual(a.executed, []);
  } finally { page.input.value = ""; page.control.dispose(); a.session.dispose(); h.close(); }
});

test("rule 91: a committed creation with an effect failure is not retried as another first beat", () => {
  const h = removedEmptyScript("last beat", "dup"), failure = new Error("dirty effect failed");
  const a = sharedHarness(adapterReplica(h.a), { effect: name => { if (name === "dirty") throw failure; } });
  document.body.innerHTML = "<div id=host></div>";
  const host = document.getElementById("host"); assert.ok(host);
  const page = mounted(h.a, a.session, host, "1", () => true);
  try {
    type(page.input, "kept"); assert.equal(page.input.value, ""); assert.equal(page.area.hidden, true);
    assert.equal(page.control.finish(), true); assert.equal(a.executed.length, 1); assert.deepEqual(page.notices, []);
    assert.deepEqual(a.reported, [failure]); assert.deepEqual([...collabState(h.a).ingress.holds], []);
    agrees(h, "last beat", [emptyScriptRow(firstEmptyScriptBeat, "kept")], "dup");
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
      assert.deepEqual(projectSharedDocumentWithRecovery(h.c), { document: emptyScriptDocument([
        emptyScriptRow(firstEmptyScriptBeat, "one"), emptyScriptRow(secondEmptyScriptBeat, "two", "Bob"), emptyScriptRow("structure_3_00770033005f0031_beat_0", "three", "Cara")
      ]), recovery: emptyScriptRecovery(name) });
      for (const page of pages) assert.deepEqual(page.notices, []);
    } finally { for (const page of pages) page.control.dispose(); for (const session of sessions) session.session.dispose(); h.close(); }
  }
});
