import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { Composition } from "../../../src/native-e1/fold.ts";
import { malformed, view } from "../../../src/native-e1/ledger.ts";
import { agreed, bold, local, room, shown, text } from "./replicas.ts";
import type { CellFilter, Replica } from "./replicas.ts";

// why: tie rule held here: text the composing person commits goes before remote text that landed in the same gap of
// the painted screen meanwhile, as CodeMirror maps a cursor over an insertion at it (SelectionRange.map, assoc -1)
const shownText = (doc: Y.Doc): string => shown(text(doc));
const abcd = (doc: Y.Doc): void => { text(doc).insert(0, "abcd"); };

function composing(build: (doc: Y.Doc) => void, clients: readonly number[] = [1, 2, 3]) {
  const shared = room(clients, build);
  const [a, b, c] = shared.replicas as [Replica, Replica, Replica];
  return { shared, a, b, c, edit: new Composition(text(a.doc)) };
}

for (const [name, remote, local_, expected] of [
  ["B deletes b; A composes away bc", (t: Y.Text) => t.delete(1, 1), (e: Composition) => e.delete(1, 3), "ad"],
  ["B deletes bc; A composes away bc", (t: Y.Text) => t.delete(1, 2), (e: Composition) => e.delete(1, 3), "ad"],
  ["B types X between b and c; A composes away bc", (t: Y.Text) => t.insert(2, "X"), (e: Composition) => e.delete(1, 3), "aXd"],
  ["B deletes b; A composes Y over bc", (t: Y.Text) => t.delete(1, 1), (e: Composition) => e.replace(1, 3, "Y"), "aYd"],
  ["B deletes a; A composes Y after a", (t: Y.Text) => t.delete(0, 1), (e: Composition) => e.insert(1, "Y"), "Ybcd"],
  ["B puts an atom between b and c; A composes away bc", (t: Y.Text) => t.insertEmbed(2, { k: "s" }), (e: Composition) => e.delete(1, 3), "a[s]d"],
  ["tie: B types X between b and c; A composes Y between b and c", (t: Y.Text) => t.insert(2, "X"), (e: Composition) => e.insert(2, "Y"), "abYXcd"],
  ["tie: B types X between a and b; A composes Y over bc", (t: Y.Text) => t.insert(1, "X"), (e: Composition) => e.replace(1, 3, "Y"), "aYXd"],
  ["tie: B types X between b and c; A composes Y over bc", (t: Y.Text) => t.insert(2, "X"), (e: Composition) => e.replace(1, 3, "Y"), "aYXd"]
] as const) {
  test(`painted abcd, remote change folded before the commit: ${name} gives ${expected} on every copy and a late joiner`, () => {
    const { shared, a, b, edit } = composing(abcd);
    local_(edit);
    remote(text(b.doc));
    shared.send(b, a);
    assert.equal(edit.liveUnits(), text(a.doc).length);
    edit.commit(a.origin);
    assert.equal(agreed(shared, shownText), expected);
    shared.close();
  });
}

test("one composition with a deletion, an insertion and a replacement while B deletes, types and bolds", () => {
  const { shared, a, b, edit } = composing(doc => { text(doc).insert(0, "abcdef"); });
  edit.delete(1, 2);
  edit.insert(3, "XY");
  edit.replace(6, 7, "Z");
  assert.deepEqual(edit.plan(), { runs: [{ anchor: 3, text: "XY" }, { anchor: 4, text: "Z" }], deleted: [1, 5] });
  local(b, () => text(b.doc).delete(2, 1));
  local(b, () => text(b.doc).insert(4, "Q"));
  local(b, () => text(b.doc).format(2, 2, { b: true }));
  shared.send(b, a);
  edit.commit(a.origin);
  assert.equal(agreed(shared, shownText), "adXYeZQ");
  assert.equal(agreed(shared, doc => bold(text(doc))), "dXYeZ");
  shared.close();
});

test("updates arriving out of order and twice are folded once each", () => {
  const { shared, a, b, edit } = composing(abcd);
  edit.replace(1, 3, "Y");
  local(b, () => text(b.doc).insert(2, "X"));
  local(b, () => text(b.doc).delete(0, 1));
  shared.send(b, a, 1);
  shared.send(b, a, 1);
  shared.send(b, a, 0);
  shared.send(b, a, 0);
  assert.equal(edit.liveUnits(), text(a.doc).length);
  edit.commit(a.origin);
  assert.equal(agreed(shared, shownText), "YXd");
  shared.close();
});

