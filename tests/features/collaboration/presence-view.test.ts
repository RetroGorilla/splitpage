import assert from "node:assert/strict";
import { test } from "node:test";
import { location, markRules, mountPresenceView } from "../../../src/features/collaboration/presence.ts";
import type { PresencePeer } from "../../../src/application/collaboration/presence.ts";
import { cssAttr } from "../../../src/features/common/dom.ts";
import { fakePresenceView } from "../fakes.ts";
import { viewHarness } from "../view-harness.ts";

test("location reads Split focus, Writer text selection and visual focus, and clears in Present", t => {
  const h = viewHarness();
  t.after(() => h.window.close());
  h.el("rows").innerHTML = '<div class="cell-editable" tabindex="0" data-id="r1" data-field="visualText">Visual</div>';
  h.el("writer-doc").tabIndex = 0;
  h.el("writer-doc").innerHTML = '<span class="wr-beat" data-id="r2" data-field="audioText">Narration</span>';
  const split = h.el("rows").firstElementChild as HTMLElement;
  const writer = h.el("writer-doc");
  const visual = h.document.createElement("button");
  visual.className = "wr-flow-visual-text";
  visual.dataset.id = "r3";
  visual.dataset.field = "visualText";
  h.el("writer").append(visual);

  assert.deepEqual(location(h.document), { view: "split", beat: null, side: null });
  split.focus();
  assert.deepEqual(location(h.document), { view: "split", beat: "r1", side: "visualText" });
  h.el("writer").hidden = false;
  writer.focus();
  h.document.getSelection()?.collapse(writer.firstElementChild?.firstChild ?? null, 2);
  assert.deepEqual(location(h.document), { view: "writer", beat: "r2", side: "audioText" });
  visual.focus();
  assert.deepEqual(location(h.document), { view: "writer", beat: "r3", side: "visualText" });
  h.el("prompter").hidden = false;
  assert.deepEqual(location(h.document), { view: "present", beat: null, side: null });
});

test("mark rules group peers by beat and side, including the Writer sign for a visual", () => {
  const audio: PresencePeer = { clientId: 1, name: "Ada", color: "#80BDFB", view: "writer", beat: 'r"1', side: "audioText", caret: null };
  const visual: PresencePeer = { ...audio, clientId: 2, color: "#EF958E", side: "visualText" };
  const present: PresencePeer = { ...audio, clientId: 3, view: "present", beat: null, side: null };
  const beat = '[data-id="r\\"1"]';
  assert.deepEqual(markRules([audio, visual, present], cssAttr), [
    { selector: '.rd-block[data-row="r\\"1"]', kind: "dots", color: "#80BDFB", shadows: "-8px 0 #EF958E" },
    { selector: "#rows .row" + beat + " .audio-cell .field-wrap", kind: "dots", color: "#80BDFB", shadows: "none" },
    { selector: "#rows .row" + beat + " .visual-cell .field-wrap", kind: "dots", color: "#EF958E", shadows: "none" },
    { selector: "#writer-doc.is-flow .wr-beat" + beat, kind: "visual", color: "#EF958E" }
  ]);
  assert.deepEqual(markRules([present], cssAttr), []);
});

