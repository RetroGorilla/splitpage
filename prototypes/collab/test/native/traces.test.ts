import assert from "node:assert/strict";
import test from "node:test";
import type { NativeReplica } from "../../src/native/variant.ts";
import { KitNet, cut, recovered, start, type } from "./kit.ts";
import type { KitOrder, KitRow } from "./kit.ts";

// why: the document half of the Stage 1 trace table in docs/collaboration/stage-0/8-schema-hypotheses.md, section 3;
// carets, repaint and composition belong to the editing buffer, which this spike does not replace
const ORDERS: KitOrder[] = ["forward", "reverse", "twice"];

function trace(name: string, rows: readonly KitRow[], run: (a: NativeReplica, b: NativeReplica, net: KitNet, order: KitOrder) => void): void {
  test(name, () => {
    for (const order of ORDERS) {
      const copies = start(rows, 3), net = new KitNet(copies);
      run(copies[0] as NativeReplica, copies[1] as NativeReplica, net, order);
    }
  });
}

trace("T01: a deletion of bc and an insertion between b and c made apart", [{ id: "R1", audioText: "abcd" }], (a, b, net, order) => {
  cut(a, "R1", 1, 3); type(b, "R1", 2, "X"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: aXd"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: abXcd"]);
});

trace("T02 and T02 boundary: typing at the end while text arrives at the start, and in the next beat", [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }], (a, b, net, order) => {
  type(b, "R1", 0, "X"); net.deliver(b, a); type(a, "R1", 3, "c"); type(b, "R1", 3, "Y"); type(a, "R2", 0, "Z"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: XabcY", "R2: Zcd"]);
  a.undoStep(); a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: XabY", "R2: cd"]);
});

trace("T03 and T03 replace: bold on the first word while the second is deleted; a replaced word beside appended text", [{ id: "R1", audioText: "the the" }], (a, b, net, order) => {
  b.format("R1", "audioText", 0, 3, { b: true }); b.changes();
  for (let index = 7; index > 3; index--) cut(a, "R1", index - 1, index);
  net.settle(order);
  assert.deepEqual(net.agree(), ["R1: [the|b]"]);
  for (let index = 0; index < 4; index++) a.undoStep();
  net.settle(order);
  assert.deepEqual(net.agree(), ["R1: [the|b] the"]);
  a.splice("R1", "audioText", 4, 7, [{ text: "a", marks: {} }]); a.changes(); type(b, "R1", 7, "n"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: [the|b] an"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: [the|b] then"]);
});

trace("T04: text typed in the middle while text arrives at the start and the last letter is deleted", [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }], (a, b, net, order) => {
  type(a, "R1", 2, "xy"); type(b, "R1", 0, "Z"); cut(b, "R1", 4, 5); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: Zabxyc", "R2: ef"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: Zabc", "R2: ef"]);
});

trace("T04 removed: text typed into a beat someone removes at the same moment is kept and marked as typed after the removal", [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }], (a, b, net, order) => {
  type(a, "R1", 2, "xy"); b.remove("R1", "Bob"); b.changes(); net.settle(order);
  assert.deepEqual(net.agree(), ["R2: ef"]);
  assert.deepEqual(recovered(a), ["R1: abxycd (unseen: xy)"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(recovered(b), ["R1: abcd"]);
});

trace("T05: a split and a letter typed at the same gap", [{ id: "R1", audioText: "abcd" }], (a, b, net, order) => {
  a.split("R1", 2, "Ra"); a.changes(); type(b, "R1", 2, "X"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: ab", "Ra: Xcd"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: abXcd"]);
});

trace("T05 two splits: both split at one gap; one beat is empty, the other holds the rest", [{ id: "R1", audioText: "abcd" }], (a, b, net, order) => {
  a.split("R1", 2, "Ra"); a.changes(); b.split("R1", 2, "Rb"); b.changes(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: ab", "Ra: ", "Rb: cd"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: ab", "Rb: cd"]);
});

trace("T07: a join while someone types in the joined beat's visual", [{ id: "R1", audioText: "a", visualText: "v" }, { id: "R2", audioText: "b", visualText: "wz" }], (a, b, net, order) => {
  a.join("R2", "R1", " "); a.changes(); type(b, "R2", 1, "Q", "visualText"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: a b / v\nwQz"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: a / v", "R2: b / wQz"]);
});

