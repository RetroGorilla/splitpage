import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DesktopBundleCarry, DesktopBundleCopy } from "../../../src/application/media/desktop-video.ts";
import type { UndoEntry, UndoState } from "../../../src/application/editing/undo/history.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import type { VideoLink } from "../../../src/core/document/gallery.ts";
import type { VideoBundlePorts } from "../../../src/features/gallery/ports.ts";
import { bundlePromptText, startVideoBundles } from "../../../src/features/gallery/video-bundles.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices, fakeOwnership } from "../fakes.ts";

const PAGE = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");
const MARKUP = /<div class="modal-backdrop" id="bundle-modal"[\s\S]*?<div class="bundle-progress"[\s\S]*?<\/div>/.exec(PAGE)?.[0] ?? "";
const DROP = { name: "take one.mp4", size: 9, path: "C:\\Drops\\take one.mp4" };
const ENTRY = { steps: [] } as unknown as UndoEntry;

interface Setup {
  script?: string | null;
  fold?: boolean;
  answer?: (link: VideoLink, job: string, onProgress: (p: { done: number; total: number }) => void) => Promise<DesktopBundleCopy>;
}

function setup(opts: Setup = {}) {
  const at = { script: opts.script === undefined ? "Episode 12.splitpage" : opts.script };
  let heard: ((note: DesktopBundleCarry) => void) | null = null;
  document.body.innerHTML = '<div id="toast-host"></div>' + MARKUP;
  const doc = migrateRows({ rows: [{ id: "r1", imageLinks: [{ name: DROP.name, size: DROP.size, location: { kind: "path", path: DROP.path }, poster: true }] }] }, fakeMigration().ports);
  const notices = fakeNotices();
  const ownership = fakeOwnership();
  const calls: { link: VideoLink; job: string }[] = [];
  const cancels: string[] = [];
  const folds: (UndoEntry | null | undefined)[] = [];
  const edits: string[] = [];
  const ports: VideoBundlePorts = {
    window: window,
    script: () => at.script,
    files: {
      bundle: (link, job, onProgress) => {
        calls.push({ link, job });
        return opts.answer ? opts.answer(link, job, onProgress) : Promise.resolve({ ok: true, name: "take one (2).mp4" });
      },
      cancelBundle: (job) => { cancels.push(job); }
    },
    carries: (listener) => { heard = listener; },
    notices: notices.notices,
    ownership: ownership.ownership,
    undo: { fold: (entry, _touches, change) => { folds.push(entry); return opts.fold === false ? false : change(doc as unknown as UndoState); } },
    document: fakeDocument(doc).document,
    cells: { editGallery: (rowId, message, edit) => { edits.push(message); const row = doc.rows.find((r) => r.id === rowId); return !!row && !!edit(row); } },
    viewer: { refresh: () => {} }
  };
  const owner = startVideoBundles(ports);
  const el = (id: string) => document.getElementById(id) as HTMLElement;
  const carry = (note: DesktopBundleCarry): void => {
    assert.ok(heard, "the feature listens for carries from main");
    heard(note);
  };
  return { at, doc, notices, ownership, calls, cancels, carry, folds, edits, owner, el, location: () => rowSlots(doc.rows[0])[0]?.links[0]?.location };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the page carries the prompt and the progress panel", () => {
  assert.ok(MARKUP.includes('id="bundle-accept"') && MARKUP.includes('id="bundle-decline"') && MARKUP.includes('id="bundle-cancel"'));
});

test("a drop onto a saved script asks, with copying as the default answer", () => {
  const h = setup();
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  assert.equal(h.el("bundle-modal").hidden, false);
  assert.equal(h.el("bundle-title").textContent, "Copy this video into the script's folder?");
  assert.equal(h.el("bundle-detail").textContent, "Splitpage can copy “take one.mp4” into “Episode 12 files”, a folder next to this script, " +
    "and link to the copy. Keep that folder with the script, and the video opens wherever the script goes. " +
    "Otherwise the script links to the file where it is now.");
  assert.equal(document.activeElement, h.el("bundle-accept"));
  assert.equal(h.el("bundle-accept").textContent, "Copy it");
  assert.equal(h.el("bundle-decline").textContent, "Link to where it is");
  h.owner.dispose();
});

