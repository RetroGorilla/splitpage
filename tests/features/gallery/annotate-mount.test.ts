import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import type { DocumentRow } from "../../../src/core/document/validated.ts";
import type { Mark } from "../../../src/core/document/gallery.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { galleryActions } from "../../../src/features/gallery/actions.ts";
import type { GalleryMount, GalleryPorts } from "../../../src/features/gallery/ports.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices, fakeOwnership, fakePictures, fakeReview } from "../fakes.ts";

type AnnotateState = { tool: string; marks: Mark[]; undo: number; redo: number; ready: boolean };
const win = jsdomWindow() as unknown as Window & typeof globalThis & {
  __annotateTest?: { state: () => AnnotateState | null };
};
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;
realm.getComputedStyle = win.getComputedStyle.bind(win);
const annotate = await import("../../../src/features/gallery/annotate.js");
const page = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");

function element(id: string): HTMLElement {
  const el = win.document.getElementById(id);
  assert.ok(el);
  return el;
}

function click(id: string): void {
  element(id).click();
}

function pointer(type: string, x = 0): void {
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
  Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "pen" } });
  element("annotate-frame").dispatchEvent(event);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

function setup(t: TestContext) {
  const parsed = new win.DOMParser().parseFromString(page, "text/html");
  const modal = parsed.getElementById("annotate-modal");
  assert.ok(modal);
  win.document.body.innerHTML = '<button id="outside">Outside</button>' + modal.outerHTML;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  realm.requestAnimationFrame = (run: FrameRequestCallback) => { frames.set(++nextFrame, run); return nextFrame; };
  realm.cancelAnimationFrame = (id: number) => { frames.delete(id); };
  realm.ResizeObserver = undefined;
  const context: Record<string, unknown> = { measureText: () => ({ width: 20 }) };
  const ctx = new Proxy(context, { get: (target, key): unknown => Reflect.get(target, key) ?? (() => {}) }) as unknown as CanvasRenderingContext2D;
  t.mock.method(element("annotate-frame"), "getBoundingClientRect", () => new win.DOMRect(0, 0, 100, 100));
  t.mock.method(win.HTMLCanvasElement.prototype, "getContext", () => ctx);
  t.mock.method(win.HTMLCanvasElement.prototype, "toBlob", (callback: BlobCallback) => {
    callback(new Blob([new Uint8Array([2])], { type: "image/png" }));
  });
  const store = fakePictures();
  const ref = store.pictures.intern(new Uint8Array([1]));
  assert.ok(ref);
  const reader = fakeDocument(migrateRows({ schema: 2, rows: [{ id: "r1", imageRef: ref }] }, fakeMigration({ [ref.sha256]: ref }).ports));
  const notices = fakeNotices();
  const review = fakeReview();
  const ownership = fakeOwnership();
  const edits: { rowId: string; message: string; row: DocumentRow }[] = [];
  let accepted = true;
  const ports: GalleryPorts = {
    document: reader.document, notices: notices.notices, review: review.review,
    pictures: store.pictures, ownership: ownership.ownership,
    cells: { editGallery: (rowId, message, edit) => {
      const source = reader.document.current()?.rows[0];
      assert.ok(source);
      const row = JSON.parse(JSON.stringify(source)) as DocumentRow;
      edit(row);
      edits.push({ rowId, message, row });
      return accepted;
    } }
  };
  const holder: { current: GalleryMount | null } = { current: null };
  const registry = createActionRegistry();
  const unregister = registerAll(registry, galleryActions(() => holder.current));
  const mount = () => { holder.current = annotate.__init(ports); return holder.current; };
  const loaded = async () => {
    assert.equal(registry.invoke("annotate-picture", "button", { rowId: "r1", slot: 0 }).kind, "ran");
    await settle();
    const img = element("annotate-img");
    Object.defineProperties(img, { naturalWidth: { value: 100, configurable: true }, naturalHeight: { value: 100, configurable: true } });
    img.dispatchEvent(new win.Event("load"));
    await settle();
    assert.equal(win.__annotateTest?.state()?.ready, true);
  };
  const dispose = () => { holder.current?.dispose(); holder.current = null; unregister(); };
  return { ports, registry, reader, store, ref, notices, review, ownership, edits, frames, mount, loaded, dispose,
    refuse: () => { accepted = false; } };
}

