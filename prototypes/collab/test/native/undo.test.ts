import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import type { NativeReplica, NativeScheme } from "../../src/native/variant.ts";
import { KitNet, cut, recovered, show, start, type } from "./kit.ts";

const SCHEMES: NativeScheme[] = ["name", "act"];
const pair = (rows: Parameters<typeof start>[0], scheme: NativeScheme = "name", count = 2): { a: NativeReplica; b: NativeReplica; c: NativeReplica; net: KitNet } => {
  const copies = start(rows, Math.max(count, 3), scheme), net = new KitNet(copies);
  return { a: copies[0] as NativeReplica, b: copies[1] as NativeReplica, c: copies[2] as NativeReplica, net };
};

test("typing undo with another person's typing in between takes back only one's own letters, and redo brings them back", () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "ab" }]);
  type(a, "R1", 2, "x"); net.settle(); type(b, "R1", 0, "Q"); net.settle(); type(a, "R1", 4, "y"); net.settle(); type(b, "R1", 4, "W"); net.settle();
  assert.deepEqual(net.agree(), ["R1: QabxWy"]);
  assert.equal(a.undoStep(), "undone"); net.settle(); assert.deepEqual(net.agree(), ["R1: QabxW"]);
  assert.equal(a.undoStep(), "undone"); net.settle(); assert.deepEqual(net.agree(), ["R1: QabW"]);
  assert.equal(a.undoStep(), "empty");
  assert.equal(a.redoStep(), "undone"); assert.equal(a.redoStep(), "undone"); net.settle();
  assert.deepEqual(net.agree(), ["R1: QabxWy"]);
});

test("typing within the grouping time is one entry although another person's text arrived in between", () => {
  const copies = start([{ id: "R1", audioText: "ab" }], 2, "name", 60_000), net = new KitNet(copies), [a, b] = copies as [NativeReplica, NativeReplica];
  type(a, "R1", 2, "x"); net.settle(); type(b, "R1", 0, "Q"); net.settle(); type(a, "R1", 4, "y"); net.settle();
  assert.equal(a.undo.undoStack.length, 1);
  a.undoStep(); net.settle();
  assert.deepEqual(net.agree(), ["R1: Qab"]);
});

test("a new command clears redo", () => {
  const { a, net } = pair([{ id: "R1", audioText: "ab" }]);
  type(a, "R1", 2, "x"); a.undoStep(); type(a, "R1", 2, "y");
  assert.equal(a.redoStep(), "empty"); net.settle();
  assert.deepEqual(net.agree(), ["R1: aby"]);
});

test("another person's change does nothing to one's stacks", () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "ab" }]);
  type(a, "R1", 2, "x"); type(a, "R1", 3, "y"); a.undoStep();
  const before = [a.undo.undoStack.length, a.undo.redoStack.length];
  type(b, "R1", 0, "Q"); b.format("R1", "audioText", 0, 2, { b: true }); b.changes(); net.settle();
  assert.deepEqual([a.undo.undoStack.length, a.undo.redoStack.length], before);
  assert.equal(a.redoStep(), "undone"); net.settle();
  assert.deepEqual(net.agree(), ["R1: [Qa|b]bxy"]);
});

for (const scheme of SCHEMES) test(`issue 1612, ${scheme} keys: bold undone and redone after someone else's unseen split, before and inside the word`, () => {
  for (const [at, split, plain] of [[2, ["R1: a ", "Rb: [cup|b] of tea"], ["R1: a ", "Rb: cup of tea"]], [3, ["R1: a [c|b]", "Rb: [up|b] of tea"], ["R1: a c", "Rb: up of tea"]]] as const) {
    const { a, b, net } = pair([{ id: "R1", audioText: "a cup of tea" }], scheme);
    a.format("R1", "audioText", 2, 5, { b: true }); a.changes();
    b.split("R1", at, "Rb"); b.changes(); net.settle();
    assert.deepEqual(net.agree(scheme), split);
    assert.equal(a.undoStep(), "undone"); net.settle(); assert.deepEqual(net.agree(scheme), plain);
    assert.equal(a.redoStep(), "undone"); net.settle(); assert.deepEqual(net.agree(scheme), split);
  }
});