test("several videos are asked about once", () => {
  assert.deepEqual(bundlePromptText(["a.mp4", "b.mov"], "S files"), {
    title: "Copy these videos into the script's folder?",
    detail: "Splitpage can copy these 2 videos into “S files”, a folder next to this script, and link to the copy. " +
      "Keep that folder with the script, and the videos open wherever the script goes. Otherwise the script links to the files where they are now."
  });
  const h = setup();
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.owner.offerAfterDrop("r1", [{ ...DROP, name: "b.mov", path: "C:\\Drops\\b.mov" }], ENTRY);
  assert.equal(h.el("bundle-title").textContent, "Copy these videos into the script's folder?");
  h.owner.dispose();
});

test("no prompt for a script not saved to disk, or a drop with no path", () => {
  const unsaved = setup({ script: null });
  unsaved.owner.offerAfterDrop("r1", [DROP], ENTRY);
  assert.equal(unsaved.el("bundle-modal").hidden, true);
  unsaved.owner.dispose();
  const browser = setup();
  browser.owner.offerAfterDrop("r1", [{ ...DROP, path: "" }], ENTRY);
  assert.equal(browser.el("bundle-modal").hidden, true);
  browser.owner.dispose();
});

test("declining, by button or Escape, keeps the stored path and copies nothing", async () => {
  const h = setup();
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-decline").click();
  assert.equal(h.el("bundle-modal").hidden, true);
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(h.el("bundle-modal").hidden, true);
  await settle();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  assert.deepEqual(h.notices.shown, []);
  h.owner.dispose();
});

test("copying sends the dropped file, shows progress, and links the drop to the copy in the same undo step", async () => {
  let report: ((p: { done: number; total: number }) => void) | undefined;
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: (_l, _j, onProgress) => { report = onProgress; return new Promise((resolve) => { finish = resolve; }); } });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  assert.deepEqual(h.calls.map((c) => c.link), [{ name: DROP.name, size: DROP.size, location: { kind: "path", path: DROP.path } }]);
  assert.equal(h.el("bundle-progress").hidden, false);
  assert.ok(report && finish);
  report({ done: 3, total: 9 });
  assert.equal(h.el("bundle-progress-text").textContent, "Copying “take one.mp4” to “Episode 12 files” — 33%");
  assert.equal((h.el("bundle-progress-bar") as HTMLProgressElement).value, 3);
  finish({ ok: true, name: "take one (2).mp4" });
  await settle();
  assert.deepEqual(h.location(), { kind: "bundled", name: "take one (2).mp4" });
  assert.deepEqual(h.folds, [ENTRY]);
  assert.deepEqual(h.edits, []);
  assert.equal(h.el("bundle-progress").hidden, true);
  assert.equal(h.notices.shown[0]?.message, "Copied “take one.mp4” to “Episode 12 files”.");
  h.owner.dispose();
});

test("when the drop is no longer the latest gallery edit, the link changes as an edit of its own", async () => {
  const h = setup({ fold: false });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  await settle();
  assert.deepEqual(h.edits, ["Linked to the copy in “Episode 12 files”"]);
  assert.deepEqual(h.location(), { kind: "bundled", name: "take one (2).mp4" });
  h.owner.dispose();
});

test("a failed copy keeps the stored path and says so; another document is never relinked", async () => {
  const failed = setup({ answer: async () => ({ ok: false, code: "FAILED" }) });
  failed.owner.offerAfterDrop("r1", [DROP], ENTRY);
  failed.el("bundle-accept").click();
  await settle();
  assert.deepEqual(failed.location(), { kind: "path", path: DROP.path });
  assert.equal(failed.notices.shown[0]?.message, "Could not copy “take one.mp4” to “Episode 12 files”, so it links to where it is.");
  assert.equal(failed.notices.shown[0]?.kind, "error");
  failed.owner.dispose();
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const moved = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  moved.owner.offerAfterDrop("r1", [DROP], ENTRY);
  moved.el("bundle-accept").click();
  moved.ownership.replace();
  assert.ok(finish);
  finish({ ok: true, name: "take one.mp4" });
  await settle();
  assert.deepEqual(moved.folds, []);
  assert.deepEqual(moved.location(), { kind: "path", path: DROP.path });
  moved.owner.dispose();
});