test("gallery mounts with ports, refuses review and missing originals, and keeps its action hidden", async (t) => {
  const h = setup(t);
  try {
    assert.equal(h.registry.invoke("annotate-picture", "button").kind, "unavailable");
    h.mount();
    assert.equal(h.registry.view("annotate-picture")?.visible, false);
    h.review.setReviewing(true);
    assert.equal(annotate.openAnnotator("r1", 0), false);
    h.review.setReviewing(false);
    assert.equal(annotate.openAnnotator("absent", 0), false);
    assert.equal(annotate.openAnnotator("r1", 1), false);
    h.store.forget(h.ref.sha256);
    assert.equal(annotate.openAnnotator("r1", 0), true);
    await settle();
    assert.equal(annotate.annotatorOpen(), false);
    assert.equal(h.notices.shown.at(-1)?.message, "The original of this picture isn’t available here, so it can’t be annotated right now.");
    h.reader.replace(null);
    assert.equal(annotate.openAnnotator("r1", 0), false);
  } finally {
    h.dispose();
  }
});

test("drawing, local undo and redo save through picture storage and cell editing", async (t) => {
  const h = setup(t);
  try {
    h.mount();
    await h.loaded();
    pointer("pointerdown");
    pointer("pointerup");
    assert.equal(win.__annotateTest?.state()?.marks.length, 1);
    click("annotate-undo");
    assert.equal(win.__annotateTest?.state()?.marks.length, 0);
    click("annotate-redo");
    assert.equal(win.__annotateTest?.state()?.marks.length, 1);
    click("annotate-done");
    await settle();
    assert.equal(h.edits.length, 1);
    assert.equal(h.edits[0]?.rowId, "r1");
    assert.equal(h.edits[0]?.message, "Picture annotated");
    const saved = h.edits[0];
    assert.ok(saved);
    assert.equal(rowSlots(saved.row)[0]?.annotation?.marks.length, 1);
    assert.equal(h.store.persisted.length, 1);
    assert.equal(annotate.annotatorOpen(), false);
  } finally {
    h.dispose();
  }
});

test("late encoding loses document ownership and never edits the replacement", async (t) => {
  const h = setup(t);
  try {
    let encode: BlobCallback | undefined;
    t.mock.method(win.HTMLCanvasElement.prototype, "toBlob", (callback: BlobCallback) => { encode = callback; });
    h.mount();
    await h.loaded();
    pointer("pointerdown");
    pointer("pointerup");
    click("annotate-done");
    await settle();
    assert.ok(encode);
    h.ownership.replace();
    encode(new Blob([new Uint8Array([2])]));
    await settle();
    assert.equal(h.edits.length, 0);
    assert.equal(annotate.annotatorOpen(), false);
    assert.equal(h.notices.shown.at(-1)?.message, "The annotations were not saved because the script changed.");
  } finally {
    h.dispose();
  }
});

test("a refused gallery edit leaves the annotator open and reports the failure", async (t) => {
  const h = setup(t);
  try {
    h.refuse();
    h.mount();
    await h.loaded();
    pointer("pointerdown");
    pointer("pointerup");
    click("annotate-done");
    await settle();
    assert.equal(h.edits.length, 1);
    assert.equal(annotate.annotatorOpen(), true);
    assert.equal(h.notices.shown.at(-1)?.message, "Could not save the annotations to this picture.");
  } finally {
    h.dispose();
  }
});

test("disposal closes drawing, cancels frames, removes swatches and listeners, and permits remount", async (t) => {
  const h = setup(t);
  try {
    const addWindow = t.mock.method(win, "addEventListener");
    const removeWindow = t.mock.method(win, "removeEventListener");
    const addFrame = t.mock.method(element("annotate-frame"), "addEventListener");
    const removeFrame = t.mock.method(element("annotate-frame"), "removeEventListener");
    const first = h.mount();
    assert.deepEqual(addWindow.mock.calls.map(({ arguments: args }) => args[0]), ["keydown", "resize"]);
    assert.deepEqual(addFrame.mock.calls.map(({ arguments: args }) => args[0]), ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]);
    await h.loaded();
    pointer("pointerdown");
    pointer("pointermove", 20);
    assert.equal(h.frames.size, 1);
    first.dispose();
    first.dispose();
    assert.equal(annotate.annotatorOpen(), false);
    assert.equal(element("annotate-modal").hidden, true);
    assert.equal(element("annotate-colors").children.length, 0);
    assert.equal(h.frames.size, 0);
    assert.equal(win.__annotateTest, undefined);
    assert.deepEqual(removeWindow.mock.calls.map(({ arguments: args }) => args[0]), ["keydown", "resize"]);
    assert.deepEqual(removeFrame.mock.calls.map(({ arguments: args }) => args[0]), ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]);
    const key = new win.KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    win.dispatchEvent(key);
    assert.equal(key.defaultPrevented, false);
    h.mount();
    first.dispose();
    assert.equal(element("annotate-colors").children.length, 6);
    await h.loaded();
    click("annotate-cancel");
    assert.equal(annotate.annotatorOpen(), false);
    assert.equal(h.edits.length, 0);
  } finally {
    h.dispose();
  }
});
