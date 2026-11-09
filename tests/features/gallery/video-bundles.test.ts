import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  CreateBundlePlan, DesktopBundleCarry, DesktopBundleCopy, DesktopBundleExport, DesktopBundleExportPlan, DesktopBundleMove, DesktopBundleSavePlan
} from "../../../src/application/media/desktop-video.ts";
import type { UndoEntry, UndoState } from "../../../src/application/editing/undo/history.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import type { BundledPathLink, VideoLink } from "../../../src/core/document/gallery.ts";
import type { VideoBundlePorts } from "../../../src/features/gallery/ports.ts";
import { BUNDLE_WARN_BYTES, bundlePromptText, exportFilesText, saveCopyPromptText, startVideoBundles } from "../../../src/features/gallery/video-bundles.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices, fakeOwnership } from "../fakes.ts";

const PAGE = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");
const MARKUP = /<div class="modal-backdrop" id="bundle-modal"[\s\S]*?<div class="bundle-progress"[\s\S]*?<\/div>\s*<button[^>]*id="bundle-indicator"[^>]*><\/button>/.exec(PAGE)?.[0] ?? "";
const DROP = { name: "take one.mp4", size: 9, path: "C:\\Drops\\take one.mp4" };
const ENTRY = { steps: [] } as unknown as UndoEntry;

interface Setup {
  written?: boolean;
  createPlan?: (paths: readonly string[]) => Promise<CreateBundlePlan | null>;
  pathRun?: VideoBundlePorts["create"]["bundlePath"];
  script?: string | null;
  fold?: boolean;
  answer?: (link: VideoLink, job: string, onProgress: (p: { done: number; total: number }) => void) => Promise<DesktopBundleCopy>;
  moved?: (link: VideoLink, job: string, onProgress: (p: { done: number; total: number }) => void) => Promise<DesktopBundleMove>;
  plan?: DesktopBundleSavePlan | null;
  chosen?: readonly BundledPathLink[] | null | Error;
  exportPlan?: DesktopBundleExportPlan | null;
  picked?: { id: string; name: string } | null;
  exported?: (job: string, fileId: string, onProgress: (p: { done: number; total: number }) => void) => Promise<DesktopBundleExport | null>;
}