test("accepting sends every copy to main at once, where the script is bound; Cancel stops all of them", async () => {
  const finishes: ((r: DesktopBundleCopy) => void)[] = [];
  const h = setup({ answer: () => new Promise((resolve) => { finishes.push(resolve); }) });
  h.owner.offerAfterDrop("r1", [DROP, { ...DROP, name: "b.mov", path: "C:\\Drops\\b.mov" }], ENTRY);
  h.el("bundle-accept").click();
  assert.equal(h.calls.length, 2, "main gets both copies when the user accepts, not one at a time later");
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, h.calls.map((c) => c.job));
  finishes.forEach((finish) => finish({ ok: false, code: "CANCELLED" }));
  await settle();
  assert.deepEqual(h.notices.shown.map((n) => n.message), ["Stopped copying “take one.mp4”. It links to where it is.", "Stopped copying “b.mov”. It links to where it is."]);
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  assert.equal(h.el("bundle-progress").hidden, true);
  h.owner.dispose();
});

test("a copy main dropped, because the tab opened another script, says nothing and changes nothing", async () => {
  const h = setup({ answer: async () => ({ ok: false, code: "DROPPED" }) });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  await settle();
  assert.deepEqual(h.notices.shown, []);
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  assert.equal(h.el("bundle-progress").hidden, true);
  h.owner.dispose();
});

test("nothing pending means nothing to wait for before a Save As", () => {
  const h = setup();
  assert.equal(h.owner.drain(), null);
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  assert.equal(h.owner.drain(), null, "a prompt not yet answered has started no copy");
  h.owner.dispose();
});

test("a Save As waits for a running copy, which links the drop before the wait ends", async () => {
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  const draining = h.owner.drain();
  assert.ok(draining && finish);
  let done = false;
  void draining.then(() => { done = true; assert.deepEqual(h.location(), { kind: "bundled", name: "take one (2).mp4" }); });
  await settle();
  assert.equal(done, false, "the wait lasts as long as the copy");
  assert.equal(h.el("bundle-progress").hidden, false, "the wait shows the progress panel with Cancel");
  finish({ ok: true, name: "take one (2).mp4" });
  await draining;
  assert.equal(done, true);
  assert.equal(h.notices.shown[0]?.message, "Copied “take one.mp4” to “Episode 12 files”.");
  h.owner.dispose();
});

test("Cancel during the wait ends it, and the cancelled drop keeps its stored path", async () => {
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  const draining = h.owner.drain();
  assert.ok(draining && finish);
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, ["bundle1"]);
  finish({ ok: false, code: "CANCELLED" });
  await draining;
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  assert.equal(h.notices.shown[0]?.message, "Stopped copying “take one.mp4”. It links to where it is.");
  const left = setup({ answer: () => new Promise(() => {}) });
  left.owner.offerAfterDrop("r1", [DROP], ENTRY);
  left.el("bundle-accept").click();
  const closing = left.owner.drain();
  assert.ok(closing);
  left.owner.dispose();
  await closing;
  h.owner.dispose();
});

test("main's carry during Save As shows progress, can be cancelled, and reports what it could not copy", () => {
  const h = setup();
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 4, total: 8 });
  assert.equal(h.el("bundle-progress").hidden, false);
  assert.equal(h.el("bundle-progress-text").textContent, "Copying videos to “Episode 12 v2 files” — 50%");
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, ["carry1"]);
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 2, total: 2, result: { ok: true, copied: 2, kept: 0, missing: 0 } });
  assert.equal(h.notices.shown[0]?.message, "Copied 2 videos to “Episode 12 v2 files”.");
  assert.equal(h.el("bundle-progress").hidden, true);
  h.carry({ job: "carry2", from: "Episode 12 files", to: "Episode 12 v2 files", done: 2, total: 2, result: { ok: true, copied: 0, kept: 1, missing: 1 } });
  assert.equal(h.notices.shown[1]?.message, "1 video could not be copied to “Episode 12 v2 files”, so it does not open from this copy of the script. " +
    "Look for it in “Episode 12 files”.");
  h.carry({ job: "carry3", from: "Episode 12 files", to: "Episode 12 v2 files", done: 1, total: 1, result: { ok: false, code: "CANCELLED", copied: 0 } });
  assert.equal(h.notices.shown.length, 2, "a carry that failed the save is reported by the save, not here");
  assert.equal(h.el("bundle-progress").hidden, true);
  h.carry({ job: "carry4", from: "a files", to: "b files", done: 1, total: 1, result: { ok: true, copied: 0, kept: 1, missing: 0 } });
  assert.equal(h.notices.shown.length, 2, "a carry that only found copies already there says nothing");
  h.owner.dispose();
  h.carry({ job: "carry5", from: "a files", to: "b files", done: 1, total: 1, result: { ok: true, copied: 1, kept: 0, missing: 0 } });
  assert.equal(h.notices.shown.length, 2, "a disposed feature ignores late notes");
});