const split = (replica: Replica, at: number, id: string): void => local(replica, () => {
  text(replica.doc).insertEmbed(at, { b: id });
  replica.doc.getMap("beats").set(id, new Y.Map());
  replica.doc.getMap("visuals").set(id, new Y.Text());
});
const segmented = (filter: CellFilter = "keep cells") => {
  const shared = room([1, 2, 3], abcd, doc => [text(doc), doc.getMap("beats"), doc.getMap("visuals")], 0, filter);
  return { shared, a: shared.replicas[0] as Replica, b: shared.replicas[1] as Replica };
};
const beats = (doc: Y.Doc): string => [...doc.getMap("beats").keys()].sort().join(",");

test("B splits the beat between b and c while A composes Y over bc: the new boundary stays and Y goes before it", () => {
  const { shared, a, b } = segmented();
  const edit = new Composition(text(a.doc));
  edit.replace(1, 3, "Y");
  split(b, 2, "2");
  shared.send(b, a);
  edit.commit(a.origin);
  assert.equal(agreed(shared, shownText), "aY|2|d");
  assert.equal(agreed(shared, beats), "2");
  shared.close();
});

test("B undoes the split that made beat 2 while A composes at its start: the boundary goes and Y joins the end of beat 1", () => {
  const { shared, a, b } = segmented();
  split(b, 2, "2");
  shared.sync();
  const edit = new Composition(text(a.doc));
  edit.insert(3, "Y");
  b.undo.undo();
  shared.send(b, a);
  edit.commit(a.origin);
  assert.equal(agreed(shared, shownText), "abYcd");
  assert.equal(agreed(shared, beats), "");
  shared.close();
});

test("B removes or joins the composing cell's beat by flag: the composed text lands and the flag stays", () => {
  for (const [flag, value] of [["removed", { by: "B", at: 1 }], ["joined", { into: "1", glue: " " }]] as const) {
    const { shared, a, b } = segmented();
    split(b, 2, "2");
    shared.sync();
    const edit = new Composition(text(a.doc));
    edit.replace(3, 4, "Y");
    local(b, () => (b.doc.getMap("beats").get("2") as Y.Map<unknown>).set(flag, value));
    shared.send(b, a);
    edit.commit(a.origin);
    assert.equal(agreed(shared, shownText), "ab|2|Yd");
    assert.equal(agreed(shared, doc => JSON.stringify((doc.getMap("beats").get("2") as Y.Map<unknown>).get(flag))), JSON.stringify(value));
    shared.close();
  }
});

const visualText = (doc: Y.Doc): string => [...doc.getMap("visuals").entries()].map(([key, value]) => `${key}:${(value as Y.Text).toString()}`).sort().join(",");

const composingInCell = (filter: CellFilter) => {
  const { shared, a, b } = segmented(filter);
  split(b, 2, "2");
  shared.sync();
  const edit = new Composition(a.doc.getMap("visuals").get("2") as Y.Text, () => a.doc.getMap("visuals").get("2") as Y.Text | undefined);
  edit.insert(0, "Y");
  return { shared, a, b, edit };
};

for (const [filter, status, expected] of [["keep content", "recovery", ""], ["keep cells", "written", "2:Y"]] as const) {
  test(`B undoes the split while A composes Y in beat 2's empty visual cell, filter "${filter}": commit ${status}`, () => {
    const { shared, a, b, edit } = composingInCell(filter);
    b.undo.undo();
    shared.send(b, a);
    assert.deepEqual(edit.commit(a.origin), { status, text: "Y" });
    assert.equal(a.log.length, status === "written" ? 1 : 0);
    assert.equal(agreed(shared, visualText), expected);
    assert.equal(agreed(shared, beats), "");
    shared.close();
  });
}

for (const [filter, status] of [["keep content", "moved"], ["keep cells", "written"]] as const) {
  test(`B undoes and redoes the split while A composes Y in beat 2's visual cell, filter "${filter}": Y reaches the live cell (${status})`, () => {
    const { shared, a, b, edit } = composingInCell(filter);
    b.undo.undo();
    b.undo.redo();
    shared.send(b, a);
    assert.deepEqual(edit.commit(a.origin), { status, text: "Y" });
    assert.equal(agreed(shared, visualText), "2:Y");
    assert.equal(agreed(shared, beats), "2");
    shared.close();
  });
}

test("B deletes beat 2's visual cell directly while A composes Y in it: nothing is written and Y comes back for recovery", () => {
  const { shared, a, b, edit } = composingInCell("keep cells");
  local(b, () => b.doc.getMap("visuals").delete("2"));
  shared.send(b, a);
  assert.deepEqual(edit.commit(a.origin), { status: "recovery", text: "Y" });
  assert.equal(a.log.length, 0);
  assert.equal(agreed(shared, visualText), "");
  shared.close();
});