function setup(opts: Setup = {}) {
  const at = { script: opts.script === undefined ? "Episode 12.splitpage" : opts.script, written: opts.written !== false };
  let heard: ((note: DesktopBundleCarry) => void) | null = null;
  document.body.innerHTML = '<div id="toast-host"></div>' + MARKUP + (/<div class="update-bar" id="bundle-outside-bar"[\s\S]*?<\/div>/.exec(PAGE)?.[0] ?? "");
  const doc = migrateRows({ rows: [{ id: "r1", imageLinks: [{ name: DROP.name, size: DROP.size, location: { kind: "path", path: DROP.path }, poster: true }] }] }, fakeMigration().ports);
  const notices = fakeNotices();
  const ownership = fakeOwnership();
  const reader = fakeDocument(doc);
  const placeListeners = new Set<(change: "home" | "writtenOut") => void>();
  const pathCalls: { path: string; job: string; choice: string }[] = [];
  const calls: { link: VideoLink; job: string }[] = [];
  const moves: { link: VideoLink; job: string }[] = [];
  const cancels: string[] = [];
  const folds: (UndoEntry | null | undefined)[] = [];
  const edits: string[] = [];
  const plans: { handle: unknown; names: string[] }[] = [];
  const choices: { handle: unknown; choice: string }[] = [];
  const exportCalls: unknown[][] = [];
  const ports: VideoBundlePorts = {
    create: {
      planCreate: opts.createPlan ?? (async () => null),
      bundlePath: (path, job, choice, progress) => {
        pathCalls.push({ path, job, choice });
        return opts.pathRun ? opts.pathRun(path, job, choice, progress) : Promise.resolve({ ok: true, name: "take one.mp4" });
      }
    },
    place: { writtenOut: () => at.written, onChange: (listener) => { placeListeners.add(listener); return () => { placeListeners.delete(listener); }; } },
    window: window,
    script: () => at.script,
    files: {
      bundle: (link, job, onProgress) => {
        calls.push({ link, job });
        return opts.answer ? opts.answer(link, job, onProgress) : Promise.resolve({ ok: true, name: "take one (2).mp4" });
      },
      move: (link, job, onProgress) => {
        moves.push({ link, job });
        return opts.moved ? opts.moved(link, job, onProgress) : Promise.resolve({ ok: true, name: "take one (2).mp4", outcome: "moved" });
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
    exports: {
      plan: async (job, scriptName, body, script) => {
        exportCalls.push(["plan", job, scriptName, body, script]);
        return opts.exportPlan === undefined ? { files: 2, bytes: 2048, left: 0 } : opts.exportPlan;
      },
      pick: async (name, job) => { exportCalls.push(["pick", name, job]); return opts.picked === undefined ? { id: "zip1", name } : opts.picked; },
      run: (job, fileId, onProgress) => {
        exportCalls.push(["run", job, fileId]);
        return opts.exported ? opts.exported(job, fileId, onProgress) : Promise.resolve({ ok: true, files: 2, left: 0 });
      }
    },
    notices: notices.notices,
    ownership: ownership.ownership,
    undo: { fold: (entry, _touches, change) => { folds.push(entry); return opts.fold === false ? false : change(doc as unknown as UndoState); } },
    document: reader.document,
    cells: { editGallery: (rowId, message, edit) => { edits.push(message); const row = doc.rows.find((r) => r.id === rowId); return !!row && !!edit(row); } },
    viewer: { refresh: () => {} }
  };
  const owner = startVideoBundles(ports);
  const el = (id: string) => document.getElementById(id) as HTMLElement;
  const carry = (note: DesktopBundleCarry): void => {
    assert.ok(heard, "the feature listens for carries from main");
    heard(note);
  };
  return { at, doc, notices, ownership, calls, moves, cancels, carry, folds, edits, plans, choices, exportCalls, owner, el, pathCalls,
    firstSave: () => { at.script = "Episode 12.splitpage"; at.written = true; placeListeners.forEach((listener) => listener("writtenOut")); },
    reopen: () => { ownership.replace(); reader.replace(doc); },
    location: () => rowSlots(doc.rows[0])[0]?.links[0]?.location };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const CREATE_PLAN: CreateBundlePlan = { files: [{ path: DROP.path, size: 1288490189, move: false }], missing: 2, bundled: [] };

test("Create bundle on open shows a dismissible bar; the dialog lists full paths, size and missing count, with Copy only for document paths", async () => {
  const h = setup({ createPlan: async () => CREATE_PLAN });
  await settle();
  assert.equal(h.el("bundle-modal").hidden, true);
  assert.equal(h.el("bundle-outside-bar").hidden, false);
  assert.equal(h.el("bundle-outside-text").textContent, "1 file is outside this script's folder.");
  h.el("bundle-outside-dismiss").click();
  assert.equal(h.el("bundle-outside-bar").hidden, true);
  await h.owner.createBundle();
  assert.equal(h.el("bundle-title").textContent, "Create bundle?");
  assert.equal(h.el("bundle-detail").textContent, "This script links 1 file outside “Episode 12 files” (1.2 GB). Copy or move them into that folder, next to the script, so they open wherever the script goes.");
  assert.deepEqual([...h.el("bundle-create-paths").children].map((n) => n.textContent), [DROP.path]);
  assert.equal(h.el("bundle-create-missing").textContent, "2 more can't be found, so they stay as they are.");
  assert.equal(h.el("bundle-create-move").textContent, "Move is only offered for files you added since Splitpage started. To move these, copy them, then delete the originals yourself.");
  assert.equal(h.el("bundle-create-warning").hidden, false);
  assert.equal(h.el("bundle-move").hidden, true);
  assert.equal(h.el("bundle-accept").textContent, "Copy (1.2 GB)");
  assert.equal(document.activeElement, h.el("bundle-accept"));
  h.el("bundle-move").click();
  await settle();
  assert.deepEqual(h.pathCalls, [], "even a forced hidden Move click never submits a document path");
  assert.deepEqual(h.moves, []);
  h.reopen();
  await settle();
  assert.equal(h.el("bundle-outside-bar").hidden, false, "dismissal lasts only until reopen");
  h.owner.dispose();
  assert.equal(h.el("bundle-outside-bar").hidden, true);
});

test("Create bundle after the first save waits for the landed save, offers granted Move, and relinks every use of one path with one job", async () => {
  const h = setup({ script: null, written: false, createPlan: async () => ({ ...CREATE_PLAN, files: [{ path: DROP.path, size: 9, move: true }] }),
    pathRun: async (_path, _job, _choice, progress) => { progress({ done: 9, total: 9 }); return { ok: true, name: "take one.mp4", outcome: "moved" }; } });
  const row = h.doc.rows[0];
  assert.ok(row);
  h.doc.rows.push({ ...row, id: "r2", imageLinks: [{ name: DROP.name, size: DROP.size, location: { kind: "path", path: DROP.path } }] });
  await settle();
  const saving = h.owner.beginSave();
  h.firstSave();
  await settle();
  assert.equal(h.el("bundle-modal").hidden, true, "nothing opens while save completion still owns its window");
  saving.end();
  await settle();
  assert.equal(h.el("bundle-modal").hidden, false);
  assert.equal(h.el("bundle-move").hidden, false);
  assert.equal(h.el("bundle-move").textContent, "Move");
  h.el("bundle-move").click();
  await settle();
  assert.deepEqual(h.pathCalls.map((c) => [c.path, c.choice]), [[DROP.path, "move"]]);
  for (const r of h.doc.rows) assert.deepEqual(rowSlots(r)[0]?.links[0]?.location, { kind: "bundled", name: "take one.mp4" });
  assert.ok(h.notices.shown.some((n) => n.message === "Moved 1 file to “Episode 12 files”."));
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.moves, [], "Create bundle uses main's path channel, never a renderer-generated grant");
  h.owner.dispose();
});

test("Create bundle copies through the progress panel, Hide and Cancel, and failed copies keep their path links", async () => {
  let finish: ((result: DesktopBundleCopy) => void) | undefined;
  let progress: ((p: { done: number; total: number }) => void) | undefined;
  const h = setup({ createPlan: async () => CREATE_PLAN,
    pathRun: (_path, _job, _choice, report) => { progress = report; return new Promise((resolve) => { finish = resolve; }); } });
  await settle();
  await h.owner.createBundle();
  h.el("bundle-accept").click();
  assert.ok(progress && finish);
  progress({ done: 3, total: 9 });
  assert.match(h.el("bundle-progress-text").textContent || "", /Copying.*33%/);
  h.el("bundle-hide").click();
  assert.equal(h.el("bundle-indicator").hidden, false);
  h.el("bundle-indicator").click();
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, [h.pathCalls[0]?.job]);
  finish({ ok: false, code: "CANCELLED" });
  await settle();
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  assert.equal(h.el("bundle-progress").hidden, true);
  await h.owner.createBundle();
  h.el("bundle-accept").click();
  finish({ ok: false, code: "FAILED" });
  await settle();
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  assert.ok(h.notices.shown.some((n) => n.message === "1 file couldn't be copied, so it links to where it is."));
  h.owner.dispose();
});

test("an old Create bundle plan never opens over a replaced document or survives disposal", async () => {
  const finishes: ((plan: CreateBundlePlan) => void)[] = [];
  const h = setup({ createPlan: () => new Promise((resolve) => { finishes.push(resolve); }) });
  await settle();
  const open = h.owner.createBundle();
  h.reopen();
  finishes.splice(0).forEach((finish) => finish(CREATE_PLAN));
  await open;
  assert.equal(h.el("bundle-modal").hidden, true);
  await settle();
  h.owner.dispose();
  finishes.splice(0).forEach((finish) => finish(CREATE_PLAN));
  await settle();
  assert.equal(h.el("bundle-modal").hidden, true);
  assert.equal(h.el("bundle-outside-bar").hidden, true);
  assert.deepEqual(h.pathCalls, []);
});

test("Create bundle leaves mixed grants as Copy or Leave, counts each path once, and never turns inspection into a transfer", async () => {
  let inspected: readonly string[] = [];
  const h = setup({ createPlan: async (paths) => {
    inspected = paths;
    return { files: [{ path: DROP.path, size: 9, move: true }, { path: "C:\\Drops\\other.pdf", size: 12, move: false }], bundled: [], missing: 0 };
  } });
  const row = h.doc.rows[0];
  assert.ok(row);
  h.doc.rows.push({ ...row, id: "r2" });
  await settle();
  await h.owner.createBundle();
  assert.deepEqual(inspected, [DROP.path], "duplicate references do not inflate main's plan");
  assert.equal(h.el("bundle-move").hidden, true, "one ungranted file rules out a Move answer for the whole list");
  assert.equal(h.el("bundle-create-missing").hidden, true);
  assert.equal(h.el("bundle-create-warning").hidden, true);
  h.el("bundle-decline").click();
  assert.deepEqual(h.pathCalls, []);
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
  h.owner.dispose();
});

test("a path already inside the folder becomes a bundled name on inspection, without any copy or move", async () => {
  const h = setup({ createPlan: async () => ({ files: [], bundled: [{ path: DROP.path, name: "take one.mp4" }], missing: 0 }) });
  await settle();
  assert.deepEqual(h.location(), { kind: "bundled", name: "take one.mp4" });
  assert.equal(h.el("bundle-outside-bar").hidden, true);
  assert.deepEqual(h.pathCalls, []);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.moves, []);
  h.owner.dispose();
});