for (const scheme of SCHEMES) test(`${scheme} keys: bold undone after a split made with the bold in view leaves both halves plain`, () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "abcdef" }], scheme);
  a.format("R1", "audioText", 1, 5, { b: true }); a.changes(); net.settle();
  b.split("R1", 3, "Rb"); b.changes(); net.settle();
  a.undoStep(); net.settle();
  assert.deepEqual(net.agree(scheme), ["R1: abc", "Rb: def"]);
});

// why: with one key per name the plain letter is written between a marker that turns bold off and one that turns it on
// again; the undo removes the bold's own end, so the second marker reaches to the end of the text
for (const scheme of SCHEMES) test(`${scheme} keys: bold undone after someone typed plain text inside it${scheme === "name" ? " comes back on everything after that text (declared)" : " goes from both halves"}`, () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "abcdef" }], scheme);
  a.format("R1", "audioText", 1, 4, { b: true }); a.changes(); net.settle();
  type(b, "R1", 2, "X"); net.settle();
  assert.deepEqual(net.agree(scheme), ["R1: a[b|b]X[cd|b]ef"]);
  a.undoStep(); net.settle();
  assert.deepEqual(net.agree(scheme), [scheme === "name" ? "R1: abX[cdef|b]" : "R1: abXcdef"]);
});

for (const scheme of SCHEMES) test(`${scheme} keys: part of a bold range unformatted by one person while another unformats all of it${scheme === "name" ? " turns the rest of the text bold (declared)" : " leaves only the part after the gap bold"}`, () => {
  const copies = start([{ id: "R1", audioText: "abcdef" }], 3, scheme), net = new KitNet(copies), [a, b, c] = copies as [NativeReplica, NativeReplica, NativeReplica];
  b.format("R1", "audioText", 1, 3, { b: true }); b.changes(); net.settle();
  c.format("R1", "audioText", 1, 2, { b: null }); c.changes(); b.format("R1", "audioText", 0, 3, { b: null }); b.changes(); net.settle();
  assert.deepEqual(net.agree(scheme), [scheme === "name" ? "R1: ab[cdef|b]" : "R1: ab[c|b]def"]);
  assert.equal(a.undo.undoStack.length, 0);
});

test("split undo and redo with another person's typing on both sides (T12)", () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "abcd" }]);
  a.split("R1", 2, "Ra"); a.changes(); net.settle();
  type(b, "R1", 2, "Y"); type(b, "Ra", 0, "X"); net.settle();
  assert.deepEqual(net.agree(), ["R1: abY", "Ra: Xcd"]);
  assert.equal(a.undoStep(), "undone"); net.settle(); assert.deepEqual(net.agree(), ["R1: abYXcd"]);
  assert.equal(a.redoStep(), "undone"); net.settle(); assert.deepEqual(net.agree(), ["R1: abY", "Ra: Xcd"]);
});

test("finding: a split whose new beat is created inside the undone transaction loses what someone else typed in its visual cell", () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "abcd" }]);
  a.split("R1", 2, "Ra", {}, "tracked"); a.changes(); net.settle();
  type(b, "Ra", 0, "V", "visualText"); net.settle();
  a.undoStep(); net.settle();
  assert.deepEqual(net.agree(), ["R1: abcd"]);
  assert.equal(b.visuals.get("Ra"), undefined);
  assert.deepEqual(recovered(b), []);
});

test("the variant's split writes the new beat's record outside the undo history: the visual text is kept and listed after the undo", () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "abcd" }]);
  a.split("R1", 2, "Ra"); a.changes(); net.settle();
  type(b, "Ra", 0, "V", "visualText"); net.settle();
  a.undoStep(); net.settle();
  assert.deepEqual(net.agree(), ["R1: abcd"]);
  assert.deepEqual(recovered(b), ["Ra:  / V"]);
  a.redoStep(); net.settle();
  assert.deepEqual(net.agree(), ["R1: ab", "Ra: cd / V"]);
});

