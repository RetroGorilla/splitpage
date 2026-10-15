import { test } from "node:test";
import assert from "node:assert/strict";
import { ARM_MS, mergeSummary, mountMergeBanner } from "../../../src/features/merge/banner.ts";
import type { MergeBanner, MergeReport, RestoreAnswer, RestoreRequest } from "../../../src/features/merge/banner.ts";
import type { MergeUndoRecord } from "../../../src/application/session/apply-merge.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;

const DEFAULT_TITLE = "Go back to the version that was live before your changes were merged in.";

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML =
    '<div id="merge-banner" hidden><span id="merge-summary"></span>' +
    '<button id="merge-review" hidden>Review conflicts</button>' +
    '<button id="merge-undo" title="' + DEFAULT_TITLE + '">Undo merge</button>' +
    '<button id="merge-dismiss">×</button></div>' +
    '<div id="rows"><div class="row" data-id="r1"></div><div class="row" data-id="r2"></div></div>';
  return win;
}

interface Held { id: string; request: RestoreRequest; answer: (r: RestoreAnswer) => void; fail: (e: unknown) => void }

function mount(win: Realm, opts: { undo?: MergeUndoRecord | null; docId?: string | null } = {}) {
  const said: string[] = [];
  const held: Held[] = [];
  const errors: unknown[] = [];
  let comments = 0;
  let installed: MergeBanner | null = null;
  let released = 0;
  const state = { undo: opts.undo ?? null, docId: opts.docId === undefined ? "d1" : opts.docId };
  const banner = mountMergeBanner({
    window: win,
    ports: {
      lastUndo: () => state.undo,
      sameDocument: (docId) => state.docId !== null && docId === state.docId,
      restore: (id, request) => new Promise<RestoreAnswer>((resolve, reject) => { held.push({ id, request, answer: resolve, fail: reject }); }),
      warn: (m) => { said.push(m); },
      openComments: () => { comments++; },
      rowElement: (rowId) => win.document.querySelector('#rows .row[data-id="' + rowId + '"]'),
      logError: (e) => { errors.push(e); },
      install: (b) => { installed = b; return () => { released++; installed = null; }; }
    }
  });
  return {
    banner, said, held, errors, state,
    get comments() { return comments; },
    get installed() { return installed; },
    get released() { return released; }
  };
}

const el = (win: Realm, id: string) => win.document.getElementById(id) as HTMLElement;
function at<T>(list: readonly T[], i: number): T {
  const got = list[i < 0 ? list.length + i : i];
  if (got === undefined) throw new Error("nothing at " + i);
  return got;
}
const settle = () => new Promise((r) => setImmediate(r));
const report = (stats: MergeReport["stats"], conflicts: string[] = []): MergeReport => ({ stats, conflicts: conflicts.map((rowId) => ({ rowId })) });

test("the summary names what each side kept, in the app's words", () => {
  assert.equal(mergeSummary(report({ rowsFromMe: 1, rowsAddedByMe: 2, rowsFromThem: 3, rowsAddedByThem: 1 })),
    "Kept 1 row you edited, 2 rows you added, 3 changed by someone else, 1 added by someone else.");
  assert.equal(mergeSummary(report({}, ["r1"])), "Nothing was lost. 1 edit was changed on both sides — your version is saved as a comment.");
  assert.equal(mergeSummary(report({ rowsFromThem: 1 }, ["r1", "r2"])),
    "Kept 1 changed by someone else. 2 edits were changed on both sides — your version is saved as a comment.");
  assert.equal(mergeSummary(report({})), null);
});

test("mounting installs the banner once; dispose releases it and removes all three listeners", () => {
  const win = page();
  const m = mount(win, { undo: { id: "s1", docId: "d1", source: "stash" } });
  assert.equal(m.installed, m.banner);
  m.banner.dispose();
  m.banner.dispose();
  assert.equal(m.released, 1);
  assert.equal(m.installed, null);

  el(win, "merge-banner").hidden = false;
  el(win, "merge-dismiss").click();
  el(win, "merge-review").click();
  el(win, "merge-undo").click();
  assert.equal(el(win, "merge-banner").hidden, false, "× no longer hides it");
  assert.equal(m.comments, 0);
  assert.equal(el(win, "merge-undo").textContent, "Undo merge");
  assert.equal(m.banner.show(report({ rowsFromMe: 1 })), false, "a disposed banner shows nothing");
});