test("the page carries the prompt and the progress panel", () => {
  assert.ok(MARKUP.includes('id="bundle-accept"') && MARKUP.includes('id="bundle-move"') && MARKUP.includes('id="bundle-decline"') &&
    MARKUP.includes('id="bundle-cancel"'));
});

test("a drop onto a saved script asks Copy, Move or Leave, with copying as the default answer", () => {
  const h = setup();
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  assert.equal(h.el("bundle-modal").hidden, false);
  assert.equal(h.el("bundle-title").textContent, "Add this video to the script's folder?");
  assert.equal(h.el("bundle-detail").textContent, "Splitpage can copy or move “take one.mp4” into “Episode 12 files”, a folder next to this script. " +
    "Keep that folder with the script, and the file opens wherever the script goes. " +
    "Move takes it out of where it is now, so other scripts that link it there lose it.");
  assert.equal(document.activeElement, h.el("bundle-accept"));
  assert.equal(h.el("bundle-accept").textContent, "Copy it");
  assert.equal(h.el("bundle-move").textContent, "Move it");
  assert.equal(h.el("bundle-decline").textContent, "Leave it where it is");
  const order = [...h.el("bundle-modal").querySelectorAll(".modal-footer-actions button")].map((b) => b.id);
  assert.deepEqual(order, ["bundle-decline", "bundle-move", "bundle-accept"]);
  h.owner.dispose();
});

