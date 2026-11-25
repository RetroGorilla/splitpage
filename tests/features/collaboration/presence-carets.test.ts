import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { PresenceCaret, PresencePeer } from "../../../src/application/collaboration/presence.ts";
import type { CellEnds } from "../../../src/core/text/selection.ts";
import { mountPresenceCarets, peerMarks } from "../../../src/features/collaboration/presence-carets.ts";
import { fakePresenceCarets } from "../fakes.ts";
import { viewHarness } from "../view-harness.ts";

const caret: PresenceCaret = {
  anchor: { type: { client: 9, clock: 1 }, item: { client: 9, clock: 4 }, assoc: 0 },
  head: { type: { client: 9, clock: 1 }, item: { client: 9, clock: 4 }, assoc: 0 }
};

function peer(overrides: Partial<PresencePeer> = {}): PresencePeer {
  return { clientId: 7, name: "Bea <b>", color: "#EF958E", view: "split", beat: "r1", side: "audioText", caret, ...overrides };
}

function harness(t: TestContext) {
  const h = viewHarness();
  const { window, document } = h;
  const frames: FrameRequestCallback[] = [];
  const observed: Element[] = [];
  const resizes: (() => void)[] = [];
  const original = Object.getOwnPropertyDescriptors(globalThis);
  window.requestAnimationFrame = callback => frames.push(callback);
  window.cancelAnimationFrame = id => { frames.splice(id - 1, 1, () => {}); };
  window.ResizeObserver = class {
    constructor(callback: () => void) { resizes.push(callback); }
    observe(target: Element) { observed.push(target); }
    disconnect() { observed.length = 0; }
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  window.Range.prototype.getClientRects = function (this: Range) {
    const text = this.startContainer.nodeType === 3 && this.startContainer === this.endContainer;
    const left = 100 + (text ? this.startOffset : 0) * 10;
    const width = text ? (this.endOffset - this.startOffset) * 10 : 0;
    const top = this.startContainer.parentElement?.closest("#writer-doc, .wr-flow-visual-box") ? 300 : 50;
    const rect = { left, top, width, height: 20, right: left + width, bottom: top + 20, x: left, y: top };
    return [{ ...rect, toJSON: () => rect }] as unknown as DOMRectList;
  };
  const scroller = document.getElementById("writer-scroll") as HTMLElement;
  scroller.getBoundingClientRect = () => ({ left: 0, top: 200, width: 900, height: 400, right: 900, bottom: 600, x: 0, y: 200 }) as DOMRect;
  const escape = (value: string) => [...value].map(ch => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? "\\" + code.toString(16) + " " : ch === '"' || ch === "\\" ? "\\" + ch : ch;
  }).join("");
  Object.assign(globalThis, { window, document, CSS: { escape } });
  t.after(() => {
    for (const key of ["window", "document", "CSS"] as const) {
      const descriptor = original[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  });
  h.el("rows").innerHTML = '<div class="row" data-id="r1"><div class="cell-editable" data-id="r1" data-field="audioText" contenteditable="true">Hello world</div>' +
    '<div class="cell-editable" data-id="r1" data-field="visualText" contenteditable="true">Wide</div></div>';
  h.el("writer-doc").innerHTML = '<div class="wr-beat" data-id="r1" data-field="audioText">Hello world</div>';
  h.el("writer").insertAdjacentHTML("beforeend",
    '<div class="wr-flow-visual-box" hidden><div class="wr-flow-visual-text" data-id="r1" data-field="visualText" contenteditable="true">Wide</div></div>');
  let ends: CellEnds | null = { anchor: 3, head: 3 };
  const seen: { readonly peer: number; readonly local: number | null }[] = [];
  const fake = fakePresenceCarets({ resolve: (who, _cell, local) => { seen.push({ peer: who.clientId, local }); return ends; } });
  const flush = () => { const pending = frames.splice(0); pending.forEach(frame => frame(0)); return pending.length; };
  const online = () => {
    fake.collaboration.enter();
    fake.collaboration.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
  };
  const layer = () => document.querySelector<HTMLElement>("body > .presence-carets");
  const caretAt = () => {
    const mark = layer()?.querySelector<HTMLElement>(".presence-caret");
    return mark && [mark.style.left, mark.style.top, mark.style.height];
  };
  return { ...h, ...fake, seen, frames, observed, resizes, flush, online, layer, caretAt, setEnds: (next: CellEnds | null) => { ends = next; } };
}

test("in a standalone script the caret overlay adds no listener, no frame and no layer", t => {
  const h = harness(t);
  const dispose = mountPresenceCarets(h.ports);
  h.receive([peer()]);
  assert.equal(h.frames.length, 0);
  assert.deepEqual(h.entries.map(entry => entry.key), []);
  assert.equal(h.layer(), null);
  dispose();
});

test("a peer's caret and selection are drawn in a layer outside the cells, follow moves and go when the peer leaves", async t => {
  const h = harness(t);
  const cell = h.document.querySelector("#rows .cell-editable") as HTMLElement;
  const html = cell.innerHTML;
  const dispose = mountPresenceCarets(h.ports);
  h.online();
  h.receive([peer()]);
  assert.equal(h.flush(), 1);
  assert.deepEqual(h.caretAt(), ["130px", "50px", "20px"]);
  const mark = h.layer()?.querySelector<HTMLElement>(".presence-caret");
  assert.equal(mark?.style.getPropertyValue("--presence-caret-color"), "#EF958E");
  assert.equal(mark?.querySelector(".presence-caret-flag")?.textContent, "Bea <b>");
  assert.equal(mark?.querySelector("b"), null);
  assert.equal(h.layer()?.getAttribute("aria-hidden"), "true");
  assert.equal(h.document.querySelector("#rows .presence-caret, #writer-doc .presence-caret, .cell-editable .presence-selection"), null);
  assert.equal(cell.innerHTML, html);
  assert.deepEqual(h.observed.map(root => root.id || root.className), ["rows", "writer-doc", "wr-flow-visual-text"]);

  h.receive([peer({ caret: { ...caret } })]);
  h.flush();
  assert.equal(h.layer()?.querySelector(".presence-caret"), mark, "an unchanged position keeps the drawn elements");
  h.setEnds({ anchor: 1, head: 6 });
  h.receive([peer({ caret: { ...caret } })]);
  h.flush();
  assert.deepEqual(h.caretAt(), ["160px", "50px", "20px"]);
  const selection = [...h.layer()?.querySelectorAll<HTMLElement>(".presence-selection") ?? []];
  assert.deepEqual(selection.map(part => [part.style.left, part.style.width]), [["110px", "50px"]]);

  (cell.firstChild as Text).data = "Hello, world";
  await Promise.resolve();
  assert.equal(h.frames.length, 1, "painted text changing redraws on the next frame");
  h.setEnds({ anchor: 99, head: 99 });
  h.flush();
  assert.deepEqual(h.caretAt(), ["220px", "50px", "20px"], "an end past the painted text clamps to it");
  (h.el("writer-doc").firstElementChild?.firstChild as Text).data = "Hello there";
  await Promise.resolve();
  assert.equal(h.frames.length, 0, "text changing in the hidden Writer does not redraw the Split view");

  h.receive([]);
  h.flush();
  assert.equal(h.layer()?.children.length, 0);
  assert.deepEqual(h.observed, [], "nothing watches the painted text once no peer has a caret");
  dispose();
  assert.equal(h.layer(), null);
  h.receive([peer()]);
  h.fire(h.window, "scroll");
  h.fire(h.document.body, "focusin");
  assert.equal(h.frames.length, 0, "a disposed overlay no longer listens");
});

test("the overlay follows the shown view: Writer cells, the Writer clip and nothing in Present", t => {
  const h = harness(t);
  const dispose = mountPresenceCarets(h.ports);
  h.online();
  h.receive([peer({ view: "writer" })]);
  h.flush();
  assert.deepEqual(h.caretAt(), ["130px", "50px", "20px"]);
  h.el("writer").hidden = false;
  h.fire(h.document.body, "focusin");
  h.flush();
  assert.deepEqual(h.caretAt(), ["130px", "300px", "20px"]);
  assert.equal(h.layer()?.style.clipPath, "inset(200px " + (h.window.innerWidth - 900) + "px " + (h.window.innerHeight - 600) + "px 0px)");
  h.receive([peer({ side: "visualText" })]);
  h.flush();
  assert.equal(h.caretAt(), null, "a visual box that is not open shows no caret");
  h.receive([peer()]);
  h.el("prompter").hidden = false;
  h.fire(h.document.body, "focusin");
  h.flush();
  assert.equal(h.layer()?.children.length, 0);
  h.collaboration.leave();
  assert.equal(h.layer(), null);
  dispose();
});

test("a peer with a beat id no selector can hold shows nothing and leaves another peer's caret drawing and clearing", t => {
  const h = harness(t);
  const dispose = mountPresenceCarets(h.ports);
  h.online();
  const broken = peer({ clientId: 1, beat: 'r1"]\n' });
  h.receive([broken, peer({ clientId: 2 })]);
  h.flush();
  const marks = [...h.layer()?.querySelectorAll<HTMLElement>(".presence-caret") ?? []];
  assert.deepEqual(marks.map(mark => mark.dataset.client), ["2"]);
  assert.deepEqual(h.seen.map(entry => entry.peer), [2]);
  h.receive([broken]);
  h.flush();
  assert.equal(h.layer()?.children.length, 0);
  h.receive([broken, peer({ clientId: 2 })]);
  h.flush();
  assert.equal(h.layer()?.querySelector<HTMLElement>(".presence-caret")?.dataset.client, "2");
  h.receive([]);
  h.flush();
  assert.equal(h.layer()?.children.length, 0);
  dispose();
});

test("a peer's caret in the Writer visual box follows local typing there, measured around my own caret", async t => {
  const h = harness(t);
  const dispose = mountPresenceCarets(h.ports);
  h.online();
  h.el("writer").hidden = false;
  h.receive([peer({ view: "writer", side: "visualText" })]);
  h.flush();
  assert.equal(h.caretAt(), null);
  const box = h.document.querySelector<HTMLElement>(".wr-flow-visual-box") as HTMLElement;
  const text = box.querySelector<HTMLElement>(".wr-flow-visual-text") as HTMLElement;
  box.hidden = false;
  await Promise.resolve();
  assert.equal(h.frames.length, 1, "the visual box opening redraws");
  h.flush();
  assert.deepEqual(h.caretAt(), ["130px", "300px", "20px"]);
  assert.equal(h.seen.at(-1)?.local, null, "no local caret in the visual box yet");
  text.focus();
  (text.firstChild as Text).data = "WiXde";
  h.document.getSelection()?.collapse(text.firstChild, 3);
  await Promise.resolve();
  assert.equal(h.frames.length, 1, "typing in the visual box redraws");
  h.setEnds({ anchor: 4, head: 4 });
  h.flush();
  assert.deepEqual(h.caretAt(), ["140px", "300px", "20px"]);
  assert.equal(h.seen.at(-1)?.local, 3, "my caret in the visual box is the seam for mapping buffered text");
  dispose();
});

test("a Writer visual box made after tracking starts in Split is watched for size once the Writer shows it", async t => {
  const h = harness(t);
  h.document.querySelector(".wr-flow-visual-box")?.remove();
  const dispose = mountPresenceCarets(h.ports);
  h.online();
  h.receive([peer({ view: "writer", side: "visualText" })]);
  h.flush();
  assert.deepEqual(h.observed.map(root => root.id), ["rows", "writer-doc"]);
  h.el("writer").insertAdjacentHTML("beforeend",
    '<div class="wr-flow-visual-box" hidden><div class="wr-flow-visual-text" data-id="r1" data-field="visualText" contenteditable="true">Wide</div></div>');
  await Promise.resolve();
  assert.equal(h.frames.length, 0, "a box made inside the hidden Writer does not redraw the Split view");
  h.el("writer").hidden = false;
  (h.document.querySelector(".wr-flow-visual-box") as HTMLElement).hidden = false;
  await Promise.resolve();
  h.flush();
  h.flush();
  const text = h.document.querySelector(".wr-flow-visual-text");
  assert.equal(h.observed.filter(root => root === text).length, 1, "the new visual text is watched for size, once");
  assert.deepEqual(h.caretAt(), ["130px", "300px", "20px"]);
  h.resizes.at(-1)?.();
  assert.equal(h.frames.length, 1, "the visual text resizing redraws");
  h.flush();
  assert.equal(h.observed.filter(root => root === text).length, 1);
  dispose();
});

test("marks skip peers without a caret, a painted cell, a resolved position, or a place inside the view", t => {
  const h = harness(t);
  const view = { x: 0, y: 0, width: 800, height: 600 };
  const resolve = (who: PresencePeer) => who.clientId === 3 ? null : { anchor: 2, head: 2 };
  const peers = [peer({ clientId: 1, caret: null }), peer({ clientId: 2, beat: "gone" }), peer({ clientId: 3 }),
    peer({ clientId: 4, view: "present", beat: null, side: null }), peer({ clientId: 5 })];
  assert.deepEqual(peerMarks(h.document, "split", peers, resolve, view).map(mark => [mark.clientId, mark.caret.x]), [[5, 120]]);
  assert.deepEqual(peerMarks(h.document, "split", peers, resolve, { ...view, y: 100 }), []);
});
