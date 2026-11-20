import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { closeNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextRange } from "../../../../src/adapters/collab/native/text-commands.ts";
import { shown } from "./helpers.ts";
import { caret, copiesOf, join, remove, rowsOf, split, stateOf, storedOf, structureScript, unjoin } from "./structure-harness.ts";

after(() => { dom.window.close(); });

function one(rows: Record<string, string>, visuals: Record<string, string> = {}) {
  const { all: [copy] } = copiesOf(structureScript(rows, visuals), [2]);
  assert.ok(copy);
  return copy;
}

test("a split writes a boundary, a record holding only the parent's rank and an empty visual cell, and every copy reads it", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "defgh", C: "ijk" }, { B: "wide" }));
  assert.ok(a && b);
  const created = split(a, "B", 2);
  assert.match(created, /^r2-[0-9a-z]+$/);
  assert.deepEqual(rowsOf(a), ["A: abc", "B: de", `${created}: fgh`, "C: ijk"]);
  assert.deepEqual(a.roots.beats.get(created)?.toJSON(), { rank: a.roots.beats.get("B")?.get("rank") });
  assert.equal(a.roots.visuals.get(created)?.toString(), "");
  assert.equal(a.reader.row("B")?.visualText, "wide");
  net.settle();
  assert.deepEqual(net.agree(), ["A: abc / ", "B: de / wide", `${created}: fgh / `, "C: ijk / "]);
  assert.equal(storedOf(b), `[A]abc[B]de[${created}]fgh[C]ijk`);
});

test("a split at a row's start or end leaves one side empty, and a split of a segment's first row keeps its head", () => {
  const copy = one({ A: "abc", B: "def" });
  const start = split(copy, "A", 0), end = split(copy, "B", 3);
  assert.deepEqual(rowsOf(copy), ["A: ", `${start}: abc`, "B: def", `${end}: `]);
  assert.deepEqual(copy.roots.segments.get("b:A")?.get("head"), { b: "A" });
  assert.equal(storedOf(copy), `[A][${start}]abc[B]def[${end}]`);
});

test("a split is one transaction and two splits by one copy get different ids", () => {
  const copy = one({ A: "abcd" });
  let transactions = 0;
  copy.doc.on("afterTransaction", () => { transactions++; });
  const first = split(copy, "A", 1), second = split(copy, "A", 1);
  assert.equal(transactions, 2);
  assert.notEqual(first, second);
  assert.deepEqual(rowsOf(copy), ["A: a", `${second}: `, `${first}: bcd`]);
});

test("two copies splitting one row at once keep narration order, in either client order and delivery", () => {
  for (const clients of [[2, 3], [3, 2]]) for (const order of ["forward", "reverse", "twice"] as const) {
    const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "defghi", C: "jk" }), clients);
    assert.ok(a && b);
    const left = split(a, "B", 1), right = split(b, "B", 4);
    net.settle(order);
    assert.deepEqual(rowsOf(a), ["A: abc", "B: d", `${left}: efg`, `${right}: hi`, "C: jk"], `clients ${clients.join(",")}, ${order}`);
    net.agree();
  }
});

test("two copies splitting one row at the same place both get a row, one of them empty, and every copy agrees", () => {
  for (const clients of [[2, 3], [3, 2]]) {
    const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "def" }), clients);
    assert.ok(a && b);
    const mine = split(a, "B", 1), theirs = split(b, "B", 1);
    net.settle();
    const rows = rowsOf(a);
    assert.equal(rows.length, 4);
    assert.deepEqual([rows[0], rows[1]], ["A: abc", "B: d"]);
    const created = rows.slice(2);
    assert.deepEqual(new Set(created.map(row => row.replace(/^[^:]+: /, ""))), new Set(["", "ef"]));
    assert.deepEqual(new Set(created.map(row => row.split(":")[0])), new Set([mine, theirs]));
    net.agree();
  }
});

test("a split refuses, writing nothing, when the row is gone, its record or cell is gone, or a peer split the caret off", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "def", C: "ghi", D: "jkl" }));
  assert.ok(a && b);
  const inB = caret(b, "B", 1), inC = caret(b, "C", 2), inD = caret(b, "D", 1);
  remove(a, "B"); split(a, "C", 1);
  a.doc.transact(() => { a.roots.visuals.delete("D"); });
  net.settle();
  const before = stateOf(b);
  assert.deepEqual(splitNativeRow(b, inB), { kind: "refused", reason: "missing" });
  assert.deepEqual(splitNativeRow(b, inC), { kind: "refused", reason: "range" });
  assert.deepEqual(splitNativeRow(b, inD), { kind: "refused", reason: "missing" });
  assert.deepEqual(stateOf(b), before);
});