test("several videos are asked about once", () => {
  assert.deepEqual(bundlePromptText(["a.mp4", "b.mov"], "S files"), {
    title: "Add these videos to the script's folder?",
    detail: "Splitpage can copy or move these 2 files into “S files”, a folder next to this script. " +
      "Keep that folder with the script, and the files open wherever the script goes. " +
      "Move takes them out of where they are now, so other scripts that link them there lose them.",
    leave: "Leave them where they are", move: "Move them", copy: "Copy them"
  });
  assert.equal(bundlePromptText(["a.mp4", "brief.pdf"], "S files").title, "Add these files to the script's folder?");
  assert.equal(bundlePromptText(["brief.pdf"], "S files").title, "Add this file to the script's folder?");
  const h = setup();
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.owner.offerAfterDrop("r1", [{ ...DROP, name: "b.mov", path: "C:\\Drops\\b.mov" }], ENTRY);
  assert.equal(h.el("bundle-title").textContent, "Add these videos to the script's folder?");
  assert.equal(h.el("bundle-accept").textContent, "Copy them");
  assert.equal(h.el("bundle-move").textContent, "Move them");
  assert.equal(h.el("bundle-decline").textContent, "Leave them where they are");
  h.owner.dispose();
});

test("Move sends the drop to main's move, shows Moving progress, and links the drop to the moved file in the same undo step", async () => {
  let report: ((p: { done: number; total: number }) => void) | undefined;
  let finish: ((r: DesktopBundleMove) => void) | undefined;
  const h = setup({ moved: (_l, _j, onProgress) => { report = onProgress; return new Promise((resolve) => { finish = resolve; }); } });
  h.owner.offerAfterDrop("r1", [DROP], ENTRY);
  h.el("bundle-move").click();
  assert.deepEqual(h.calls, [], "a move is never sent as a copy");
  assert.deepEqual(h.moves.map((c) => c.link), [{ name: DROP.name, size: DROP.size, location: { kind: "path", path: DROP.path } }]);
  assert.ok(report && finish);
  report({ done: 3, total: 9 });
  assert.equal(h.el("bundle-progress-text").textContent, "Moving “take one.mp4” to “Episode 12 files” — 33%");
  h.el("bundle-hide").click();
  assert.equal(h.el("bundle-indicator").textContent, "Moving files — 33%");
  finish({ ok: true, name: "take one.mp4", outcome: "moved" });
  await settle();
  assert.deepEqual(h.location(), { kind: "bundled", name: "take one.mp4" });
  assert.deepEqual(h.folds, [ENTRY], "undo of the drop removes the link; it never moves the file back");
  assert.deepEqual(h.notices.shown.map((n) => [n.message, n.kind]), [["Moved “take one.mp4” to “Episode 12 files”.", "ok"]]);
  h.owner.dispose();
});