trace("T09: a selection across three beats replaced while someone types in all three", [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "de" }, { id: "R3", audioText: "fgh" }], (a, b, net, order) => {
  a.splice("R1", "audioText", 1, 3, [{ text: "Z", marks: {} }]); a.remove("R2", "Alice"); a.splice("R3", "audioText", 0, 2, []); a.changes();
  type(b, "R1", 2, "W"); type(b, "R2", 1, "X"); type(b, "R3", 2, "Y"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: aZW", "R3: Yh"]);
  assert.deepEqual(recovered(b), ["R2: dXe (unseen: X)"]);
  // why: the spike writes this command as three transactions, so its undo is three steps here
  a.undoStep(); a.undoStep(); a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: abWc", "R2: dXe", "R3: fgYh"]);
});

trace("T10: a removal, typing by someone who had not seen it, a late joiner, then the undo", [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }], (a, b, net, order) => {
  a.remove("R2", "Alice"); a.changes(); type(b, "R2", 1, "X"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: ab", "R3: ef"]);
  assert.deepEqual(recovered(net.late()), ["R2: cXd (unseen: X)"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: ab", "R2: cXd", "R3: ef"]);
  assert.deepEqual(recovered(net.late()), []);
});

trace("T11, marks only: comments on a beat that is removed while someone splits it unseen", [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }], (a, b, net, order) => {
  a.format("R1", "audioText", 1, 3, { "c:C1": true }); a.changes(); b.format("R1", "audioText", 2, 4, { "c:C2": true }); b.changes(); net.settle(order);
  a.remove("R1", "Alice"); a.changes(); b.split("R1", 2, "Rb"); b.changes(); net.settle(order);
  assert.deepEqual(net.agree(), ["Rb: [c|c:C1,c:C2][d|c:C2]", "R2: ef"], "declared: the half split off unseen stays in the script");
  assert.deepEqual(recovered(a), ["R1: a<span class=\"cmt-anchor\" data-cmt=\"C1\">b</span>"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: a[b|c:C1]", "Rb: [c|c:C1,c:C2][d|c:C2]", "R2: ef"]);
});

trace("T12 and T12 join: a split and a join undone and redone after someone typed on both sides", [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }], (a, b, net, order) => {
  a.split("R1", 2, "Ra"); a.changes(); net.settle(order);
  type(b, "R1", 2, "Y"); type(b, "Ra", 0, "X"); net.settle(order);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: abYXcd", "R2: ef"]);
  a.redoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: abY", "Ra: Xcd", "R2: ef"]);
  a.join("R2", "Ra", " "); a.changes(); net.settle(order); type(b, "R2", 1, "Z"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: abY", "Ra: Xcd eZf"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: abY", "Ra: Xcd", "R2: eZf"]);
});

trace("T20 nest, cross and mark: two tags, a comment and a link made apart all stay", [{ id: "R1", audioText: "the red mug" }], (a, b, net, order) => {
  a.format("R1", "audioText", 4, 11, { "t:P": true }); a.changes(); b.format("R1", "audioText", 8, 11, { "t:S": true }); b.changes(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: the [red |t:P][mug|t:P,t:S]"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: the red [mug|t:S]"]);
  a.redoStep(); b.format("R1", "audioText", 0, 7, { "t:Q": true }); b.changes(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: [the |t:Q][red|t:P,t:Q][ |t:P][mug|t:P,t:S]"], "declared: crossing tags are both stored; the table's provisional rule drops one");
  b.format("R1", "audioText", 8, 11, { "c:C1": true }); b.changes(); b.format("R1", "audioText", 4, 7, { "l:http://x": true }); b.changes(); net.settle(order);
  b.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: [the |t:Q][red|t:P,t:Q][ |t:P][mug|c:C1,t:P,t:S]"]);
});

trace("T21: bold on bc while someone types unseen between b and c, then the undo", [{ id: "R1", audioText: "abcd" }], (a, b, net, order) => {
  a.format("R1", "audioText", 1, 3, { b: true }); a.changes(); type(b, "R1", 2, "X"); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: a[bXc|b]d"]);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: abXcd"]);
});

trace("T21 comment, marks only: a comment undone and redone beside another person's comment", [{ id: "R1", audioText: "abcd" }], (a, b, net, order) => {
  a.format("R1", "audioText", 1, 3, { "c:C1": true }); a.changes(); net.settle(order);
  b.format("R1", "audioText", 2, 4, { "c:C2": true }); b.changes(); net.settle(order);
  a.undoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: ab[cd|c:C2]"]);
  a.redoStep(); net.settle(order);
  assert.deepEqual(net.agree(), ["R1: a[b|c:C1][c|c:C1,c:C2][d|c:C2]"]);
});
