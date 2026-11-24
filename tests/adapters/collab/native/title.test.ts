import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeTextRange } from "../../../../src/adapters/collab/native/text-commands.ts";
import { convertedScript } from "./helpers.ts";
import { noticeCopy, noticeDeliver } from "./notice-harness.ts";
import { structureScript } from "./structure-harness.ts";

const TITLE = { beat: "", cell: "title" } as const;

function makeSeed(title = "Draft", rows: Record<string, string> = { A: "Alpha" }): Uint8Array {
  const doc = { ...structureScript(rows), title };
  const script = convertedScript(doc);
  try {
    return Y.encodeStateAsUpdate(script.doc);
  } finally {
    script.doc.destroy();
  }
}

function titleRange(copy: ReturnType<typeof openNativeSession>, from: number, to = from): NativeTextRange {
  const anchored = copy.commands.anchorText(TITLE, from, to);
  assert.equal(anchored.kind, "anchored", JSON.stringify(anchored));
  return anchored.range;
}

test("title commands validate target, text, no-op edits, and replay undo and redo selections", t => {
  const copy = noticeCopy(makeSeed("Draft"), 2);
  t.after(copy.close);
  const before = copy.encodeState();
  assert.deepEqual(copy.commands.anchorText({ beat: "A", cell: "title" }, 0), { kind: "refused", reason: "range" });
  const range = titleRange(copy, 5);
  for (const bad of [null, 123, "line1\nline2", "bad\rtext", "\u0000", "\uD800"]) {
    assert.deepEqual(copy.commands.typeTitle(range, bad as string), { kind: "refused", reason: "text" });
    assert.deepEqual(copy.encodeState(), before);
  }
  assert.deepEqual(copy.commands.replaceTitle(titleRange(copy, 0, 5), "Draft"), { kind: "unchanged" });
  assert.deepEqual(copy.commands.deleteTitle(titleRange(copy, 2, 2)), { kind: "unchanged" });
  assert.deepEqual(copy.encodeState(), before);

  const typed = copy.commands.typeTitle.withSelection(titleRange(copy, 5), titleRange(copy, 5), " 2", [null, null]);
  assert.equal(typed.result.kind, "written");
  typed.recordAfter();
  assert.equal(copy.document().title, "Draft 2");

  const replaced = copy.commands.replaceTitle.withSelection(titleRange(copy, 0, 5), titleRange(copy, 0, 5), "Script");
  assert.equal(replaced.result.kind, "written");
  replaced.recordAfter(titleRange(copy, 6));
  assert.equal(copy.document().title, "Script 2");

  const u1 = copy.commands.undo();
  assert.equal(u1.kind, "written");
  assert.equal(copy.document().title, "Draft 2");
  assert.deepEqual(u1.selection, { anchor: { target: TITLE, offset: 0 }, head: { target: TITLE, offset: 5 } });

  const u2 = copy.commands.undo();
  assert.equal(u2.kind, "written");
  assert.equal(copy.document().title, "Draft");
  assert.deepEqual(u2.selection, { anchor: { target: TITLE, offset: 5 }, head: { target: TITLE, offset: 5 } });
  assert.deepEqual(copy.commands.undo(), { kind: "unchanged" });

  const r1 = copy.commands.redo();
  assert.equal(r1.kind, "written");
  assert.equal(copy.document().title, "Draft 2");
  assert.deepEqual(r1.selection, { anchor: { target: TITLE, offset: 7 }, head: { target: TITLE, offset: 7 } });

  const r2 = copy.commands.redo();
  assert.equal(r2.kind, "written");
  assert.equal(copy.document().title, "Script 2");
  assert.deepEqual(r2.selection, { anchor: { target: TITLE, offset: 6 }, head: { target: TITLE, offset: 6 } });
});

test("title typing groups words and deletion runs group within one second", t => {
  const copy = noticeCopy(makeSeed("One"), 2);
  t.after(copy.close);
  assert.equal(copy.commands.typeTitle(titleRange(copy, 3), " ").kind, "written");
  assert.equal(copy.commands.typeTitle(titleRange(copy, 4), "t").kind, "written");
  assert.equal(copy.commands.typeTitle(titleRange(copy, 5), "w").kind, "written");
  assert.equal(copy.commands.typeTitle(titleRange(copy, 6), "o").kind, "written");
  assert.equal(copy.document().title, "One two");
  assert.equal(copy.commands.undo().kind, "written");
  assert.equal(copy.document().title, "One ");
  assert.equal(copy.commands.redo().kind, "written");
  assert.equal(copy.document().title, "One two");

  assert.equal(copy.commands.deleteTitleInRun(titleRange(copy, 6, 7), -1, 1000).kind, "written");
  assert.equal(copy.commands.deleteTitleInRun(titleRange(copy, 5, 6), -1, 1200).kind, "written");
  assert.equal(copy.commands.deleteTitleInRun(titleRange(copy, 4, 5), -1, 1400).kind, "written");
  assert.equal(copy.document().title, "One ");
  assert.equal(copy.commands.undo().kind, "written");
  assert.equal(copy.document().title, "One two");
});