test("a move that kept both files links the copy and says why the original is still there", async () => {
  for (const [outcome, message] of [
    ["kept", "Copied “take one.mp4” to “Episode 12 files”, but the original couldn't be removed, so it is still where it was."],
    ["changed", "“take one.mp4” changed while it was being moved, so both are kept: the original and the copy in “Episode 12 files”."]
  ] as const) {
    const h = setup({ moved: async () => ({ ok: true, name: "take one (2).mp4", outcome }) });
    h.owner.offerAfterDrop("r1", [DROP], ENTRY);
    h.el("bundle-move").click();
    await settle();
    assert.deepEqual(h.location(), { kind: "bundled", name: "take one (2).mp4" }, outcome);
    assert.deepEqual(h.notices.shown.map((n) => [n.message, n.kind]), [[message, "warn"]], outcome);
    h.owner.dispose();
  }
});

test("a stopped, failed or refused move keeps the stored path and says the file is still where it was", async () => {
  for (const [code, message] of [
    ["CANCELLED", "Stopped moving “take one.mp4”. It is still where it was."],
    ["FAILED", "Could not move “take one.mp4” to “Episode 12 files”, so it links to where it is."],
    ["UNKNOWN", "Could not move “take one.mp4” to “Episode 12 files”, so it links to where it is."]
  ] as const) {
    const h = setup({ moved: async () => ({ ok: false, code }) });
    h.owner.offerAfterDrop("r1", [DROP], ENTRY);
    h.el("bundle-move").click();
    await settle();
    assert.deepEqual(h.location(), { kind: "path", path: DROP.path }, code);
    assert.deepEqual(h.notices.shown.map((n) => n.message), [message], code);
    h.owner.dispose();
  }
  const dropped = setup({ moved: async () => ({ ok: false, code: "DROPPED" }) });
  dropped.owner.offerAfterDrop("r1", [DROP], ENTRY);
  dropped.el("bundle-move").click();
  await settle();
  assert.deepEqual(dropped.notices.shown, [], "a move main dropped for another script says nothing");
  dropped.owner.dispose();
});