test("a split whose caret letter a peer deleted splits where that letter stood", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "abcdef" }));
  assert.ok(a && b);
  const at = caret(b, "A", 3);
  const cut = anchorNativeText(a, { beat: "A", cell: "narration" }, 2, 4);
  assert.ok(cut.kind === "anchored");
  assert.equal(typeNativeText(a, cut.range, "", {}).kind, "written");
  net.settle();
  const outcome = splitNativeRow(b, at);
  assert.equal(outcome.kind, "written");
  net.settle();
  assert.deepEqual(rowsOf(a), ["A: ab", `${(outcome as { created: string }).created}: ef`]);
  net.agree();
});

test("a split refuses a selection, a visual caret and a malformed caret, writing nothing", () => {
  const copy = one({ A: "abcdef" }), before = stateOf(copy);
  const selection = anchorNativeText(copy, { beat: "A", cell: "narration" }, 1, 3), visual = anchorNativeText(copy, { beat: "A", cell: "visual" }, 0);
  assert.ok(selection.kind === "anchored" && visual.kind === "anchored");
  for (const range of [selection.range, visual.range, { ...caret(copy, "A", 1), from: {} as Y.RelativePosition }, null as unknown as NativeTextRange]) {
    assert.deepEqual(splitNativeRow(copy, range), { kind: "refused", reason: "range" });
  }
  assert.deepEqual(stateOf(copy), before);
});

test("a split copies no rank from a rankless parent and refuses a rank another copy would read differently", () => {
  const copy = one({ A: "abc", B: "def" });
  copy.doc.transact(() => { copy.roots.beats.get("B")?.delete("rank"); });
  const created = split(copy, "B", 1);
  assert.deepEqual(copy.roots.beats.get(created)?.toJSON(), {});
  assert.deepEqual(rowsOf(copy), ["A: abc", "B: d", `${created}: ef`]);
  for (const rank of ["a\ud800", 7, { a: 1 }, null]) {
    copy.doc.transact(() => { copy.roots.beats.get("A")?.set("rank", rank); });
    const before = stateOf(copy);
    assert.deepEqual(splitNativeRow(copy, caret(copy, "A", 1)), { kind: "refused", reason: "stored" }, JSON.stringify(rank));
    assert.deepEqual(stateOf(copy), before);
  }
});

test("a split refuses a rank key that is present with an undefined value, as a peer receives it, writing nothing", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "def" }));
  assert.ok(a && b);
  a.doc.transact(() => { a.roots.beats.get("B")?.set("rank", undefined); });
  net.settle();
  const record = b.roots.beats.get("B");
  assert.deepEqual([record?.has("rank"), record?.get("rank")], [true, undefined]);
  const before = stateOf(b);
  assert.deepEqual(splitNativeRow(b, caret(b, "B", 1)), { kind: "refused", reason: "stored" });
  assert.deepEqual(stateOf(b), before);
});

test("a split refuses an empty target id as missing and a malformed one as a bad range, writing nothing", () => {
  const copy = one({ A: "abc" }), at = caret(copy, "A", 1), before = stateOf(copy);
  for (const [beat, reason] of [["", "missing"], ["\ud800", "range"]] as const) {
    assert.deepEqual(splitNativeRow(copy, { ...at, target: { beat, cell: "narration" } }), { kind: "refused", reason }, JSON.stringify(beat));
  }
  assert.deepEqual(stateOf(copy), before);
});

test("a split refuses an id already taken by a record, a visual cell or a stored boundary, writing nothing", () => {
  for (const root of ["beats", "visuals", "boundary"] as const) {
    const copy = one({ A: "abc" });
    const clock = Y.decodeStateVector(Y.encodeStateVector(copy.doc)).get(copy.doc.clientID) ?? 0, id = `r2-${(clock + 1).toString(36)}`;
    copy.doc.transact(() => {
      if (root === "beats") copy.roots.beats.set(id, new Y.Map());
      else if (root === "visuals") copy.roots.visuals.set(id, new Y.Text());
      else (copy.roots.segments.get("b:A")?.get("text") as Y.Text).insertEmbed(4, { b: id }, {});
    }, "remote");
    copy.reader.refresh();
    if (root === "boundary") assert.equal(storedOf(copy), `[A]abc[${id}]`);
    const before = stateOf(copy);
    assert.deepEqual(splitNativeRow(copy, caret(copy, "A", 1)), { kind: "refused", reason: "taken" }, root);
    assert.deepEqual(stateOf(copy), before);
  }
});

