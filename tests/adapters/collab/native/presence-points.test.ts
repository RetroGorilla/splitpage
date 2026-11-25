import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { PresencePoint } from "../../../../src/application/collaboration/presence.ts";
import { cells } from "./helpers.ts";
import { structureScript } from "./structure-harness.ts";

type Session = ReturnType<typeof openNativeSession>;

const options = { actor: "Alice", sanitize: (value: unknown) => String(value ?? "") };

function pair(rows: Record<string, string> = { A: "Hello world", B: "Second" }, visuals: Record<string, string> = { A: "Wide shot" }) {
  const mine = openNativeSession({
    kind: "document", document: structureScript(rows, visuals), conversion: { cells, creation: "seed", at: "2026-11-25T00:00:00Z", by: "Alice" }
  }, options);
  const peer = openNativeSession({ kind: "state", state: mine.encodeState() }, { ...options, actor: "Bea" });
  return { mine, peer };
}

function type(session: Session, beat: string, at: number, text: string, cell: "narration" | "visual" = "narration"): void {
  const anchored = session.commands.anchorText({ beat, cell }, at);
  assert(anchored.kind === "anchored");
  assert.equal(session.commands.typeText(anchored.range, text, {}).kind, "written");
}

function deliver(from: Session, to: Session): void {
  Y.applyUpdate(to.ydoc, Y.encodeStateAsUpdate(from.ydoc, Y.encodeStateVector(to.ydoc)));
}

function point(session: Session, row: string, side: "audioText" | "visualText", offset: number, assoc: 0 | -1 = 0): PresencePoint {
  const at = session.presencePoint(row, side, offset, assoc);
  assert.ok(at, row + " " + side + " " + offset);
  return at;
}

test("a presence point is plain JSON a peer resolves to the same painted offset in either cell", t => {
  const { mine, peer } = pair();
  t.after(() => { mine.close(); peer.close(); });
  const caret = point(mine, "A", "audioText", 6);
  assert.deepEqual(JSON.parse(JSON.stringify(caret)), caret);
  assert.deepEqual(Object.keys(caret).sort(), ["assoc", "item", "type"]);
  assert.equal(peer.presenceOffset("A", "audioText", caret), 6);
  const end = point(mine, "A", "audioText", 11, -1);
  assert.equal(peer.presenceOffset("A", "audioText", end), 11);
  const shot = point(mine, "A", "visualText", 4);
  assert.equal(peer.presenceOffset("A", "visualText", shot), 4);
  assert.equal(peer.presenceOffset("B", "audioText", caret), null, "a point in another row is not shown there");
  assert.equal(peer.presenceOffset("A", "visualText", caret), null, "a narration point is not a visual one");
});

test("a presence point follows its letter through peer edits, and a deleted beat drops it", t => {
  const { mine, peer } = pair();
  t.after(() => { mine.close(); peer.close(); });
  const caret = point(mine, "A", "audioText", 6);
  const before = point(mine, "A", "audioText", 3, -1);
  type(peer, "A", 0, ">> ");
  type(peer, "A", 14, "!");
  deliver(peer, mine);
  assert.equal(mine.presenceOffset("A", "audioText", caret), 9);
  assert.equal(mine.presenceOffset("A", "audioText", before), 6);
  const shot = point(mine, "A", "visualText", 4);
  type(peer, "A", 0, "Very ", "visual");
  deliver(peer, mine);
  assert.equal(mine.presenceOffset("A", "visualText", shot), 9);
  assert.equal(peer.commands.removeRows(["A"]).kind, "written");
  deliver(peer, mine);
  assert.equal(mine.presenceOffset("A", "audioText", caret), null);
  assert.equal(mine.presenceOffset("A", "visualText", shot), null);
});

test("a point naming text this copy has not received yet resolves to nothing until it arrives", t => {
  const { mine, peer } = pair();
  t.after(() => { mine.close(); peer.close(); });
  type(peer, "A", 5, ",");
  const held = point(peer, "A", "audioText", 5);
  assert.equal(mine.presenceOffset("A", "audioText", held), null);
  deliver(peer, mine);
  assert.equal(mine.presenceOffset("A", "audioText", held), 5);
});

test("presence points refuse offsets outside the cell and malformed points without touching the document", t => {
  const { mine } = pair();
  t.after(() => mine.close());
  const state = mine.encodeState();
  assert.equal(mine.presencePoint("A", "audioText", 12, 0), null);
  assert.equal(mine.presencePoint("A", "visualText", 10, 0), null);
  assert.equal(mine.presencePoint("A", "audioText", -1, 0), null);
  assert.equal(mine.presencePoint("A", "audioText", 1.5, 0), null);
  assert.equal(mine.presencePoint("missing", "audioText", 0, 0), null);
  const caret = point(mine, "A", "audioText", 2);
  const shared = [...mine.ydoc.share.keys()];
  for (const bad of [
    { ...caret, tname: "planted" },
    { ...caret, assoc: 1 },
    { ...caret, item: null, type: { client: caret.type.client, clock: 99999 } },
    { ...caret, item: { client: 424242, clock: 0 } }
  ]) {
    assert.equal(mine.presenceOffset("A", "audioText", bad as PresencePoint), null, JSON.stringify(bad));
  }
  assert.deepEqual([...mine.ydoc.share.keys()], shared);
  assert.deepEqual(mine.encodeState(), state);
});