test("join undo and redo with another person's typing in the joined beat (T12 join)", () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }]);
  a.join("R2", "R1", " "); a.changes(); net.settle();
  type(b, "R2", 1, "Z"); net.settle();
  assert.deepEqual(net.agree(), ["R1: ab cZd"]);
  assert.equal(a.undoStep(), "undone"); net.settle(); assert.deepEqual(net.agree(), ["R1: ab", "R2: cZd"]);
  assert.equal(a.redoStep(), "undone"); net.settle(); assert.deepEqual(net.agree(), ["R1: ab cZd"]);
});

test("removal with a collaborator typing into the removed beat: the text is kept, listed and comes back with the undo (T10)", () => {
  const { a, b, c, net } = pair([{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }]);
  a.remove("R2", "Alice"); a.changes();
  type(b, "R2", 1, "X"); net.settle();
  assert.deepEqual(net.agree(), ["R1: ab", "R3: ef"]);
  assert.deepEqual(recovered(c), ["R2: cXd (unseen: X)"]);
  assert.equal(a.undoStep(), "undone"); net.settle();
  assert.deepEqual(net.agree(), ["R1: ab", "R2: cXd", "R3: ef"]);
  assert.deepEqual(recovered(c), []);
  assert.equal(a.redoStep(), "undone"); net.settle();
  assert.deepEqual(recovered(c), ["R2: cXd (unseen: X)"]);
});

test("declared: typing in a removed beat is undone at once, inside the removed beat, and does not wait for the restore", () => {
  const { a, b, c, net } = pair([{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }]);
  type(b, "R2", 1, "X"); net.settle();
  a.remove("R2", "Alice"); a.changes(); net.settle();
  assert.equal(b.undoStep(), "undone"); net.settle();
  assert.deepEqual(recovered(c), ["R2: cd"]);
});

test("deleted text restored by undo keeps its place around what someone typed inside it (T01), and the order of two restores", () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "abcd" }]);
  cut(a, "R1", 1, 3); type(b, "R1", 2, "X"); net.settle();
  assert.deepEqual(net.agree(), ["R1: aXd"]);
  a.undoStep(); net.settle(); assert.deepEqual(net.agree(), ["R1: abXcd"]);
  a.redoStep(); net.settle(); assert.deepEqual(net.agree(), ["R1: aXd"]);
  const second = pair([{ id: "R1", audioText: "abcdef" }]);
  cut(second.a, "R1", 3, 5); cut(second.a, "R1", 1, 3); second.a.undoStep(); second.a.undoStep(); second.net.settle();
  assert.deepEqual(second.net.agree(), ["R1: abcdef"]);
});