test("B replaces beat 2's visual cell with a new one holding Z while A composes Y in the old one: Y goes after Z", () => {
  const { shared, a, b, edit } = composingInCell("keep cells");
  local(b, () => b.doc.getMap("visuals").set("2", new Y.Text("Z")));
  shared.send(b, a);
  assert.deepEqual(edit.commit(a.origin), { status: "moved", text: "Y" });
  assert.equal(agreed(shared, visualText), "2:ZY");
  shared.close();
});

test("B removes beat 2 by flag and restores it while A composes Y in its visual cell: the cell is the same and Y lands", () => {
  const { shared, a, b, edit } = composingInCell("keep cells");
  local(b, () => (b.doc.getMap("beats").get("2") as Y.Map<unknown>).set("removed", { by: "B", at: 1 }));
  local(b, () => (b.doc.getMap("beats").get("2") as Y.Map<unknown>).delete("removed"));
  shared.send(b, a);
  assert.deepEqual(edit.commit(a.origin), { status: "written", text: "Y" });
  assert.equal(agreed(shared, visualText), "2:Y");
  shared.close();
});

for (const [filter, expected] of [["keep content", ""], ["keep cells", "2:Y"]] as const) {
  test(`control without composition, filter "${filter}": A types Y into the cell and B's undo cross on the wire`, () => {
    const { shared, a, b } = segmented(filter);
    split(b, 2, "2");
    shared.sync();
    local(a, () => (a.doc.getMap("visuals").get("2") as Y.Text).insert(0, "Y"));
    b.undo.undo();
    assert.equal(agreed(shared, visualText), expected);
    shared.close();
  });
}

test("control: when A's Y reaches B before B's undo, the delete filter keeps the cell and Y", () => {
  const { shared, a, b } = segmented("keep content");
  split(b, 2, "2");
  shared.sync();
  local(a, () => (a.doc.getMap("visuals").get("2") as Y.Text).insert(0, "Y"));
  shared.send(a, b);
  b.undo.undo();
  assert.equal(agreed(shared, visualText), "2:Y");
  assert.equal(agreed(shared, shownText), "abcd");
  shared.close();
});

const wellFormed = (doc: Y.Doc): string => malformed(view(text(doc)).map(seen => seen.token)).join(",") || "ok";

for (const [name, base, remote, local_, expected] of [
  ["B deletes the emoji; A composes Y right after it", "a😀b", (t: Y.Text) => t.delete(1, 2), (e: Composition) => e.insert(3, "Y"), "aYb"],
  ["A composes the emoji away; B types X right after it", "a😀b", (t: Y.Text) => t.insert(3, "X"), (e: Composition) => e.delete(1, 3), "aXb"],
  ["tie: B types an emoji after a; A composes another there", "ab", (t: Y.Text) => t.insert(1, "😁"), (e: Composition) => e.insert(1, "😺"), "a😺😁b"],
  ["A composes a joined family emoji away; B types X right after it", "a👩‍👧b", (t: Y.Text) => t.insert(6, "X"), (e: Composition) => e.delete(1, 6), "aXb"],
  ["B deletes a joined family emoji; A composes Y right after it", "a👩‍👧b", (t: Y.Text) => t.delete(1, 5), (e: Composition) => e.insert(6, "Y"), "aYb"],
  ["A composes e with a combining accent away; B bolds it", "aéb", (t: Y.Text) => t.format(1, 2, { b: true }), (e: Composition) => e.delete(1, 3), "ab"],
  ["B deletes the atom; A composes Y right after it", "a\u0000b", (t: Y.Text) => t.delete(1, 1), (e: Composition) => e.insert(2, "Y"), "aYb"],
  ["A composes the atom away; B puts another atom right after it", "a\u0000b", (t: Y.Text) => t.insertEmbed(2, { k: "t" }), (e: Composition) => e.delete(1, 2), "a[t]b"],
  ["tie: B puts an atom after a; A composes Y there", "a\u0000b", (t: Y.Text) => t.insertEmbed(1, { k: "t" }), (e: Composition) => e.insert(1, "Y"), "aY[t][s]b"]
] as const) {
  test(`edges: ${name}`, () => {
    const { shared, a, b, edit } = composing(doc => {
      const [left, right] = base.split("\u0000") as [string, string | undefined];
      text(doc).insert(0, left);
      if (right !== undefined) { text(doc).insertEmbed(left.length, { k: "s" }); text(doc).insert(left.length + 1, right); }
    });
    local_(edit);
    remote(text(b.doc));
    shared.send(b, a);
    edit.commit(a.origin);
    assert.equal(agreed(shared, shownText), expected);
    assert.equal(agreed(shared, wellFormed), "ok");
    shared.close();
  });
}

