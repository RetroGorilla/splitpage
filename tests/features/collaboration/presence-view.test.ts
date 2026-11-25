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
  const audio: PresencePeer = { clientId: 1, name: "Ada", color: "#80BDFB", view: "writer", beat: 'r"1', side: "audioText" };
  const visual: PresencePeer = { ...audio, clientId: 2, color: "#EF958E", side: "visualText" };
  const present: PresencePeer = { ...audio, clientId: 3, view: "present", beat: null, side: null };
  const rules = markRules([audio, visual, present], cssAttr).split("\n");
  assert.equal(rules.length, 4);
  assert.ok(rules[0]?.startsWith('.rd-block[data-row="r\\"1"]::after'));
  assert.match(rules[0] ?? "", /box-shadow:0px 0 #80BDFB,-8px 0 #EF958E/);
  assert.match(rules[1] ?? "", /audio-cell.*background:#80BDFB/);
  assert.match(rules[2] ?? "", /visual-cell.*background:#EF958E/);
  assert.match(rules[3] ?? "", /wr-beat.*Visual in use.*#EF958E/);
  assert.equal(markRules([present], cssAttr), "");
});

test("the presence view samples only while the relay is synced and cancels pending work on disposal", t => {
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
  const { collaboration, ports, published } = fakePresenceView();
  const dispose = mountPresenceView(ports);
  collaboration.enter();
  t.mock.timers.tick(100);
  assert.deepEqual(published, []);
  collaboration.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
  t.mock.timers.tick(100);
  assert.deepEqual(published, [{ name: "Ada", color: "#80BDFB", view: "split", beat: null, side: null }]);
  h.fire(h.document.body, "focusin");
  dispose();
  t.mock.timers.tick(100);
  assert.equal(published.length, 1);
});