test("show fills the banner, marks conflicted rows and offers Review conflicts only for conflicts", () => {
  const win = page();
  const m = mount(win);
  assert.equal(m.banner.show(report({})), false, "nothing to say");
  assert.equal(el(win, "merge-banner").hidden, true);

  assert.equal(m.banner.show(report({ rowsFromThem: 1 }, ["r2"])), true);
  assert.equal(el(win, "merge-banner").hidden, false);
  assert.ok(el(win, "merge-banner").classList.contains("notice-warn"));
  assert.equal(el(win, "merge-review").hidden, false);
  assert.equal(el(win, "merge-undo").hidden, true, "no undo point armed");
  assert.ok(win.document.querySelector('[data-id="r2"]')?.classList.contains("just-merged"));
  assert.ok(!win.document.querySelector('[data-id="r1"]')?.classList.contains("just-merged"));

  m.banner.show(report({ rowsFromMe: 1 }));
  assert.ok(!el(win, "merge-banner").classList.contains("notice-warn"));
  assert.equal(el(win, "merge-review").hidden, true);
  m.banner.dispose();
});

test("undo: \"saved\" adds the note and title; undo: false hides the button; the default title comes back", () => {
  const win = page();
  const m = mount(win, { undo: { id: "s1", docId: "d1", source: "server-conflict" } });
  m.banner.show(report({ rowsFromMe: 1 }), { undo: "saved" });
  assert.equal(el(win, "merge-undo").hidden, false);
  assert.match(el(win, "merge-summary").textContent ?? "", /the next save replaces the merged copy on the server\.$/);
  assert.notEqual(el(win, "merge-undo").title, DEFAULT_TITLE);
  m.banner.show(report({ rowsFromMe: 1 }), { undo: false });
  assert.equal(el(win, "merge-undo").hidden, true);
  assert.equal(el(win, "merge-undo").title, DEFAULT_TITLE);
  m.banner.show(report({ rowsFromMe: 1 }));
  assert.equal(el(win, "merge-undo").hidden, false);
  assert.equal(el(win, "merge-summary").textContent, " Kept 1 row you edited.");
  m.banner.dispose();
});

test("× hides the banner; Review conflicts hides it and opens the comments", () => {
  const win = page();
  const m = mount(win);
  m.banner.show(report({}, ["r1"]));
  el(win, "merge-dismiss").click();
  assert.equal(el(win, "merge-banner").hidden, true);
  el(win, "merge-banner").hidden = false;
  el(win, "merge-review").click();
  assert.equal(el(win, "merge-banner").hidden, true);
  assert.equal(m.comments, 1);
  m.banner.dispose();
});

test("Undo merge arms first, disarms after its window, and restores on the second click with the source's rules", async () => {
  const win = page();
  const undo = { id: "s1", docId: "d1", source: "server-conflict" };
  const m = mount(win, { undo });
  const btn = el(win, "merge-undo");
  btn.click();
  assert.equal(btn.textContent, "Drop their changes?");
  assert.ok(btn.classList.contains("armed"));
  await new Promise((r) => setTimeout(r, ARM_MS + 50));
  assert.equal(btn.textContent, "Undo merge");
  assert.ok(!btn.classList.contains("armed"));
  assert.equal(m.held.length, 0);

  btn.click();
  btn.click();
  assert.equal(btn.textContent, "Undo merge");
  assert.equal(m.held.length, 1);
  assert.deepEqual(at(m.held, 0).request, {
    force: false, local: true,
    restoredText: "Your version is back, unsaved. The next save replaces the merged copy on the server."
  });
  at(m.held, 0).answer("ok");
  await settle();
  assert.deepEqual(m.said, []);
  m.banner.dispose();
});