test("Cancel stops every move of that answer, and a Save As waits for a running move", async () => {
  const finishes: ((r: DesktopBundleMove) => void)[] = [];
  const h = setup({ moved: () => new Promise((resolve) => { finishes.push(resolve); }) });
  h.owner.offerAfterDrop("r1", [DROP, { ...DROP, name: "b.mov", path: "C:\\Drops\\b.mov" }], ENTRY);
  h.el("bundle-move").click();
  assert.equal(h.moves.length, 2);
  const save = h.owner.beginSave();
  assert.ok(save.drained, "a Save As waits for the moves as for copies");
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, h.moves.map((c) => c.job));
  assert.equal(await save.drained, false);
  save.end();
  finishes.forEach((finish) => finish({ ok: false, code: "CANCELLED" }));
  await settle();
  assert.deepEqual(h.location(), { kind: "path", path: DROP.path });
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
  assert.equal(h.el("bundle-modal").hidden, true, "the save closes the prompt, as Leave it where it is");
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
  assert.equal(h.el("bundle-title").textContent, "Add this file to the script's folder?");
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

test("a carry announced while it waits in the queue shows at once with its chip, and Cancel reaches it", () => {
  const h = setup();
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 0, total: 1, waiting: true });
  assert.equal(h.el("bundle-progress").hidden, false);
  assert.equal(h.el("bundle-progress-text").textContent, "Waiting to copy files to “Episode 12 v2 files” — 0%");
  h.el("bundle-hide").click();
  assert.equal(h.el("bundle-indicator").hidden, false);
  assert.equal(h.el("bundle-indicator").textContent, "Waiting to copy files — 0%");
  h.el("bundle-indicator").click();
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, ["carry1"]);
  h.carry({ job: "carry1", from: "Episode 12 files", to: "Episode 12 v2 files", done: 1, total: 1, result: { ok: false, code: "CANCELLED", name: "", copied: 0 } });
  assert.equal(h.el("bundle-progress").hidden, true);
  assert.equal(h.el("bundle-indicator").hidden, true);
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

test("exporting with the script's files plans in main, asks where, then shows the job on the progress panel, where Cancel stops it", async () => {
  let progress: ((p: { done: number; total: number }) => void) | null = null;
  let finish: (res: DesktopBundleExport | null) => void = () => {};
  const h = setup({ exported: (_job, _id, onProgress) => { progress = onProgress; return new Promise((resolve) => { finish = resolve; }); } });
  const handle = { kind: "file", name: "Episode 12.splitpage" };
  const running = h.owner.exportWithFiles("Episode 12 (with files).zip", "Episode 12.splitpage", "{\"rows\":[]}", handle);
  await settle();
  assert.deepEqual(h.exportCalls.map((c) => c[0]), ["plan", "pick", "run"]);
  assert.equal(h.exportCalls[1]?.[2], h.exportCalls[0]?.[1], "the dialog is asked for the planned job, so main binds a Replace to it");
  assert.equal(h.exportCalls[2]?.[1], h.exportCalls[0]?.[1]);
  assert.deepEqual(h.exportCalls[0]?.slice(2),["Episode 12.splitpage", "{\"rows\":[]}", handle],
    "main gets the script's name, its bytes and the script they were captured from, no path");
  assert.equal(h.exportCalls[2]?.[1], h.exportCalls[0]?.[1], "the job runs the plan main made");
  assert.equal(h.exportCalls[2]?.[2], "zip1", "and writes only to the file the dialog chose");
  assert.ok(progress, "the job reports progress");
  (progress as unknown as (p: { done: number; total: number }) => void)({ done: 1, total: 4 });
  assert.equal(h.el("bundle-progress").hidden, false);
  assert.equal(h.el("bundle-progress-text").textContent, "Exporting “Episode 12 (with files).zip” — 25%");
  h.el("bundle-hide").click();
  assert.equal(h.el("bundle-indicator").textContent, "Exporting — 25%");
  h.el("bundle-indicator").click();
  h.el("bundle-cancel").click();
  assert.deepEqual(h.cancels, [h.exportCalls[2]?.[1]], "Cancel stops the export job by its id");
  finish({ ok: false, code: "CANCELLED" });
  assert.equal(await running, false);
  assert.equal(h.notices.shown.at(-1)?.message, "Stopped exporting “Episode 12 (with files).zip”. Nothing was saved.");
  assert.equal(h.el("bundle-progress").hidden, true, "the panel goes when the export ends");
  h.owner.dispose();
});