test("the declared limits of main's shared undo, as the variant gives them", () => {
  let { a, b, net } = pair([{ id: "R1", audioText: "abcd" }]);
  cut(a, "R1", 1, 3); cut(b, "R1", 2, 3); net.settle(); a.undoStep(); b.undoStep(); net.settle();
  assert.deepEqual(net.agree(), ["R1: abccd"], "double-restore: carried on main, the same here");
  ({ a, b, net } = pair([{ id: "R1", audioText: "abcd" }]));
  cut(a, "R1", 1, 3); net.settle(); type(b, "R1", 1, "X"); net.settle(); a.undoStep(); net.settle();
  assert.deepEqual(net.agree(), ["R1: abcXd"], "insert-after-deleted-run: carried on main, the same here");
  ({ a, b, net } = pair([{ id: "R1", audioText: "ab" }]));
  cut(b, "R1", 1, 2); b.undoStep(); type(a, "R1", 2, "X"); net.settle();
  assert.deepEqual(net.agree(), ["R1: abX"], "typed-beside-restored: main gives aXb, the variant the model's abX");
  ({ a, b, net } = pair([{ id: "R1", audioText: "abc" }]));
  a.format("R1", "audioText", 0, 2, { b: true }); a.changes(); net.settle();
  b.format("R1", "audioText", 0, 3, { b: null }); b.changes(); b.format("R1", "audioText", 1, 3, { b: true }); b.changes(); net.settle();
  assert.equal(a.undoStep(), "used-up");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: a[bc|b]"], "later-format: the visible result is main's");
  ({ a, net } = pair([{ id: "R1", audioText: "ab", status: "todo" }]));
  a.setField("R1", "status", "ready"); a.setField("R1", "status", "shot"); net.settle();
  a.undoStep(); assert.equal(a.beats.get("R1")?.get("status"), "ready");
  a.undoStep(); assert.equal(a.beats.get("R1")?.get("status"), "todo", "sequential-status");
  ({ a, b, net } = pair([{ id: "R1", audioText: "ab" }]));
  a.format("R1", "audioText", 0, 2, { "t:P": true }); a.changes(); b.format("R1", "audioText", 0, 1, { b: true }); b.changes(); net.settle();
  a.undoStep(); a.redoStep(); net.settle("reverse");
  assert.deepEqual(net.agree(), ["R1: [a|b,t:P][b|t:P]"], "redone-mark-reversed: the tag stays on every copy");
});

const rows = [{ id: "R1", audioText: "ab", status: "todo" }, { id: "R2", audioText: "cd", status: "todo" }];
const identical: Record<string, (replica: NativeReplica) => void> = {
  join: replica => { replica.join("R2", "R1", " "); },
  status: replica => { replica.setField("R2", "status", "ready"); },
  removal: replica => { replica.remove("R2", "Someone"); },
  tag: replica => { replica.format("R2", "audioText", 0, 2, { "t:P": true }); }
};
const reading = (net: KitNet, replica: NativeReplica, scheme: NativeScheme): string =>
  `${net.agree(scheme).join("; ")}; status ${String(replica.beats.get("R2")?.get("status") ?? "none")}; older steps ${replica.undo.undoStack.length}`;
const untouched = "R1: abx; R2: cd; status todo; older steps 1";

// why: client 2's write stands when two copies write one key or one attribute at the same moment
const PLAIN: Record<string, [string, string]> = {
  "join name": ["R1: ab cd; status todo; older steps 0", untouched],
  "status name": ["R1: ab; R2: cd; status ready; older steps 0", "R1: abx; R2: cd; status none; older steps 1"],
  "removal name": ["R1: ab; status todo; older steps 0", untouched],
  "tag name": [untouched, "R1: abx; R2: [cd|t:P]; status todo; older steps 1"],
  "tag act": ["R1: abx; R2: [cd|t:P]; status todo; older steps 1", "R1: abx; R2: [cd|t:P]; status todo; older steps 1"]
};

for (const [name, act] of Object.entries(identical)) for (const scheme of SCHEMES) {
  if (scheme === "act" && name !== "tag") continue;
  const made = (undoer: number): { me: NativeReplica; other: NativeReplica; net: KitNet } => {
    const copies = start(rows, 2, scheme), net = new KitNet(copies), me = copies[undoer] as NativeReplica, other = copies[1 - undoer] as NativeReplica;
    type(me, "R1", 2, "x"); net.settle();
    act(me); me.changes(); act(other); other.changes(); net.settle();
    return { me, other, net };
  };
  test(`the same ${name} made by two people at once, ${scheme} keys: what plain undo() does depends on whose write stands`, () => {
    for (const undoer of [0, 1]) {
      const { me, net } = made(undoer);
      me.undo.undo(); me.changes(); net.settle();
      assert.equal(reading(net, me, scheme), PLAIN[`${name} ${scheme}`]?.[undoer], `undo by client ${undoer + 1}`);
    }
  });
  test(`the same ${name} made by two people at once, ${scheme} keys: with the guarded step either person's undo takes it back and the other's is used up`, () => {
    for (const undoer of [0, 1]) {
      const { me, other, net } = made(undoer);
      assert.equal(me.undoStep(), "undone"); me.changes(); net.settle();
      assert.equal(reading(net, me, scheme), untouched, `undo by client ${undoer + 1}`);
      const outcome = other.undoStep();
      other.changes(); net.settle();
      // why: with one key per name the other copy may still hold markers the first undo made redundant; deleting them
      // counts as a change to the library although nothing visible changes, so that step is spent without a notice
      if (name !== "tag" || scheme !== "name") assert.equal(outcome, "used-up");
      assert.equal(reading(net, me, scheme), untouched);
    }
  });
}