test("a split refuses an id held by a boundary in another ordered segment, an unordered segment or a segment head, parsing nothing more", () => {
  for (const place of ["ordered", "unordered", "head"] as const) {
    const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc" }));
    assert.ok(a && b);
    const id = `r2-${(Y.decodeStateVector(Y.encodeStateVector(a.doc)).get(a.doc.clientID) ?? 0).toString(36)}`;
    b.doc.transact(() => {
      const segment = new Y.Map<unknown>(), text = new Y.Text();
      b.roots.segments.set("x", segment);
      if (place === "head") segment.set("head", { b: id });
      segment.set("text", text);
      if (place !== "head") text.insertEmbed(0, { b: id }, {});
      if (place !== "unordered") b.roots.order.push(["x"]);
    }, b.origin);
    net.settle();
    a.reader.refresh();
    const parses = a.reader.counts().parses, before = stateOf(a);
    assert.deepEqual(splitNativeRow(a, caret(a, "A", 1)), { kind: "refused", reason: "taken" }, place);
    assert.equal(a.reader.counts().parses - parses, 0, place);
    assert.deepEqual(stateOf(a), before, place);
  }
});

test("join names the beat directly above as the reader reads it: the last member of the row above, never across a heading", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "a", B: "b", C: "c", D: "d", E: "e" }, {}, [{ id: "H", name: "Scene", before: "E" }]));
  assert.ok(a && b);
  join(a, "B", "A");
  const before = stateOf(a);
  assert.deepEqual(joinNativeRow(a, "C", "A", " "), { kind: "refused", reason: "above" });
  assert.deepEqual(stateOf(a), before);
  join(a, "C", "B");
  assert.deepEqual(a.reader.row("A")?.members, ["A", "B", "C"]);
  assert.deepEqual(joinNativeRow(a, "D", "B", " "), { kind: "refused", reason: "above" });
  join(a, "D", "C");
  const held = stateOf(a);
  assert.deepEqual([joinNativeRow(a, "E", "D", " "), joinNativeRow(a, "E", "A", " ")], [{ kind: "refused", reason: "above" }, { kind: "refused", reason: "above" }]);
  assert.deepEqual(stateOf(a), held);
  net.settle();
  assert.deepEqual(net.agree(), ["A: a b c d / ", "# Scene", "E: e / "]);
});

test("join after a peer removed the head, the middle or the tail of a row of three takes the beat now directly above", () => {
  for (const [victim, into, wrong, reason, reading] of [
    ["A", "C", "B", "above", ["B: b c d / "]], ["B", "C", "B", "missing", ["A: a / ", "C: c d / "]], ["C", "B", "C", "missing", ["A: a b d / "]]
  ] as const) {
    const { net, all: [a, b] } = copiesOf(structureScript({ A: "a", B: "b", C: "c", D: "d" }));
    assert.ok(a && b);
    join(a, "B", "A"); join(a, "C", "B"); net.settle();
    remove(b, victim); net.settle();
    const before = stateOf(a);
    assert.deepEqual(joinNativeRow(a, "D", wrong, " "), { kind: "refused", reason }, victim);
    assert.deepEqual(stateOf(a), before, victim);
    join(a, "D", into);
    net.settle();
    assert.deepEqual(net.agree().filter(line => !line.startsWith("problem")), reading, victim);
  }
});

test("the split boundary carries the formatting in force at its place, so the split writes no formatting change", () => {
  const copy = one({ A: "<strong>bold</strong>" });
  const created = split(copy, "A", 2);
  assert.deepEqual((copy.roots.segments.get("b:A")?.get("text") as Y.Text).toDelta(), [{ insert: "bo", attributes: { b: true } }, { insert: { b: created }, attributes: { b: true } }, { insert: "ld", attributes: { b: true } }]);
  assert.deepEqual([copy.reader.row("A")?.audioText, copy.reader.row(created)?.audioText], ["<strong>bo</strong>", "<strong>ld</strong>"]);
});

test("join writes the lower row's join to the row above, once, and every copy, a fresh reader and a late joiner read it the same", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "def" }));
  assert.ok(a && b);
  join(a, "B", "A", " ");
  assert.deepEqual(joinNativeRow(a, "B", "A", " "), { kind: "unchanged" });
  net.settle();
  assert.deepEqual(b.roots.beats.get("B")?.get("joined"), { into: "A", glue: " " });
  assert.deepEqual(net.agree(), ["A: abc def / "]);
  assert.deepEqual(b.reader.row("A")?.members, ["A", "B"]);
  join(b, "B", "A", "");
  net.settle();
  assert.deepEqual(net.agree(), ["A: abcdef / "]);
  unjoin(a, "B");
  assert.deepEqual(unjoinNativeRow(a, "B"), { kind: "unchanged" });
  net.settle();
  assert.equal(b.roots.beats.get("B")?.has("joined"), false);
  assert.deepEqual(net.agree(), ["A: abc / ", "B: def / "]);
});