test("edges: an edit that would cut a surrogate pair on the screen is refused", () => {
  const { shared, edit } = composing(doc => { text(doc).insert(0, "a😀b"); });
  assert.throws(() => edit.insert(2, "Y"), /cuts a surrogate pair/);
  assert.throws(() => edit.delete(1, 2), /cuts a surrogate pair/);
  shared.close();
});

for (const [name, setup, remote, local_, expected, expectedBold] of [
  ["B bolds bc; A composes Y between b and c: Y takes b's bold", false, (t: Y.Text) => t.format(1, 2, { b: true }), (e: Composition) => e.insert(2, "Y"), "abYcd", "bYc"],
  ["B bolds bc; A composes Y over bc: Y takes a's plain", false, (t: Y.Text) => t.format(1, 2, { b: true }), (e: Composition) => e.replace(1, 3, "Y"), "aYd", ""],
  ["all bold, B unbolds bc; A composes Y after c: Y takes c's plain", true, (t: Y.Text) => t.format(1, 2, { b: null }), (e: Composition) => e.insert(3, "Y"), "abcYd", "ad"]
] as const) {
  test(`formatting changed remotely over the pending range: ${name}`, () => {
    const { shared, a, b, edit } = composing(doc => { text(doc).insert(0, "abcd", setup ? { b: true } : {}); });
    local_(edit);
    remote(text(b.doc));
    shared.send(b, a);
    edit.commit(a.origin);
    assert.equal(agreed(shared, shownText), expected);
    assert.equal(agreed(shared, doc => bold(text(doc))), expectedBold);
    shared.close();
  });
}

test("B undoes its painted typing XY while A composes Z between X and Y: Z stays where the XY was", () => {
  const shared = room([1, 2, 3], doc => { text(doc).insert(0, "ab"); });
  const [a, b] = shared.replicas as [Replica, Replica];
  local(b, () => text(b.doc).insert(1, "XY"));
  shared.sync();
  const edit = new Composition(text(a.doc));
  edit.insert(2, "Z");
  b.undo.undo();
  shared.send(b, a);
  edit.commit(a.origin);
  assert.equal(agreed(shared, shownText), "aZb");
  shared.close();
});

test("B deletes bc and undoes it while A composes bc away: B's restored copies stay, A deleted only what it saw", () => {
  const { shared, a, b, edit } = composing(abcd);
  edit.delete(1, 3);
  local(b, () => text(b.doc).delete(1, 2));
  b.undo.undo();
  shared.send(b, a);
  assert.deepEqual(edit.commit(a.origin), { status: "unchanged", text: "" });
  assert.equal(agreed(shared, shownText), "abcd");
  shared.close();
});

test("a cancelled composition writes nothing, and the remote change is shown", () => {
  const { shared, a, b, edit } = composing(abcd);
  edit.insert(2, "Y");
  edit.delete(0, 1);
  local(b, () => text(b.doc).insert(2, "X"));
  shared.send(b, a);
  edit.cancel();
  assert.equal(a.log.length, 0);
  assert.equal(agreed(shared, shownText), "abXcd");
  shared.close();
});

test("undo pressed while composing commits first, then undoes the composition only", () => {
  const { shared, a, b, edit } = composing(abcd);
  edit.insert(4, "Y");
  local(b, () => text(b.doc).insert(0, "X"));
  shared.send(b, a);
  a.undo.stopCapturing();
  edit.commit(a.origin);
  assert.notEqual(a.undo.undo(), null);
  assert.equal(agreed(shared, shownText), "Xabcd");
  shared.close();
});

for (const [clients, expected] of [[[1, 2], "YRy"], [[3, 2], "RYy"]] as const) {
  test(`finding, shortest order history: A ${clients[0]} composes Y before x; B ${clients[1]} types R after x, then deletes x; A gets only the deletion → ${expected}`, () => {
    const shared = room(clients, doc => { text(doc).insert(0, "xy"); });
    const [a, b] = shared.replicas as [Replica, Replica];
    const edit = new Composition(text(a.doc));
    edit.insert(0, "Y");
    local(b, () => text(b.doc).insert(1, "R"));
    local(b, () => text(b.doc).delete(0, 1));
    shared.send(b, a, 1);
    edit.commit(a.origin);
    assert.equal(agreed(shared, shownText), expected);
    shared.close();
  });
}
