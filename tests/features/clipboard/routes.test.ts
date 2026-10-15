import { test } from "node:test";
import assert from "node:assert/strict";
import { mountClipboardRoutes } from "../../../src/features/clipboard/routes.ts";
import type { ClipboardRoutes } from "../../../src/features/clipboard/routes.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;

const ROUTED: ReadonlySet<string> = new Set(["paste", "copy", "cut"]);

interface Owner { readonly n: number }
interface Extra { readonly media: string }

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML =
    '<div id="rows"><div class="row"><div class="cell-editable script" id="rows-script" data-id="r1" data-field="audioText"><b id="inner">Hi</b></div></div>' +
    '<div class="cell-editable" id="rows-note"></div><div id="rows-bare"></div></div>' +
    '<div id="writer-doc"><div class="cell-editable script" id="writer-script" data-id="r2" data-field="audioText"></div></div>' +
    '<div id="outside" class="cell-editable script"></div>';
  const doc = win.document;
  const byId = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement;
  return { win, doc, byId, roots: [byId("rows"), byId("writer-doc")] };
}

function counted(target: EventTarget) {
  const tally = { added: 0, removed: 0 };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => { if (ROUTED.has(type)) tally.added++; add(type, fn, opts); };
  target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => { if (ROUTED.has(type)) tally.removed++; remove(type, fn, opts); };
  return tally;
}

interface Held {
  readonly resolve: (extra: Extra) => void;
}

function harness(p: ReturnType<typeof page>) {
  const state = { review: false, scenes: false, copied: true, owner: 0, owns: true, found: null as Element | null };
  const calls: string[] = [];
  const held: Held[] = [];
  const mount = (): ClipboardRoutes => mountClipboardRoutes<Owner, string, Extra>({
    window: p.win,
    roots: p.roots,
    ports: {
      scriptCell: (el) => el.classList.contains("script"),
      reviewOnly: () => state.review,
      copy: (_e, cell, cut, readOnly) => { calls.push((cut ? "cut:" : "copy:") + cell.id + (readOnly ? ":read" : "")); return state.copied; },
      afterCut: (cell) => { calls.push("afterCut:" + cell.id); },
      pasteScenes: (_data, cell) => { calls.push("scenes:" + cell.id); return state.scenes; },
      pasteDraft: (cell, html, text) => { calls.push("draft:" + cell.id + ":" + html + ":" + text); },
      hasMedia: (files) => !!files && Array.prototype.some.call(files, (f: File) => /^image\//.test(f.type)),
      readMedia: () => new Promise<Extra>((resolve) => { held.push({ resolve }); }),
      capture: () => { calls.push("capture"); return { n: ++state.owner }; },
      stillOwns: (owner) => { calls.push("owns:" + owner.n); return state.owns; },
      notAdded: () => { calls.push("notAdded"); },
      placeOf: (cell) => { calls.push("place:" + cell.id); return "place-" + cell.id; },
      restorePlace: (cell, place) => { calls.push("restore:" + cell.id + ":" + place); },
      findCell: (rowId, field) => { calls.push("find:" + rowId + "." + field); return state.found; },
      insertNow: (cell, html, text, extra) => { calls.push("insert:" + cell.id + ":" + html + ":" + text + ":" + (extra ? extra.media : "none")); }
    }
  });
  return { state, calls, held, mount };
}

function clip(p: ReturnType<typeof page>, type: string, target: EventTarget, data: { html?: string; text?: string; files?: File[] } | null): Event {
  const e = new p.win.Event(type, { bubbles: true, cancelable: true });
  const store: Record<string, string> = { "text/html": data?.html || "", "text/plain": data?.text || "" };
  Object.defineProperty(e, "clipboardData", {
    value: data ? { getData: (t: string) => store[t] || "", setData: () => {}, files: data.files || [] } : null
  });
  target.dispatchEvent(e);
  return e;
}

function release(held: Held[], at: number, extra: Extra): void {
  const one = held[at];
  assert.ok(one, "media preparation " + at + " was started");
  one.resolve(extra);
}

const settle = () => new Promise((r) => setImmediate(r));

test("copy and cut in a script cell call the clipboard once, and a real cut refreshes the cell that holds the caret", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  clip(p, "copy", p.byId("inner"), null);
  clip(p, "cut", p.byId("writer-script"), null);
  assert.deepEqual(h.calls, ["copy:rows-script", "cut:writer-script", "afterCut:writer-script"]);
  h.calls.length = 0;
  p.byId("rows-script").setAttribute("tabindex", "0");
  p.byId("rows-script").focus();
  clip(p, "cut", p.byId("writer-script"), null);
  assert.deepEqual(h.calls, ["cut:writer-script", "afterCut:rows-script"], "the cell the cut left the caret in");
  routes.dispose();
});

test("a cut that took nothing, or a cut in review mode, refreshes nothing; copy and cut outside script cells are left to the browser", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  h.state.copied = false;
  clip(p, "cut", p.byId("rows-script"), null);
  h.state.copied = true;
  h.state.review = true;
  clip(p, "cut", p.byId("rows-script"), null);
  h.state.review = false;
  clip(p, "copy", p.byId("rows-note"), null);
  clip(p, "cut", p.byId("rows-bare"), null);
  clip(p, "copy", p.byId("outside"), null);
  assert.deepEqual(h.calls, ["cut:rows-script", "cut:rows-script:read"]);
  routes.dispose();
});