test("an unjoin and a join made at once on two copies: the join stays, as Yjs keeps a set made beside a delete", () => {
  for (const clients of [[2, 3], [3, 2]]) {
    const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "def" }), clients);
    assert.ok(a && b);
    join(a, "B", "A", " ");
    net.settle();
    unjoin(a, "B"); join(b, "B", "A", "");
    net.settle();
    assert.deepEqual(a.roots.beats.get("B")?.get("joined"), { into: "A", glue: "" });
    net.agree();
  }
});

test("an unjoin and a rejoin with the same glue made at once: the rejoin is unchanged and writes nothing, so the unjoin wins", () => {
  for (const clients of [[2, 3], [3, 2]]) {
    const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "def" }), clients);
    assert.ok(a && b);
    join(a, "B", "A", " ");
    net.settle();
    const before = stateOf(b);
    unjoin(a, "B");
    assert.deepEqual(joinNativeRow(b, "B", "A", " "), { kind: "unchanged" });
    assert.deepEqual(stateOf(b), before);
    net.settle();
    assert.equal(a.roots.beats.get("B")?.has("joined"), false);
    assert.deepEqual(net.agree(), ["A: abc / ", "B: def / "]);
  }
});

test("join refuses, writing nothing, a row that is not directly below the one named, a heading between, a hidden row and bad glue", () => {
  const { all: [copy] } = copiesOf(structureScript({ A: "a", B: "b", C: "c", D: "d" }, {}, [{ id: "H", name: "Scene", before: "C" }]), [2]);
  assert.ok(copy);
  remove(copy, "D");
  const before = stateOf(copy);
  for (const [beat, into, glue, reason] of [
    ["B", "C", " ", "above"], ["A", "B", " ", "above"], ["C", "B", " ", "above"], ["B", "B", " ", "above"], ["D", "C", " ", "missing"], ["C", "D", " ", "missing"],
    ["Q", "A", " ", "missing"], ["B", "A", "​", "text"], ["B", "A", "\ud800", "text"], ["", "A", " ", "text"], ["B", 7, " ", "text"]
  ] as const) assert.deepEqual(joinNativeRow(copy, beat, into as string, glue), { kind: "refused", reason }, `${beat} into ${String(into)}`);
  assert.deepEqual(unjoinNativeRow(copy, "D"), { kind: "refused", reason: "missing" });
  assert.deepEqual(stateOf(copy), before);
});

test("removing a row deletes its narration and boundary and keeps its record and visual cell, which no reader lists", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "def", C: "ghi" }, { B: "two" }));
  assert.ok(a && b);
  const record = a.roots.beats.get("B"), visual = a.roots.visuals.get("B");
  remove(a, "B");
  assert.deepEqual(rowsOf(a), ["A: abc", "C: ghi"]);
  assert.equal(a.roots.beats.get("B"), record);
  assert.equal(a.roots.visuals.get("B"), visual);
  assert.equal(visual?.toString(), "two");
  net.settle();
  assert.deepEqual(net.agree(), ["A: abc / ", "C: ghi / "]);
  assert.equal(storedOf(b), "[A]abc[C]ghi");
  assert.deepEqual([b.reader.unplaced(), b.reader.problems()], [[], []]);
  assert.equal(b.roots.visuals.get("B")?.toString(), "two");
});

test("removing a segment's first row deletes its head key and its text; several rows go in one transaction", () => {
  const copy = one({ A: "abc", B: "def", C: "ghi" });
  let transactions = 0;
  copy.doc.on("afterTransaction", () => { transactions++; });
  remove(copy, "A", "C", "A");
  assert.equal(transactions, 1);
  assert.equal(copy.roots.segments.get("b:A")?.has("head"), false);
  assert.equal(storedOf(copy), "[B]def");
  assert.deepEqual(shown(copy), ["B: def / "]);
  assert.deepEqual(removeNativeRows(copy, []), { kind: "unchanged" });
});

test("removal refuses the whole command, writing nothing, when any row is missing or an id is malformed", () => {
  const copy = one({ A: "abc", B: "def" });
  remove(copy, "B");
  const before = stateOf(copy);
  for (const beats of [["A", "B"], ["A", "Q"], ["A", ""], ["A", "\ud800"], ["A", 3], "A", null]) {
    assert.deepEqual(removeNativeRows(copy, beats as string[]), { kind: "refused", reason: "missing" }, JSON.stringify(beats));
  }
  assert.deepEqual(stateOf(copy), before);
  assert.deepEqual(rowsOf(copy), ["A: abc"]);
});

