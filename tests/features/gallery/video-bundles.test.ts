import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DesktopBundleCarry, DesktopBundleCopy, DesktopBundleSavePlan } from "../../../src/application/media/desktop-video.ts";
import type { UndoEntry, UndoState } from "../../../src/application/editing/undo/history.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import type { BundledPathLink, VideoLink } from "../../../src/core/document/gallery.ts";
import type { VideoBundlePorts } from "../../../src/features/gallery/ports.ts";
import { BUNDLE_WARN_BYTES, bundlePromptText, saveCopyPromptText, startVideoBundles } from "../../../src/features/gallery/video-bundles.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices, fakeOwnership } from "../fakes.ts";

const PAGE = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");
const MARKUP = /<div class="modal-backdrop" id="bundle-modal"[\s\S]*?<div class="bundle-progress"[\s\S]*?<\/div>\s*<button[^>]*id="bundle-indicator"[^>]*><\/button>/.exec(PAGE)?.[0] ?? "";
const DROP = { name: "take one.mp4", size: 9, path: "C:\\Drops\\take one.mp4" };
const ENTRY = { steps: [] } as unknown as UndoEntry;

interface Setup {
  script?: string | null;
  fold?: boolean;
  answer?: (link: VideoLink, job: string, onProgress: (p: { done: number; total: number }) => void) => Promise<DesktopBundleCopy>;
  plan?: DesktopBundleSavePlan | null;
  chosen?: readonly BundledPathLink[] | null | Error;
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
  const plans: { handle: unknown; names: string[] }[] = [];
  const choices: { handle: unknown; choice: string }[] = [];
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
    saves: {
      plan: async (handle, names) => { plans.push({ handle, names: [...names] }); return opts.plan === undefined ? null : opts.plan; },
      choose: async (handle, choice) => {
        choices.push({ handle, choice });
        if (opts.chosen instanceof Error) throw opts.chosen;
        return opts.chosen === undefined ? [] : opts.chosen;
      }
    },
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
  return { at, doc, notices, ownership, calls, cancels, carry, folds, edits, plans, choices, owner, el, location: () => rowSlots(doc.rows[0])[0]?.links[0]?.location };
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

test("nothing pending means nothing to wait for before a Save As, and an open prompt closes keeping the path", async () => {
  const h = setup();
  const idle = h.owner.beginSave();
  assert.equal(idle.drained, null);
  idle.end();
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  const asked = h.owner.beginSave();
  assert.equal(asked.drained, null, "a prompt not yet answered has started no copy");
  assert.equal(h.el("bundle-modal").hidden, true, "the save closes the prompt, as Link to where it is");
  asked.end();
  await settle();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  h.owner.dispose();
});

test("a Save As waits for a running copy, which links the drop before the wait ends", async () => {
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  const save = h.owner.beginSave();
  const draining = save.drained;
  assert.ok(draining && finish);
  let done = false;
  void draining.then((ok) => { done = ok; assert.deepEqual(h.location(), { kind: "bundled", name: "take one (2).mp4" }); });
  await settle();
  assert.equal(done, false, "the wait lasts as long as the copy");
  assert.equal(h.el("bundle-progress").hidden, false, "the wait shows the progress panel with Cancel");
  finish({ ok: true, name: "take one (2).mp4" });
  assert.equal(await draining, true);
  assert.equal(done, true);
  assert.equal(h.notices.shown[0]?.message, "Copied “take one.mp4” to “Episode 12 files”.");
  save.end();
  h.owner.dispose();
});

test("Cancel ends the wait at once though the copy never answers, and later saves do not wait on it", async () => {
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  const save = h.owner.beginSave();
  assert.ok(save.drained && finish);
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, ["bundle1"]);
  assert.equal(await save.drained, false, "the wait ends without the stalled copy answering");
  assert.equal(h.el("bundle-progress").hidden, true);
  save.end();
  const again = h.owner.beginSave();
  assert.equal(again.drained, null, "a copy already cancelled is not waited for again");
  finish({ ok: true, name: "take one (2).mp4" });
  await settle();
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path }, "a late answer during a save leaves the path");
  again.end();
  const left = setup({ answer: () => new Promise(() => {}) });
  left.owner.offerAfterDrop("r1", [DROP], ENTRY);
  left.el("bundle-accept").click();
  const closing = left.owner.beginSave().drained;
  assert.ok(closing);
  left.owner.dispose();
  await closing;
  h.owner.dispose();
});

