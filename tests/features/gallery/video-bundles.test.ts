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
  carry?: DesktopBundleCarry | null;
}

function setup(opts: Setup = {}) {
  document.body.innerHTML = '<div id="toast-host"></div>' + MARKUP;
  const doc = migrateRows({ rows: [{ id: "r1", imageLinks: [{ name: DROP.name, size: DROP.size, location: { kind: "path", path: DROP.path }, poster: true }] }] }, fakeMigration().ports);
  const notices = fakeNotices();
  const ownership = fakeOwnership();
  const calls: { link: VideoLink; job: string }[] = [];
  const cancels: string[] = [];
  const carries: { toFileId: string; names: readonly string[]; job: string }[] = [];
  const folds: (UndoEntry | null | undefined)[] = [];
  const edits: string[] = [];
  const ports: VideoBundlePorts = {
    window: window,
    script: () => opts.script === undefined ? "Episode 12.splitpage" : opts.script,
    files: {
      bundle: (link, job, onProgress) => {
        calls.push({ link, job });
        return opts.answer ? opts.answer(link, job, onProgress) : Promise.resolve({ ok: true, name: "take one (2).mp4" });
      },
      cancelBundle: (job) => { cancels.push(job); }
    },
    carry: async (toFileId, names, job) => { carries.push({ toFileId, names, job }); return opts.carry === undefined ? { ok: true, copied: names.length, kept: 0, failed: 0 } : opts.carry; },
    notices: notices.notices,
    ownership: ownership.ownership,
    undo: { fold: (entry, _touches, change) => { folds.push(entry); return opts.fold === false ? false : change(doc as unknown as UndoState); } },
    document: fakeDocument(doc).document,
    cells: { editGallery: (rowId, message, edit) => { edits.push(message); const row = doc.rows.find((r) => r.id === rowId); return !!row && !!edit(row); } },
    viewer: { refresh: () => {} }
  };
  const owner = startVideoBundles(ports);
  const el = (id: string) => document.getElementById(id) as HTMLElement;
  return { doc, notices, ownership, calls, cancels, carries, folds, edits, owner, el, location: () => rowSlots(doc.rows[0])[0]?.links[0]?.location };
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

test("Cancel stops the copy in main and the ones waiting behind it", async () => {
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.owner.offerAfterDrop("r1", [DROP, { ...DROP, name: "b.mov", path: "C:\\Drops\\b.mov" }], ENTRY);
  h.el("bundle-accept").click();
  assert.equal(h.calls.length, 1);
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, [h.calls[0]?.job]);
  assert.ok(finish);
  finish({ ok: false, code: "CANCELLED" });
  await settle();
  assert.equal(h.calls.length, 1, "the second video is not copied");
  assert.equal(h.notices.shown[0]?.message, "Stopped copying “take one.mp4”. It links to where it is.");
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  assert.equal(h.el("bundle-progress").hidden, true);
  h.owner.dispose();
});

test("Cancel during a copy keeps a Save As carry waiting behind it", async () => {
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.owner.offerAfterDrop("r1", [DROP, { ...DROP, name: "b.mov", path: "C:\\Drops\\b.mov" }], ENTRY);
  h.el("bundle-accept").click();
  h.owner.carryAfterSaveAs("fid", ["a.mp4"], "Episode 12.splitpage", "Episode 12 v2.splitpage");
  h.el("bundle-cancel").click();
  assert.ok(finish);
  finish({ ok: false, code: "CANCELLED" });
  await settle();
  await settle();
  assert.equal(h.calls.length, 1, "the second video is not copied");
  assert.deepEqual(h.carries.map((c) => [c.toFileId, c.names]), [["fid", ["a.mp4"]]], "the carry still runs");
  assert.deepEqual(h.notices.shown.map((n) => n.message), ["Stopped copying “take one.mp4”. It links to where it is.", "Copied 1 video to “Episode 12 v2 files”."]);
  h.owner.dispose();
});

test("a copy that lands after Save As is carried to the new script's folder", async () => {
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  h.owner.carryAfterSaveAs("fid", [], "Episode 12.splitpage", "Episode 12 v2.splitpage");
  assert.ok(finish);
  finish({ ok: true, name: "take one (2).mp4" });
  await settle();
  await settle();
  assert.deepEqual(h.location(), { kind: "bundled", name: "take one (2).mp4" });
  assert.deepEqual(h.carries.map((c) => [c.toFileId, c.names]), [["fid", ["take one (2).mp4"]]]);
  h.owner.dispose();
  const idle = setup();
  idle.owner.carryAfterSaveAs("fid", [], "Episode 12.splitpage", "Episode 12 v2.splitpage");
  await settle();
  assert.deepEqual(idle.carries, [], "nothing to carry and no copy running");
  idle.owner.dispose();
});

test("Save As carries the bundled videos, and says when some could not be copied", async () => {
  const ok = setup();
  ok.owner.carryAfterSaveAs("fid", ["a.mp4", "b.mov"], "Episode 12.splitpage", "Episode 12 v2.splitpage");
  await settle();
  assert.deepEqual(ok.carries.map((c) => [c.toFileId, c.names]), [["fid", ["a.mp4", "b.mov"]]]);
  assert.equal(ok.notices.shown[0]?.message, "Copied 2 videos to “Episode 12 v2 files”.");
  ok.owner.dispose();
  const partial = setup({ carry: { ok: true, copied: 1, kept: 0, failed: 1 } });
  partial.owner.carryAfterSaveAs("fid", ["a.mp4", "b.mov"], "Episode 12.splitpage", "Episode 12 v2.splitpage");
  await settle();
  assert.equal(partial.notices.shown[0]?.message, "1 video could not be copied to “Episode 12 v2 files”, so it does not open from this copy of the script. " +
    "Look for it in “Episode 12 files”.");
  partial.owner.dispose();
  const stopped = setup({ carry: { ok: false, code: "CANCELLED", copied: 0 } });
  stopped.owner.carryAfterSaveAs("fid", ["a.mp4"], "Episode 12.splitpage", "Episode 12 v2.splitpage");
  await settle();
  assert.equal(stopped.notices.shown[0]?.message, "Stopped copying videos to “Episode 12 v2 files”. The ones not copied are still in “Episode 12 files”.");
  stopped.owner.dispose();
  const none = setup();
  none.owner.carryAfterSaveAs("fid", [], "a.splitpage", "b.splitpage");
  await settle();
  assert.deepEqual(none.carries, []);
  none.owner.dispose();
});