test("every row command refuses inside another open transaction, and on a closed script, writing nothing", () => {
  const copy = one({ A: "abc", B: "def" }), at = caret(copy, "B", 1), outcomes: unknown[] = [], open = stateOf(copy);
  copy.doc.transact(() => {
    outcomes.push(splitNativeRow(copy, at), joinNativeRow(copy, "B", "A", " "), unjoinNativeRow(copy, "B"), removeNativeRows(copy, ["B"]));
  });
  assert.deepEqual(outcomes, Array(4).fill({ kind: "refused", reason: "busy" }));
  assert.deepEqual(stateOf(copy), open);
  assert.deepEqual([splitNativeRow(copy, at), joinNativeRow(copy, "B", "A", " ")].map(outcome => outcome.kind === "refused" ? outcome.reason : outcome.kind), ["written", "written"]);
  copy.reader.refresh();
  closeNativeScript(copy);
  const before = stateOf(copy);
  assert.deepEqual([splitNativeRow(copy, at), joinNativeRow(copy, "B", "A", " "), unjoinNativeRow(copy, "B"), removeNativeRows(copy, ["A"])], Array(4).fill({ kind: "refused", reason: "closed" }));
  assert.deepEqual(stateOf(copy), before);
});

test("removal reads the caller's list once: an id it throws on reading refuses before anything is written", () => {
  const copy = one({ A: "abc", B: "def" }), before = stateOf(copy);
  const list = ["B"];
  Object.defineProperty(list, 1, { get: () => { throw new Error("read"); }, enumerable: true });
  assert.deepEqual(removeNativeRows(copy, list), { kind: "refused", reason: "missing" });
  assert.deepEqual(stateOf(copy), before);
});

test("removal copies the caller's list by index: its own iterator never runs, so a row not in the list is never removed", () => {
  const copy = one({ A: "abc", B: "def" }), before = stateOf(copy);
  const ids = ["A", "Q"];
  ids[Symbol.iterator] = function* (): Generator<string> { yield "B"; };
  assert.deepEqual(removeNativeRows(copy, ids), { kind: "refused", reason: "missing" });
  assert.deepEqual(stateOf(copy), before);
  const alone = ["B"];
  alone[Symbol.iterator] = function* (): Generator<string> { yield "A"; };
  assert.deepEqual(removeNativeRows(copy, alone), { kind: "written" });
  copy.reader.refresh();
  assert.deepEqual(rowsOf(copy), ["A: abc"]);
});

test("a caller getter that closes the script makes the command refuse as closed, writing nothing, for removal and split", () => {
  const removal = one({ A: "abc", B: "def" }), list = ["B"], before = stateOf(removal);
  Object.defineProperty(list, 0, { get: () => { closeNativeScript(removal); return "A"; }, enumerable: true });
  assert.deepEqual(removeNativeRows(removal, list), { kind: "refused", reason: "closed" });
  assert.deepEqual(stateOf(removal), before);
  const splitting = one({ A: "abc" }), at = caret(splitting, "A", 1), held = stateOf(splitting);
  const range = { from: at.from, to: at.to, get target() { closeNativeScript(splitting); return at.target; } };
  assert.deepEqual(splitNativeRow(splitting, range), { kind: "refused", reason: "closed" });
  assert.deepEqual(stateOf(splitting), held);
});

test("a caller getter that runs its own removal: that removal is its own command, and the outer one judges the document as it now is", () => {
  for (const ending of ["throws", "returns"] as const) {
    const copy = one({ A: "abc", B: "def", C: "ghi" }), list = ending === "throws" ? ["A"] : ["C", "B"];
    let writes = 0, inner: ReturnType<typeof stateOf> | null = null;
    Object.defineProperty(list, 0, {
      get: () => {
        assert.equal(removeNativeRows(copy, ["C"]).kind, "written");
        inner = stateOf(copy);
        if (ending === "throws") throw new Error("read");
        return "C";
      },
      enumerable: true
    });
    copy.doc.on("update", () => { writes++; });
    assert.deepEqual(removeNativeRows(copy, list), { kind: "refused", reason: "missing" }, ending);
    copy.reader.refresh();
    assert.equal(writes, 1, ending);
    assert.ok(inner);
    assert.deepEqual(stateOf(copy), inner, ending);
    assert.deepEqual(rowsOf(copy), ["A: abc", "B: def"], ending);
    assert.equal(storedOf(copy), "[A]abc[B]def", ending);
  }
});