test("a paste into a script cell tries scenes first, then inserts the text; a draft box takes its own paste", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const e = clip(p, "paste", p.byId("inner"), { html: "<b>x</b>", text: "x" });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(h.calls, ["scenes:rows-script", "insert:rows-script:<b>x</b>:x:none"]);
  h.calls.length = 0;
  h.state.scenes = true;
  clip(p, "paste", p.byId("writer-script"), { text: "scenes" });
  assert.deepEqual(h.calls, ["scenes:writer-script"]);
  h.calls.length = 0;
  clip(p, "paste", p.byId("rows-note"), { html: "<i>n</i>", text: "n" });
  assert.deepEqual(h.calls, ["draft:rows-note:<i>n</i>:n"]);
  h.calls.length = 0;
  const bare = clip(p, "paste", p.byId("rows-bare"), { text: "x" });
  assert.equal(bare.defaultPrevented, false, "outside an editable the browser keeps the paste");
  assert.deepEqual(h.calls, []);
  routes.dispose();
});

test("in review mode a script paste still offers scenes (which refuse with their toast) and inserts nothing", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  h.state.review = true;
  const e = clip(p, "paste", p.byId("rows-script"), { text: "x" });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(h.calls, ["scenes:rows-script"]);
  routes.dispose();
});

test("a media paste captures the owner and the place before preparing, then inserts when it is still the owner", async () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const pic = new p.win.File(["x"], "a.png", { type: "image/png" });
  clip(p, "paste", p.byId("rows-script"), { html: "<p>t</p>", text: "t", files: [pic] });
  assert.deepEqual(h.calls, ["scenes:rows-script", "capture", "place:rows-script"]);
  assert.equal(h.held.length, 1);
  release(h.held, 0, { media: "pic" });
  await settle();
  assert.deepEqual(h.calls.slice(3), ["owns:1", "restore:rows-script:place-rows-script", "insert:rows-script:<p>t</p>:t:pic"]);
  routes.dispose();
});

test("a media-only insert (a drop) restores no place, and a cell redrawn meanwhile is found again by row and field", async () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const cell = p.byId("rows-script");
  routes.insert(cell, "", "", [new p.win.File(["x"], "a.png", { type: "image/png" })]);
  cell.remove();
  h.state.found = p.byId("writer-script");
  release(h.held, 0, { media: "drop" });
  await settle();
  assert.deepEqual(h.calls, ["capture", "place:rows-script", "owns:1", "find:r1.audioText", "insert:writer-script:::drop"]);
  h.calls.length = 0;
  routes.insert(p.byId("writer-script"), "", "", []);
  assert.deepEqual(h.calls, ["insert:writer-script:::none"], "no files, nothing to wait for");
  routes.dispose();
});

test("a media paste whose document changed hands meanwhile (same-id replacement included) is dropped with the not-added notice", async () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  clip(p, "paste", p.byId("rows-script"), { files: [new p.win.File(["x"], "a.png", { type: "image/png" })] });
  h.state.owns = false;
  release(h.held, 0, { media: "late" });
  await settle();
  assert.deepEqual(h.calls, ["scenes:rows-script", "capture", "place:rows-script", "owns:1", "notAdded"]);
  routes.dispose();
});

test("a media paste whose cell is gone with nowhere to land does nothing", async () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const cell = p.byId("rows-script");
  routes.insert(cell, "", "t", [new p.win.File(["x"], "a.png", { type: "image/png" })]);
  cell.remove();
  release(h.held, 0, { media: "lost" });
  await settle();
  assert.deepEqual(h.calls, ["capture", "place:rows-script", "owns:1", "find:r1.audioText"]);
  routes.dispose();
});

test("dispose removes every registration, and a held media paste completing after dispose or a remount reaches nothing", async () => {
  const p = page();
  const tallies = p.roots.map(counted);
  const h = harness(p);
  const first = h.mount();
  assert.deepEqual(tallies.map((t) => t.added), [3, 3]);
  clip(p, "paste", p.byId("rows-script"), { text: "a", files: [new p.win.File(["x"], "a.png", { type: "image/png" })] });
  first.dispose();
  first.dispose();
  assert.deepEqual(tallies.map((t) => t.removed), [3, 3]);
  release(h.held, 0, { media: "stale" });
  await settle();
  assert.deepEqual(h.calls, ["scenes:rows-script", "capture", "place:rows-script"], "the stale completion asks nothing and inserts nothing");
  h.calls.length = 0;
  clip(p, "copy", p.byId("rows-script"), null);
  first.paste(new p.win.Event("paste") as ClipboardEvent);
  first.insert(p.byId("rows-script"), "x", "x", null);
  assert.equal(h.calls.length, 0, "a disposed owner routes nothing");

  const second = h.mount();
  clip(p, "paste", p.byId("rows-script"), { text: "b", files: [new p.win.File(["x"], "b.png", { type: "image/png" })] });
  second.dispose();
  const third = h.mount();
  release(h.held, 1, { media: "after-remount" });
  await settle();
  assert.equal(h.calls.some((c) => c.startsWith("insert:")), false, "a completion from before the remount is dropped");
  h.calls.length = 0;
  clip(p, "copy", p.byId("rows-script"), null);
  assert.deepEqual(h.calls, ["copy:rows-script"], "exactly one handler per registration after remount");
  h.calls.length = 0;
  clip(p, "paste", p.byId("rows-script"), { text: "c", files: [new p.win.File(["x"], "c.png", { type: "image/png" })] });
  release(h.held, 2, { media: "control" });
  await settle();
  assert.deepEqual(h.calls, ["scenes:rows-script", "capture", "place:rows-script", "owns:3", "restore:rows-script:place-rows-script", "insert:rows-script::c:control"], "a normal completion as the control");
  third.dispose();
  assert.deepEqual(tallies.map((t) => [t.added, t.removed]), [[9, 9], [9, 9]]);
});