test("an attached file follows the same save window: no prompt during a save, the save waits for its copy, and Cancel ends the wait (#256)", async () => {
  const PDF = { name: "brief.pdf", size: 4, path: "C:\\Drops\\brief.pdf" };
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  const open = h.owner.beginSave();
  h.owner.offerAfterDrop("r1", [PDF], ENTRY);
  assert.equal(h.el("bundle-modal").hidden, true, "a file dropped during a save is linked by its path with no prompt");
  open.end();
  h.owner.offerAfterDrop("r1", [PDF], ENTRY);
  assert.equal(h.el("bundle-title").textContent, "Copy this file into the script's folder?");
  h.el("bundle-accept").click();
  assert.deepEqual(h.calls.map((c) => c.link.name), ["brief.pdf"]);
  const save = h.owner.beginSave();
  assert.ok(save.drained && finish, "the save waits for the file's copy");
  assert.equal(h.el("bundle-progress-text").textContent, "Copying “brief.pdf” to “Episode 12 files” — 0%");
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, ["bundle1"]);
  assert.equal(await save.drained, false, "Cancel ends the wait for a file as for a video");
  save.end();
  h.owner.dispose();
});

test("a late answer for a cancelled copy relinks only while the document still has the same script and no save is running", async () => {
  let finish: ((r: DesktopBundleCopy) => void) | undefined;
  const h = setup({ answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-accept").click();
  const save = h.owner.beginSave();
  h.el("bundle-cancel").click();
  await save.drained;
  save.end();
  assert.ok(finish);
  finish({ ok: true, name: "take one (2).mp4" });
  await settle();
  assert.deepEqual(h.location(), { kind: "bundled", name: "take one (2).mp4" }, "the abandoned save left the script as it was, so the copy is valid");
  h.owner.dispose();
  let later: ((r: DesktopBundleCopy) => void) | undefined;
  const moved = setup({ answer: () => new Promise((resolve) => { later = resolve; }) });
  moved.owner.offerAfterDrop("r1", [DROP], ENTRY);
  moved.el("bundle-accept").click();
  moved.el("bundle-cancel").click();
  moved.ownership.replace();
  assert.ok(later);
  later({ ok: true, name: "take one (2).mp4" });
  await settle();
  assert.deepEqual(moved.location(), { kind: "path", path: DROP.path }, "once the document left that script, the link stays a path");
  moved.owner.dispose();
});

test("a drop during a Save As is linked by path with no prompt, even when that save then fails", async () => {
  const h = setup();
  const save = h.owner.beginSave();
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  assert.equal(h.el("bundle-modal").hidden, true, "no copy prompt while the save runs");
  save.end();
  await settle();
  assert.deepEqual(h.calls, [], "nothing was copied");
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  save.end();
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  assert.equal(h.el("bundle-modal").hidden, false, "after the save, dropping again asks; a second end changes nothing");
  h.owner.dispose();
});

test("main's carry during Save As shows progress, can be cancelled, and reports what it could not copy", () => {
  const h = setup();
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 4, total: 8 });
  assert.equal(h.el("bundle-progress").hidden, false);
  assert.equal(h.el("bundle-progress-text").textContent, "Copying files to “Episode 12 v2 files” — 50%");
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, ["carry1"]);
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 2, total: 2, result: { ok: true, copied: 2, kept: 0, missing: 0 } });
  assert.equal(h.notices.shown[0]?.message, "Copied 2 files to “Episode 12 v2 files”.");
  assert.equal(h.el("bundle-progress").hidden, true);
  h.carry({ job: "carry2", from: "Episode 12 files", to: "Episode 12 v2 files", done: 2, total: 2, result: { ok: true, copied: 0, kept: 1, missing: 1 } });
  assert.equal(h.notices.shown[1]?.message, "1 file could not be copied to “Episode 12 v2 files”, so it does not open from this copy of the script. " +
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

const HANDLE = { name: "Episode 12 v2.splitpage", _desktopId: "fid1" };
const BODY = JSON.stringify({ rows: [{ id: "r1", imageLinks: [{ name: "take.mp4", size: 4, location: { kind: "bundled", name: "take.mp4" } }] }] }, null, 2);
const GB = 1024 * 1024 * 1024;
const PLAN: DesktopBundleSavePlan = { from: "Episode 12 files", to: "Episode 12 v2 files", files: 3, bytes: Math.round(1.8 * GB), copyBytes: Math.round(1.8 * GB), linkable: true };

test("Save As of a script with bundled files asks once, with Copy files and its size as the focused default", async () => {
  const h = setup({ plan: PLAN });
  const save = h.owner.beginSave();
  const asked = save.ask(HANDLE, BODY);
  await settle();
  assert.deepEqual(h.plans, [{ handle: HANDLE, names: ["take.mp4"] }], "main is asked with the names the bytes link, never a path");
  assert.equal(h.el("bundle-save-modal").hidden, false);
  assert.equal(h.el("bundle-save-title").textContent, "Save the files with this script?");
  assert.equal(h.el("bundle-save-detail").textContent, "This script links 3 files in “Episode 12 files” (1.8 GB). Copy files adds them to “Episode 12 v2 files”, " +
    "next to the new script. Otherwise the new script links to the files where they are now.");
  assert.equal(h.el("bundle-save-copy").textContent, "Copy files (1.8 GB)");
  assert.equal(h.el("bundle-save-link").textContent, "Don't copy the files");
  assert.equal(h.el("bundle-save-cancel").textContent, "Cancel");
  assert.equal(document.activeElement, h.el("bundle-save-copy"));
  assert.equal(h.el("bundle-save-warning").hidden, false);
  assert.equal(h.el("bundle-save-warning").textContent, "That is a lot to copy, and it may take a while and use disk space. You can keep working while it copies.");
  assert.equal(h.el("bundle-save-share").hidden, true);
  h.el("bundle-save-copy").click();
  assert.deepEqual(await asked, [], "Copy files changes no link in the document");
  assert.deepEqual(h.choices, [{ handle: HANDLE, choice: "copy" }]);
  assert.equal(h.el("bundle-save-modal").hidden, true);
  save.end();
  h.owner.dispose();
});

test("closing the save prompt gives focus back to where it was", async () => {
  const h = setup({ plan: PLAN });
  const before = document.createElement("button");
  document.body.appendChild(before);
  before.focus();
  const save = h.owner.beginSave();
  const asked = save.ask(HANDLE, BODY);
  await settle();
  assert.equal(document.activeElement, h.el("bundle-save-copy"));
  h.el("bundle-save-cancel").click();
  assert.equal(await asked, null);
  assert.equal(document.activeElement, before, "Cancel returns focus");
  const again = save.ask(HANDLE, BODY);
  await settle();
  h.el("bundle-save-copy").click();
  await again;
  assert.equal(document.activeElement, before, "a choice returns focus too");
  save.end();
  h.owner.dispose();
});

test("Don't copy the files hands the save main's links to adopt; Cancel and Escape abandon the save and tell main nothing", async () => {
  const links = [{ name: "take.mp4", path: "D:\\Episode 12 files\\take.mp4" }];
  const h = setup({ plan: { ...PLAN, files: 1, bytes: 2048, copyBytes: 2048 }, chosen: links });
  const save = h.owner.beginSave();
  const linking = save.ask(HANDLE, BODY);
  await settle();
  assert.equal(h.el("bundle-save-detail").textContent, "This script links 1 file in “Episode 12 files” (2 KB). Copy files adds it to “Episode 12 v2 files”, " +
    "next to the new script. Otherwise the new script links to the file where it is now.");
  h.el("bundle-save-link").click();
  assert.deepEqual(await linking, links, "the save gets the links main resolved, to apply with the write");
  assert.deepEqual(h.choices.map((c) => c.choice), ["link"]);
  const cancelling = save.ask(HANDLE, BODY);
  await settle();
  h.el("bundle-save-cancel").click();
  assert.equal(await cancelling, null);
  const escaping = save.ask(HANDLE, BODY);
  await settle();
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(await escaping, null);
  assert.equal(h.el("bundle-save-modal").hidden, true);
  assert.deepEqual(h.choices.map((c) => c.choice), ["link"], "a cancelled prompt chooses nothing");
  save.end();
  h.owner.dispose();
});

test("a Don't copy refused by main fails the save with main's reason, and an unknown answer writes nothing", async () => {
  const refused = setup({ plan: PLAN, chosen: new Error("1 linked file is missing from “Episode 12 files”") });
  const save = refused.owner.beginSave();
  const asked = save.ask(HANDLE, BODY);
  await settle();
  refused.el("bundle-save-link").click();
  await assert.rejects(asked, /missing from “Episode 12 files”/);
  save.end();
  refused.owner.dispose();
  const unknown = setup({ plan: PLAN, chosen: null });
  const again = unknown.owner.beginSave();
  const linking = again.ask(HANDLE, BODY);
  await settle();
  unknown.el("bundle-save-link").click();
  assert.equal(await linking, null, "a link answer main did not give abandons the save");
  const copying = again.ask(HANDLE, BODY);
  await settle();
  unknown.el("bundle-save-copy").click();
  assert.deepEqual(await copying, [], "Copy files goes on, and main's carry decides");
  again.end();
  unknown.owner.dispose();
});

test("the over-250 MB warning appears only above the threshold, counting only what is still to copy", () => {
  assert.equal(BUNDLE_WARN_BYTES, 250 * 1024 * 1024);
  assert.equal(saveCopyPromptText({ ...PLAN, copyBytes: BUNDLE_WARN_BYTES }).warning, null, "at the threshold there is no warning");
  assert.equal(saveCopyPromptText({ ...PLAN, copyBytes: BUNDLE_WARN_BYTES - 1 }).warning, null);
  assert.ok(saveCopyPromptText({ ...PLAN, copyBytes: BUNDLE_WARN_BYTES + 1 }).warning, "one byte over warns");
  assert.equal(saveCopyPromptText({ ...PLAN, bytes: 2 * BUNDLE_WARN_BYTES, copyBytes: 1024 }).warning, null, "files already in the new folder do not count");
  assert.equal(saveCopyPromptText({ ...PLAN, copyBytes: 300 * 1024 * 1024 }).copy, "Copy files (300 MB)");
});

test("no prompt when main has nothing to copy, or the bytes link no bundled file", async () => {
  const none = setup({ plan: null });
  const save = none.owner.beginSave();
  assert.deepEqual(await save.ask(HANDLE, BODY), []);
  assert.equal(none.el("bundle-save-modal").hidden, true);
  save.end();
  none.owner.dispose();
  const plain = setup({ plan: PLAN });
  const again = plain.owner.beginSave();
  assert.deepEqual(await again.ask(HANDLE, JSON.stringify({ rows: [{ id: "r1", imageLinks: [{ name: "a.mp4", location: { kind: "path", path: "C:\\a.mp4" } }] }] })), []);
  assert.deepEqual(plain.plans, [], "a script with no bundled file does not even ask main");
  assert.equal(plain.el("bundle-save-modal").hidden, true);
  again.end();
  plain.owner.dispose();
});

test("when the files are on a network share, Don't copy is unavailable and the prompt says why", async () => {
  const h = setup({ plan: { ...PLAN, linkable: false } });
  const save = h.owner.beginSave();
  const asked = save.ask(HANDLE, BODY);
  await settle();
  assert.equal((h.el("bundle-save-link") as HTMLButtonElement).disabled, true);
  assert.equal(h.el("bundle-save-share").hidden, false);
  assert.equal(h.el("bundle-save-share").textContent, "“Don't copy the files” is not available: the files are on a network share, which a script cannot link to.");
  h.el("bundle-save-copy").click();
  assert.deepEqual(await asked, []);
  save.end();
  h.owner.dispose();
});

test("while the copy runs in the background a second Save As waits for it, a drop gets no prompt, and Cancel ends the wait", async () => {
  const h = setup();
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 0, total: 1 });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  assert.equal(h.el("bundle-modal").hidden, true, "a drop during the background copy is linked by path with no prompt");
  const second = h.owner.beginSave();
  assert.ok(second.drained, "the second Save As waits for the first copy");
  let done: boolean | null = null;
  void second.drained.then((ok) => { done = ok; });
  await settle();
  assert.equal(done, null);
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 1, total: 1, result: { ok: true, copied: 1, kept: 0, missing: 0 } });
  assert.equal(await second.drained, true, "it goes on once the copy is done");
  second.end();
  h.carry({ job: "carry2", from: "Episode 12 files", to: "Episode 12 v2 files", done: 0, total: 1 });
  const third = h.owner.beginSave();
  assert.ok(third.drained);
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, ["carry2"]);
  assert.equal(await third.drained, false, "Cancel ends the wait");
  third.end();
  h.owner.dispose();
});