test("a finished export says how many files went in, and a separate notice that stays counts the files it couldn't include", async () => {
  const h = setup({ exported: async () => ({ ok: true, files: 3, left: 2 }) });
  assert.equal(await h.owner.exportWithFiles("Episode 12 (with files).zip", "Episode 12.splitpage", "{}", null), true);
  assert.equal(h.notices.shown[0]?.message, "Exported “Episode 12 (with files).zip” with 3 files.");
  assert.equal(h.notices.shown[0]?.kind, "ok");
  assert.equal(h.notices.shown[1]?.message, "2 files couldn't be included in “Episode 12 (with files).zip”. They are missing, outside the script's folder, " +
    "or a type Splitpage doesn't attach, so they aren't in the zip.");
  assert.equal(h.notices.shown[1]?.sticky, true);
  h.owner.dispose();
});

test("an export main refuses, a cancelled save dialog, and a taken name never claim success", async () => {
  const refused = setup({ exportPlan: null });
  assert.equal(await refused.owner.exportWithFiles("A (with files).zip", "A.splitpage", "{}", null), false);
  assert.deepEqual(refused.exportCalls.map((c) => c[0]), ["plan"], "no dialog when main refuses the plan");
  assert.equal(refused.notices.shown[0]?.message, "Could not export “A (with files).zip”.");
  refused.owner.dispose();
  const dismissed = setup({ picked: null });
  assert.equal(await dismissed.owner.exportWithFiles("A (with files).zip", "A.splitpage", "{}", null), false);
  assert.deepEqual(dismissed.exportCalls.map((c) => c[0]), ["plan", "pick"]);
  assert.deepEqual(dismissed.notices.shown, [], "a dismissed dialog says nothing");
  dismissed.owner.dispose();
  const taken = setup({ exported: async () => ({ ok: false, code: "TAKEN" }) });
  assert.equal(await taken.owner.exportWithFiles("A (with files).zip", "A.splitpage", "{}", null), false);
  assert.equal(taken.notices.shown[0]?.message, "Could not export — “A (with files).zip” already exists. Export again and choose a new name.");
  taken.owner.dispose();
});

test("the Export dialog's line about the files gives their count and size, and the Save As warning above 250 MB", () => {
  assert.equal(exportFilesText({ files: 2, bytes: 3 * 1024 * 1024, left: 0 }), "2 files (3 MB) in a folder beside the script");
  assert.equal(exportFilesText({ files: 0, bytes: 0, left: 1 }), "no linked files to include · 1 file can't be included: missing, outside the script's folder, or a type Splitpage doesn't attach");
  assert.equal(exportFilesText({ files: 1, bytes: BUNDLE_WARN_BYTES + 1, left: 0 }), "1 file (250 MB) in a folder beside the script. " +
    "That is a lot to copy, and it may take a while and use disk space. You can keep working while it copies.");
});