for (const reverse of [false, true]) {
  test(`two copies edit the title concurrently with independent undo and redo (reverse: ${reverse})`, t => {
    const seed = makeSeed("Pilot");
    const alice = noticeCopy(seed, 2), bob = noticeCopy(seed, 3);
    t.after(() => { alice.close(); bob.close(); });

    const aStep = alice.commands.typeTitle.withSelection(titleRange(alice, 5), titleRange(alice, 5), " Final");
    assert.equal(aStep.result.kind, "written");
    aStep.recordAfter();

    const bStep = bob.commands.typeTitle.withSelection(titleRange(bob, 0), titleRange(bob, 0), "Ep 1: ");
    assert.equal(bStep.result.kind, "written");
    bStep.recordAfter();

    if (reverse) {
      noticeDeliver(bob, alice);
      noticeDeliver(alice, bob);
    } else {
      noticeDeliver(alice, bob);
      noticeDeliver(bob, alice);
    }
    assert.equal(alice.document().title, "Ep 1: Pilot Final");
    assert.equal(bob.document().title, "Ep 1: Pilot Final");

    const aUndo = alice.commands.undo();
    assert.equal(aUndo.kind, "written");
    assert.deepEqual(aUndo.selection, { anchor: { target: TITLE, offset: 11 }, head: { target: TITLE, offset: 11 } });
    noticeDeliver(alice, bob);
    assert.equal(alice.document().title, "Ep 1: Pilot");
    assert.equal(bob.document().title, "Ep 1: Pilot");

    const bUndo = bob.commands.undo();
    assert.equal(bUndo.kind, "written");
    noticeDeliver(bob, alice);
    assert.equal(alice.document().title, "Pilot");
    assert.equal(bob.document().title, "Pilot");

    const aRedo = alice.commands.redo();
    assert.equal(aRedo.kind, "written");
    noticeDeliver(alice, bob);
    assert.equal(alice.document().title, "Pilot Final");
    assert.equal(bob.document().title, "Pilot Final");

    const bRedo = bob.commands.redo();
    assert.equal(bRedo.kind, "written");
    noticeDeliver(bob, alice);
    assert.equal(alice.document().title, "Ep 1: Pilot Final");
    assert.equal(bob.document().title, "Ep 1: Pilot Final");
  });
}

test("concurrent overlapping title edits converge and undo cleanly on both copies", t => {
  const seed = makeSeed("Hello World");
  const alice = noticeCopy(seed, 2), bob = noticeCopy(seed, 3);
  t.after(() => { alice.close(); bob.close(); });

  assert.equal(alice.commands.replaceTitle(titleRange(alice, 6, 11), "Splitpage").kind, "written");
  assert.equal(bob.commands.deleteTitle(titleRange(bob, 0, 6)).kind, "written");
  noticeDeliver(alice, bob);
  noticeDeliver(bob, alice);
  assert.equal(alice.document().title, "Splitpage");
  assert.equal(bob.document().title, "Splitpage");

  assert.equal(bob.commands.undo().kind, "written");
  noticeDeliver(bob, alice);
  assert.equal(alice.document().title, "Hello Splitpage");
  assert.equal(bob.document().title, "Hello Splitpage");

  assert.equal(alice.commands.undo().kind, "written");
  noticeDeliver(alice, bob);
  assert.equal(alice.document().title, "Hello World");
  assert.equal(bob.document().title, "Hello World");

  assert.equal(alice.commands.redo().kind, "written");
  assert.equal(bob.commands.redo().kind, "written");
  noticeDeliver(alice, bob);
  noticeDeliver(bob, alice);
  assert.equal(alice.document().title, "Splitpage");
  assert.equal(bob.document().title, "Splitpage");
});

test("title writes respect the session size limit while deletions remain allowed", async t => {
  const seed = makeSeed("Draft");
  const copy = openNativeSession({ kind: "state", state: seed }, {
    actor: "writer", sanitize: String, sizeLimit: seed.byteLength + 120, sizeMinimumStep: 1, sizeCeilingRatio: 10
  });
  t.after(copy.close);
  assert.equal(copy.commands.typeTitle(titleRange(copy, 5), "x".repeat(400)).kind, "written");
  await Promise.resolve();
  assert.equal(copy.size, "full");
  assert.deepEqual(copy.commands.typeTitle(titleRange(copy, 0), "y"), { kind: "refused", reason: "full" });
  assert.equal(copy.commands.deleteTitle(titleRange(copy, 5, 405)).kind, "written");
  assert.equal(copy.document().title, "Draft");
});