test("a stash's Undo merge asks to discard and restores as a server save would", () => {
  const win = page();
  const m = mount(win, { undo: { id: "s2", docId: "d1", source: "stash" } });
  el(win, "merge-undo").click();
  assert.equal(el(win, "merge-undo").textContent, "Discard my edits?");
  el(win, "merge-undo").click();
  assert.deepEqual(at(m.held, 0).request, { force: false, local: false, restoredText: undefined });
  m.banner.dispose();
});

test("each refused restore says why; no backup forces the next attempt at the same undo point", async () => {
  const win = page();
  const undo = { id: "s1", docId: "d1", source: "stash" };
  const m = mount(win, { undo });
  const twice = async (answer: RestoreAnswer) => {
    el(win, "merge-undo").click();
    el(win, "merge-undo").click();
    at(m.held, -1).answer(answer);
    await settle();
  };
  await twice("no-backup");
  await twice("missing");
  assert.equal(at(m.held, 1).request.force, true, "forced after no-backup");
  await twice("corrupt");
  assert.equal(at(m.held, 2).request.force, false, "once only");
  await twice("changed");
  await twice("busy");
  assert.deepEqual(m.said, [
    "Could not keep a backup of your current version. Undo the merge again to discard your edits anyway.",
    "The snapshot from before the merge is no longer in the history.",
    "The snapshot from before the merge could not be read, so nothing was undone.",
    "A different document was opened while undoing, so nothing was undone."
  ]);

  m.state.undo = { id: "s5", docId: "d1", source: "stash" };
  await twice("no-backup");
  m.state.undo = { id: "s6", docId: "d1", source: "stash" };
  await twice("ok");
  assert.equal(at(m.held, -1).request.force, false, "forcing belongs to the undo point that asked");

  el(win, "merge-undo").click();
  el(win, "merge-undo").click();
  const err = new Error("store gone");
  at(m.held, -1).fail(err);
  await settle();
  assert.deepEqual(m.errors, [err]);
  m.banner.dispose();
});

test("with nothing armed, or armed for another document, it only says so", () => {
  const win = page();
  const m = mount(win);
  el(win, "merge-undo").click();
  m.state.undo = { id: "s1", docId: "other", source: "stash" };
  el(win, "merge-undo").click();
  m.state.docId = null;
  m.state.undo = { id: "s1", docId: null as unknown as string, source: "stash" };
  el(win, "merge-undo").click();
  assert.deepEqual(m.said, [
    "No merge snapshot to undo.",
    "That merge belongs to a different document, so there is nothing to undo here.",
    "That merge belongs to a different document, so there is nothing to undo here."
  ]);
  assert.equal(el(win, "merge-undo").textContent, "Undo merge");
  assert.equal(m.held.length, 0);
  m.banner.dispose();
});

test("dispose while armed disarms; dispose while a restore is held drops its answer; a remount works on its own", async () => {
  const win = page();
  const undo = { id: "s1", docId: "d1", source: "stash" };
  const first = mount(win, { undo });
  el(win, "merge-undo").click();
  first.banner.dispose();
  assert.equal(el(win, "merge-undo").textContent, "Undo merge");
  assert.ok(!el(win, "merge-undo").classList.contains("armed"));

  const second = mount(win, { undo });
  el(win, "merge-undo").click();
  assert.equal(el(win, "merge-undo").textContent, "Discard my edits?", "a fresh mount arms from scratch");
  el(win, "merge-undo").click();
  assert.equal(second.held.length, 1);
  second.banner.dispose();
  at(second.held, 0).answer("missing");
  await settle();
  assert.deepEqual(second.said, [], "a stale completion after dispose says nothing");

  const third = mount(win, { undo });
  el(win, "merge-undo").click();
  el(win, "merge-undo").click();
  assert.equal(third.held.length, 1, "one handler per click after remount");
  assert.equal(first.held.length + second.held.length, 1, "the old mounts heard nothing");
  at(third.held, 0).answer("missing");
  await settle();
  assert.deepEqual(third.said, ["The snapshot from before the merge is no longer in the history."], "a normal completion as the control");
  third.banner.dispose();
});