test("declared: when one person undoes before the other's identical change arrives, the change shows until the other undoes too", () => {
  const copies = start(rows), net = new KitNet(copies), [a, b] = copies as [NativeReplica, NativeReplica];
  a.join("R2", "R1", " "); a.changes(); b.join("R2", "R1", " "); b.changes();
  assert.equal(a.undoStep(), "undone"); net.settle();
  assert.deepEqual(net.agree(), ["R1: ab cd"]);
  assert.equal(b.undoStep(), "undone"); net.settle();
  assert.deepEqual(net.agree(), ["R1: ab", "R2: cd"]);
});

test("two different statuses set at once (T21 scalar): the loser's undo is used up and keeps the older typing, the winner's brings the old status back", () => {
  const copies = start(rows), net = new KitNet(copies), [a, b] = copies as [NativeReplica, NativeReplica];
  type(a, "R1", 2, "Z"); a.setField("R1", "status", "ready"); b.setField("R1", "status", "shot"); net.settle();
  assert.equal(a.beats.get("R1")?.get("status"), "shot");
  assert.equal(a.undoStep(), "used-up"); net.settle();
  assert.deepEqual(show(a), ["R1: abZ", "R2: cd"]);
  assert.equal(b.undoStep(), "undone"); net.settle();
  assert.equal(a.beats.get("R1")?.get("status"), "todo");
});

test("both join, one undoes, the other's later undo is used up and reaches no older step (T06, text and undo only)", () => {
  const copies = start([{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }]), net = new KitNet(copies), [a, b] = copies as [NativeReplica, NativeReplica];
  a.format("R1", "audioText", 0, 2, { b: true }); a.changes(); type(b, "R2", 2, "!"); net.settle();
  a.join("R2", "R1", " "); a.changes(); b.join("R2", "R1", " "); b.changes(); net.settle();
  assert.deepEqual(net.agree(), ["R1: [ab|b] cd!"]);
  assert.equal(a.undoStep(), "undone"); net.settle();
  assert.deepEqual(net.agree(), ["R1: [ab|b]", "R2: cd!"]);
  assert.equal(b.undoStep(), "used-up"); net.settle();
  assert.deepEqual(net.agree(), ["R1: [ab|b]", "R2: cd!"]);
  assert.equal(a.undoStep(), "undone"); net.settle();
  assert.deepEqual(net.agree(), ["R1: ab", "R2: cd!"]);
});

test("grouping as the library alone gives it: an undo ends the typing group; a group that deleted all it typed keeps an entry", () => {
  const fresh = (): [NativeReplica, NativeReplica] => start([{ id: "R1", audioText: "ab" }], 2, "name", 60_000) as [NativeReplica, NativeReplica];
  let [a] = fresh();
  type(a, "R1", 2, "x"); a.undo.stopCapturing(); type(a, "R1", 3, "y"); a.undo.undo(); type(a, "R1", 3, "z");
  assert.equal(a.undo.undoStack.length, 2);
  a.undo.undo();
  assert.deepEqual(show(a), ["R1: abx"]);
  [a] = fresh();
  type(a, "R1", 2, "x"); a.undo.stopCapturing(); type(a, "R1", 3, "y"); cut(a, "R1", 3, 4);
  assert.equal(a.undo.undoStack.length, 2, "a group that deleted all it typed keeps its entry");
  assert.equal(a.undoStep(), "used-up");
  assert.deepEqual(show(a), ["R1: abx"]);
});