test("a background copy that is stopped or fails says how many files were not copied and where they still are, and stays", () => {
  const h = setup();
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 1, total: 4 });
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 1, total: 1, result: { ok: false, code: "CANCELLED", name: "", copied: 1, left: 2 } });
  assert.equal(h.notices.shown[0]?.message, "Stopped copying files to “Episode 12 v2 files”. 2 files were not copied, so they do not open from this copy of the script. " +
    "Look for them in “Episode 12 files”.");
  assert.equal(h.notices.shown[0]?.kind, "error");
  assert.equal(h.notices.shown[0]?.sticky, true);
  h.carry({ job: "carry2", from: "Episode 12 files", to: "Episode 12 v2 files", done: 1, total: 1, result: { ok: false, code: "FAILED", name: "b.mp4", copied: 0, left: 1 } });
  assert.equal(h.notices.shown[1]?.message, "Could not copy “b.mp4” to “Episode 12 v2 files”. 1 file was not copied, so it does not open from this copy of the script. " +
    "Look for it in “Episode 12 files”.");
  assert.equal(h.el("bundle-progress").hidden, true);
  h.owner.dispose();
});

test("Hide tucks the progress panel into a small indicator, which shows the panel again when clicked", () => {
  const h = setup();
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 2, total: 5 });
  assert.equal(h.el("bundle-progress").hidden, false);
  assert.equal(h.el("bundle-indicator").hidden, true);
  h.el("bundle-hide").click();
  assert.equal(h.el("bundle-progress").hidden, true);
  assert.equal(h.el("bundle-indicator").hidden, false);
  assert.equal(h.el("bundle-indicator").textContent, "Copying files — 40%");
  assert.equal(document.activeElement, h.el("bundle-indicator"), "focus moves to the indicator, not lost with the hidden panel");
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 3, total: 5 });
  assert.equal(h.el("bundle-progress").hidden, true, "progress keeps the panel hidden");
  assert.equal(h.el("bundle-indicator").textContent, "Copying files — 60%");
  h.el("bundle-indicator").click();
  assert.equal(h.el("bundle-progress").hidden, false);
  assert.equal(h.el("bundle-indicator").hidden, true);
  assert.equal(document.activeElement, h.el("bundle-hide"), "showing the panel again focuses it");
  h.el("bundle-hide").click();
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 1, total: 1, result: { ok: true, copied: 2, kept: 0, missing: 0 } });
  assert.equal(h.el("bundle-indicator").hidden, true, "the indicator goes when the copy is done");
  assert.equal(h.el("bundle-progress").hidden, true);
  h.owner.dispose();
});