test("the presence view samples while synced and keeps a marker on a replaced field", async t => {
  const h = viewHarness();
  const original = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: h.window, document: h.document, CSS: { escape: cssAttr } });
  t.after(() => {
    for (const key of ["window", "document", "CSS"] as const) {
      const descriptor = original[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    h.window.close();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.el("rows").innerHTML = '<div class="row" data-id="r1"><div class="cell audio-cell"><div class="field-wrap"></div></div></div>';
  const { collaboration, presence, ports, published } = fakePresenceView();
  const dispose = mountPresenceView(ports);
  collaboration.enter();
  t.mock.timers.tick(100);
  assert.deepEqual(published, []);
  collaboration.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
  t.mock.timers.tick(100);
  assert.deepEqual(published, [{ name: "Ada", color: "#80BDFB", view: "split", beat: null, side: null, caret: null }]);
  const binding = presence.bind(() => {});
  binding.receive([{ clientId: 1, name: "Ada", color: "#80BDFB", view: "split", beat: "r1", side: "audioText", caret: null }]);
  const field = h.document.querySelector<HTMLElement>("#rows .field-wrap");
  assert.equal(field?.dataset.presenceDots, "");
  const replacement = h.document.createElement("div");
  replacement.className = "field-wrap";
  field?.replaceWith(replacement);
  await Promise.resolve();
  assert.equal(replacement.dataset.presenceDots, "");
  assert.equal(field?.dataset.presenceDots, undefined);
  h.fire(h.document.body, "focusin");
  dispose();
  t.mock.timers.tick(100);
  assert.equal(published.length, 1);
  assert.equal(replacement.dataset.presenceDots, undefined);
});

test("the presence view sends the focused cell's selection as a caret, clamping one that leaves a Writer beat to that beat", t => {
  const h = viewHarness();
  const original = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: h.window, document: h.document, CSS: { escape: cssAttr } });
  t.after(() => {
    for (const key of ["window", "document", "CSS"] as const) {
      const descriptor = original[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    h.window.close();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.el("rows").innerHTML = '<div class="cell-editable" tabindex="0" data-id="r1" data-field="audioText">Hello world</div>';
  h.el("writer-doc").tabIndex = 0;
  h.el("writer-doc").innerHTML = '<div class="wr-beat" data-id="r2" data-field="audioText">First</div><div class="wr-beat" data-id="r3" data-field="audioText">Second</div>';
  const asked: unknown[] = [];
  const caret = { anchor: { type: { client: 1, clock: 0 }, item: null, assoc: 0 }, head: { type: { client: 1, clock: 0 }, item: null, assoc: 0 } } as const;
  const { collaboration, ports, published } = fakePresenceView({
    caret: (where, cell, ends) => { asked.push([where.beat, where.side, (cell as HTMLElement).dataset.id, ends]); return caret; }
  });
  const dispose = mountPresenceView(ports);
  collaboration.enter();
  collaboration.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
  const cell = h.document.querySelector<HTMLElement>("#rows .cell-editable") as HTMLElement;
  cell.focus();
  h.document.getSelection()?.setBaseAndExtent(cell.firstChild as Node, 8, cell.firstChild as Node, 2);
  h.document.dispatchEvent(new h.window.Event("selectionchange"));
  t.mock.timers.tick(100);
  assert.deepEqual(asked.at(-1), ["r1", "audioText", "r1", { anchor: 8, head: 2 }]);
  assert.deepEqual(published.at(-1), { name: "Ada", color: "#80BDFB", view: "split", beat: "r1", side: "audioText", caret });

  h.el("writer").hidden = false;
  const writer = h.el("writer-doc");
  writer.focus();
  const [first, second] = writer.querySelectorAll(".wr-beat");
  h.document.getSelection()?.setBaseAndExtent(first?.firstChild as Node, 1, second?.firstChild as Node, 4);
  h.document.dispatchEvent(new h.window.Event("selectionchange"));
  t.mock.timers.tick(100);
  assert.deepEqual(asked.at(-1), ["r3", "audioText", "r3", { anchor: 0, head: 4 }], "an anchor in an earlier beat clamps to this beat's start");
  assert.equal(published.at(-1)?.view, "writer");
  h.document.getSelection()?.setBaseAndExtent(second?.firstChild as Node, 2, first?.firstChild as Node, 3);
  h.document.dispatchEvent(new h.window.Event("selectionchange"));
  t.mock.timers.tick(100);
  assert.deepEqual(asked.at(-1), ["r2", "audioText", "r2", { anchor: 5, head: 3 }], "an anchor in a later beat clamps to this beat's end");
  dispose();
});