test("declared: a letter someone else deleted and brought back is no longer the typist's to undo", () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "ab" }]);
  type(a, "R1", 2, "x"); net.settle(); cut(b, "R1", 2, 3); net.settle(); b.undoStep(); net.settle();
  assert.equal(a.undoStep(), "used-up"); net.settle();
  assert.deepEqual(net.agree(), ["R1: abx"]);
});

// why: main's rule leaves c plain before the undo; here plain text typed unseen inside the run keeps the bold after it
for (const scheme of SCHEMES) test(`${scheme} keys: an unformat undone puts bold back where it was; text someone typed plain inside stays plain`, () => {
  const { a, b, net } = pair([{ id: "R1", audioText: "abcd" }], scheme);
  a.format("R1", "audioText", 0, 4, { b: true }); a.changes(); net.settle();
  a.format("R1", "audioText", 1, 3, { b: null }); a.changes(); type(b, "R1", 2, "X"); net.settle();
  const apart = net.agree(scheme);
  assert.equal(a.undoStep(), "undone"); net.settle();
  assert.deepEqual([apart, net.agree(scheme)], [["R1: [a|b]bX[cd|b]"], ["R1: [ab|b]X[cd|b]"]]);
});

test("a status that lost to another person's leaves nothing to redo; a restore does not undo a removal it had not seen", () => {
  const copies = start(rows), net = new KitNet(copies), [a, b] = copies as [NativeReplica, NativeReplica];
  a.setField("R1", "status", "ready"); b.setField("R1", "status", "shot"); net.settle();
  assert.deepEqual([a.undoStep(), a.redoStep()], ["used-up", "empty"]);
  a.remove("R2", "Alice"); a.changes(); net.settle();
  a.restore("R2"); a.changes(); b.restore("R2"); b.changes(); b.remove("R2", "Bob"); b.changes(); net.settle();
  assert.deepEqual(net.agree(), ["R1: ab"]);
});

test("what 50 undone splits leave on a copy without undo history, with the new beat's record kept and with it undone", () => {
  const left = (["apart", "tracked"] as const).map(record => {
    const [a] = start([{ id: "R1", audioText: "abcdef" }], 1) as [NativeReplica], stored = new Y.Doc();
    Y.applyUpdate(stored, a.encode());
    a.doc.on("update", (update: Uint8Array) => { Y.applyUpdate(stored, update); });
    const before = Y.encodeStateAsUpdate(stored).length;
    for (let index = 0; index < 50; index++) { a.split("R1", 2, `split-0-${index}`, {}, record); a.changes(); a.undo.undo(); a.changes(); }
    return { record, bytes: Y.encodeStateAsUpdate(stored).length - before, records: a.beats.size };
  });
  assert.deepEqual(left, [{ record: "apart", bytes: 2557, records: 51 }, { record: "tracked", bytes: 2451, records: 1 }]);
});

test("pending-update, a limit main carries, is the same here: a deletion applies before the update it follows has arrived", () => {
  const { b, c } = pair([{ id: "R1", audioText: "ab" }]), sent: Uint8Array[] = [];
  b.doc.on("update", (update: Uint8Array) => { sent.push(update); });
  type(b, "R1", 2, "X"); b.splice("R1", "audioText", 0, 1, [{ text: "Y", marks: {} }]); b.changes();
  assert.equal(sent.length, 2);
  Y.applyUpdate(c.doc, sent[1] as Uint8Array, "remote");
  assert.deepEqual(show(c), ["R1: b"]);
  Y.applyUpdate(c.doc, sent[0] as Uint8Array, "remote");
  c.changes();
  assert.deepEqual(show(c), ["R1: YbX"]);
});
