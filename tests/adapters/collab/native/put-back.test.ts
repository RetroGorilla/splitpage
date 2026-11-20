import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { tagStack } from "../../../../src/core/text/runs.ts";
import { nativeMarkName } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativePutBackBeat } from "../../../../src/adapters/collab/native/insert-commands.ts";
import { readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import { declareNativeRoots } from "../../../../src/adapters/collab/native/roots.ts";
import type { NativeRoots } from "../../../../src/adapters/collab/native/roots.ts";
import { base } from "./notice-histories.ts";
import { noticeCopy, noticeDeliver, noticeRange, noticeSeed } from "./notice-harness.ts";
import { convertedScript } from "./helpers.ts";

const LAMP = "t:prop:lamp", ROPE = "t:prop:rope";
type Copy = ReturnType<typeof noticeCopy>;

function savedBeat(id = "B", scene: string | null = null, sceneOrder = ["A", "B", "C", "D"]): NativePutBackBeat {
  return {
    id, placement: { scene, left: null, right: null, sceneOrder },
    narration: [{ text: "go", marks: { b: true, tag: LAMP, innerTags: [ROPE] } },
      { text: " now", marks: { tag: LAMP } }, { text: " ", marks: {} },
      { text: "there", marks: { tag: LAMP } }, { atom: "broll", id: "shot", text: "B-roll: Cutaway", marks: { i: true } }],
    visual: [{ text: "frame", marks: { tag: LAMP } }, { atom: "who", name: "Crew", text: "@Crew", marks: {} }],
    fields: { status: "shot", lengthSeconds: 2, notes: { line: "keep" } }
  };
}

function putBack(copy: Copy, saved: NativePutBackBeat | null): string {
  const result = copy.commands.putBack(saved);
  assert.equal(result.kind, "written", JSON.stringify(result));
  return result.created;
}

function audio(copy: Copy, id: string): string | null | undefined {
  return copy.document().rows.find(row => row.id === id)?.audioText;
}

function rowIds(copy: Copy): string[] {
  return copy.document().rows.map(row => row.id);
}

function tagKeys(cell: Y.Text, tag: string): Set<string> {
  return new Set((cell.toDelta() as { attributes?: Record<string, unknown> }[]).flatMap(part =>
    Object.keys(part.attributes ?? {}).filter(key => nativeMarkName(key) === "t:" + tag)));
}

test("put-back restores both rich cells and content fields under fresh tag keys in one ordinary undo step", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3);
  try {
    const saved = savedBeat(), commands = writer.commands;
    assert.equal(commands.replaceText(noticeRange(writer, "B", "narration", 0, 3), saved.narration).kind, "written");
    assert.equal(commands.replaceText(noticeRange(writer, "B", "visual", 0, 1), saved.visual).kind, "written");
    for (const [field, value] of Object.entries(saved.fields)) {
      assert.equal(commands.setField({ kind: "beat", id: "B", field }, value).kind, "written");
    }
    const roots = declareNativeRoots(writer.ydoc), originalAudio = roots.segments.get("S")?.get("text"), originalVisual = roots.visuals.get("B");
    assert.ok(originalAudio instanceof Y.Text && originalVisual);
    const oldKeys = new Set([...tagKeys(originalAudio, LAMP), ...tagKeys(originalVisual, LAMP)]);
    assert.equal(oldKeys.size, 3);
    assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(cutter, writer);
    const [clash] = writer.offlineNotice("returning");
    assert.ok(clash?.mine);
    assert.notEqual(clash.mine.id, "");
    const id = putBack(writer, clash.mine);
    assert.notEqual(id, "B");
    assert.deepEqual(rowIds(writer).slice(0, 3), ["A", id, "C"]);
    const restored = readNativeOnce(roots, reader => reader.noticeBeat(id));
    assert.deepEqual(restored?.narration, clash.mine.narration);
    assert.deepEqual(restored?.visual, clash.mine.visual);
    assert.deepEqual(restored?.fields, saved.fields);
    assert.equal(restored?.joined, null);
    const newAudio = roots.segments.get("b:" + id)?.get("text"), newVisual = roots.visuals.get(id);
    assert.ok(newAudio instanceof Y.Text && newVisual);
    const newKeys = new Set([...tagKeys(newAudio, LAMP), ...tagKeys(newVisual, LAMP)]);
    assert.equal(newKeys.size, 3);
    assert.ok([...newKeys].every(key => !oldKeys.has(key)));
    noticeDeliver(writer, cutter);
    assert.deepEqual(cutter.document(), writer.document());
    assert.equal(commands.undo().kind, "written");
    assert.equal(roots.beats.has(id), false);
    assert.equal(roots.visuals.has(id), false);
    assert.equal(roots.segments.has("b:" + id), false);
    assert.equal(roots.order.toArray().includes("b:" + id), false);
    noticeDeliver(writer, cutter);
    assert.deepEqual(cutter.document(), writer.document());
    assert.deepEqual(rowIds(writer).slice(0, 2), ["A", "C"]);
    assert.equal(writer.offlineNotice("returning")[0]?.id, "B");
  } finally {
    writer.close();
    cutter.close();
  }
});

test("put-back keeps both the words recovered above and the words in the fresh beat", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "narration", 1), "Ω", {}).kind, "written");
    assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(cutter, writer);
    assert.equal(audio(writer, "A"), "abcΩ");
    const [clash] = writer.offlineNotice("returning");
    assert.ok(clash?.mine);
    const id = putBack(writer, clash.mine);
    assert.deepEqual([audio(writer, "A"), audio(writer, id)], ["abcΩ", "dΩef"]);
    assert.equal(writer.commands.undo().kind, "written");
    assert.deepEqual([audio(writer, "A"), audio(writer, id)], ["abcΩ", undefined]);
  } finally {
    writer.close();
    cutter.close();
  }
});

test("two put-backs of the same old beat converge as two fresh beats and local undo removes one", () => {
  const state = noticeSeed(base), first = noticeCopy(state, 2, true), second = noticeCopy(state, 3, true), cutter = noticeCopy(state, 4);
  try {
    assert.equal(first.commands.typeText(noticeRange(first, "B", "visual", 1), "Ω", {}).kind, "written");
    assert.equal(second.commands.typeText(noticeRange(second, "B", "visual", 1), "Ψ", {}).kind, "written");
    assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(cutter, first);
    noticeDeliver(cutter, second);
    const [one] = first.offlineNotice("returning"), [two] = second.offlineNotice("returning");
    assert.ok(one?.mine && two?.mine);
    const firstId = putBack(first, one.mine), secondId = putBack(second, two.mine);
    assert.notEqual(firstId, secondId);
    noticeDeliver(first, second);
    noticeDeliver(second, first);
    assert.deepEqual(first.document(), second.document());
    assert.deepEqual(new Set(first.document().rows.slice(1, 3).map(row => row.visualText)), new Set(["2Ω", "2Ψ"]));
    assert.equal(first.commands.undo().kind, "written");
    noticeDeliver(first, second);
    assert.deepEqual(first.document(), second.document());
    assert.deepEqual(rowIds(second).slice(0, 3), ["A", secondId, "C"]);
  } finally {
    first.close();
    second.close();
    cutter.close();
  }
});

test("a put-back stays pending and can itself be removed before confirmation", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3);
  try {
    const id = putBack(writer, savedBeat());
    noticeDeliver(writer, cutter);
    assert.equal(cutter.commands.removeRows([id]).kind, "written");
    noticeDeliver(cutter, writer);
    const [clash] = writer.offlineNotice("returning");
    assert.equal(clash?.id, id);
    assert.equal(clash?.possibleRemoval, true);
    assert.deepEqual(clash?.kinds, ["narration"]);
    assert.equal(clash?.mine?.fields.status, "shot");
  } finally {
    writer.close();
    cutter.close();
  }
});

test("put-back restores the journal's converted field at depth 65", () => {
  let nested: unknown = "leaf";
  for (let level = 0; level < 65; level++) nested = { child: nested };
  const source = convertedScript(migrateRows({
    title: "Deep field", rows: [{ id: "A", audioText: "abc", visualText: "" }, { id: "B", audioText: "def", visualText: "", nested }]
  }));
  const state = Y.encodeStateAsUpdate(source.doc), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "narration", 1), "Ω", {}).kind, "written");
    assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(cutter, writer);
    const [clash] = writer.offlineNotice("returning");
    assert.ok(clash?.mine);
    assert.deepEqual(clash.mine.fields.nested, nested);
    const id = putBack(writer, clash.mine);
    assert.deepEqual(writer.document().rows.find(row => row.id === id)?.nested, nested);
    assert.equal(audio(writer, id), "dΩef");
  } finally {
    source.doc.destroy();
    writer.close();
    cutter.close();
  }
});

test("put-back normalizes saved fields to the core's reload form before writing", () => {
  const copy = noticeCopy(noticeSeed(base), 2);
  try {
    const id = putBack(copy, { ...savedBeat(), narration: [{ text: "Words", marks: {} }], visual: [],
      fields: { status: "invalid-status", lengthSeconds: -4, paragraphStart: false, imageRef: "bad", notes: "keep" } });
    const roots = declareNativeRoots(copy.ydoc), record = roots.beats.get(id);
    assert.equal(record?.get("status"), '"todo"');
    assert.equal(record?.has("lengthSeconds"), false);
    assert.equal(record?.has("paragraphStart"), false);
    const before = copy.document().rows.find(row => row.id === id);
    assert.ok(before);
    assert.deepEqual(before, { id, status: "todo", imageRef: null, notes: "keep", audioText: "Words", visualText: "" });
    const reloaded = migrateRows(structuredClone(copy.document())).rows.find(row => row.id === id);
    assert.deepEqual(reloaded, { ...before, updatedAt: "", updatedBy: null });
  } finally { copy.close(); }
});

test("put-back after double delete and double undo adds a third copy of the narration", () => {
  const state = noticeSeed(base), first = noticeCopy(state, 2, true), second = noticeCopy(state, 3, true);
  try {
    for (const copy of [first, second]) {
      assert.equal(copy.commands.removeRows(["B"]).kind, "written");
      assert.equal(copy.commands.undo().kind, "written");
    }
    noticeDeliver(first, second);
    noticeDeliver(second, first);
    const [clash] = first.offlineNotice("returning");
    assert.deepEqual(clash?.kinds, ["double-undo"]);
    assert.ok(clash?.mine);
    const id = putBack(first, clash.mine);
    assert.deepEqual([audio(first, "B"), audio(first, id)], ["defdef", "def"]);
  } finally {
    first.close();
    second.close();
  }
});

test("put-back uses the saved scene, surviving neighbours, and the equal-rank group", () => {
  const state = noticeSeed(base);
  const cases = [
    { saved: savedBeat(), remove: ["A", "B"], expected: (id: string) => [id, "C", "D"] },
    { saved: savedBeat("B", null, ["A", "B", "C"]), remove: ["A", "B", "C"], expected: (id: string) => ["D", id, "E"] },
    { saved: savedBeat("E", "H", ["E"]), remove: ["E"], heading: "H", expected: (id: string) => ["A", "B", "C", "D", id, "F"] },
    { saved: savedBeat("old", "H", ["A", "old", "B"]), remove: ["E"], heading: "H",
      expected: (id: string) => ["A", "B", "C", "D", id, "F"] }
  ];
  for (const scenario of cases) {
    const copy = noticeCopy(state, 2);
    try {
      assert.equal(copy.commands.removeRows(scenario.remove).kind, "written");
      if (scenario.heading) assert.equal(copy.commands.removeHeading(scenario.heading).kind, "written");
      const id = putBack(copy, scenario.saved);
      const expected = scenario.expected(id);
      assert.deepEqual(rowIds(copy).slice(0, expected.length), expected);
    } finally { copy.close(); }
  }
  const tied = noticeCopy(state, 2);
  try {
    const split = tied.commands.splitRow(noticeRange(tied, "A", "narration", 1));
    assert.equal(split.kind, "written");
    assert.equal(tied.commands.removeRows(["B"]).kind, "written");
    const id = putBack(tied, savedBeat());
    assert.deepEqual(rowIds(tied).slice(0, 4), ["A", split.created, id, "C"]);
  } finally { tied.close(); }
});

test("put-back preserves joined neighbours and places around rankless or tied scene edges", () => {
  const state = noticeSeed(base), joined = noticeCopy(state, 2), sharedRank = noticeCopy(state, 3), rankless = noticeCopy(state, 4);
  try {
    assert.equal(joined.commands.joinRow("C", "B", " ").kind, "written");
    const left = putBack(joined, savedBeat("new-on-left", null, ["new-on-left", "C"]));
    const saved = savedBeat("new-on-right", null, ["B", "new-on-right", "D"]);
    const right = putBack(joined, { ...saved, fields: { ...saved.fields, rank: "z", joined: { into: "B", glue: " " } } });
    assert.deepEqual(rowIds(joined).slice(0, 5), ["A", left, "B", right, "D"]);
    assert.equal(audio(joined, "B"), "def ghi");
    const restored = readNativeOnce(declareNativeRoots(joined.ydoc), reader => reader.noticeBeat(right));
    assert.deepEqual(restored?.fields, saved.fields);

    assert.equal(sharedRank.commands.removeRows(["B", "C", "D"]).kind, "written");
    const roots = declareNativeRoots(sharedRank.ydoc);
    roots.headings.get("H")?.set("rank", roots.beats.get("A")?.get("rank"));
    const ahead = putBack(sharedRank, savedBeat("B", null, ["A", "B"]));
    assert.deepEqual(rowIds(sharedRank).slice(0, 3), [ahead, "A", "E"]);

    declareNativeRoots(rankless.ydoc).beats.get("A")?.delete("rank");
    const next = putBack(rankless, savedBeat("new", null, ["new", "A"]));
    assert.deepEqual(rowIds(rankless).slice(0, 3), ["A", next, "B"]);
  } finally {
    joined.close();
    sharedRank.close();
    rankless.close();
  }
});

test("put-back refuses invalid, unavailable and malformed-rank input before writing", async () => {
  const state = noticeSeed(base), copy = noticeCopy(state, 2, true), saved = savedBeat();
  try {
    const before = copy.encodeState(), journal = copy.pendingEdits?.data();
    const bad = [
      { ...saved, id: "", placement: { ...saved.placement, sceneOrder: [""] } },
      { ...saved, placement: { ...saved.placement, scene: "\ud800" } },
      { ...saved, placement: { ...saved.placement, sceneOrder: ["C"] } },
      { ...saved, placement: { ...saved.placement, sceneOrder: ["B", 3] } },
      { ...saved, placement: { ...saved.placement, sceneOrder: "B" } },
      { ...saved, visual: [{ text: "\u0000", marks: {} }] },
      { ...saved, narration: [{ text: "\u0000", marks: {} }] },
      { ...saved, fields: "status" },
      { ...saved, get fields() { throw new Error("unreadable"); } }
    ];
    for (const payload of bad) assert.deepEqual(copy.commands.putBack(payload as NativePutBackBeat), { kind: "refused", reason: "text" });
    assert.deepEqual(copy.commands.putBack(null), { kind: "refused", reason: "missing" });
    assert.deepEqual(copy.commands.putBack(savedBeat("r2-0", null, ["A", "r2-0"])), { kind: "refused", reason: "taken" });
    assert.deepEqual(copy.ydoc.transact(() => copy.commands.putBack(saved)), { kind: "refused", reason: "busy" });
    assert.deepEqual(copy.encodeState(), before);
    assert.deepEqual(copy.pendingEdits?.data(), journal);
    const roots = declareNativeRoots(copy.ydoc);
    roots.beats.get("A")?.set("rank", "!");
    const malformed = copy.encodeState();
    assert.deepEqual(copy.commands.putBack(saved), { kind: "refused", reason: "stored" });
    assert.deepEqual(copy.encodeState(), malformed);
    copy.close();
    assert.deepEqual(copy.commands.putBack(saved), { kind: "refused", reason: "closed" });
    await Promise.resolve();
    assert.deepEqual(copy.encodeState(), malformed);
  } finally { copy.close(); }
});

test("put-back refuses a fresh-id collision in each stored part before writing", () => {
  const state = noticeSeed(base), id = "r2-0", key = "b:" + id;
  const occupied: readonly ((roots: NativeRoots) => void)[] = [
    roots => { roots.beats.set(id, new Y.Map()); },
    roots => { roots.visuals.set(id, new Y.Text()); },
    roots => { roots.segments.set(key, new Y.Map()); },
    roots => { roots.order.push([key]); },
    roots => {
      const cell = roots.segments.get("S")?.get("text");
      assert.ok(cell instanceof Y.Text);
      cell.insertEmbed(cell.length, { b: id });
    }
  ];
  for (const occupy of occupied) {
    const seeded = noticeCopy(state, 20);
    occupy(declareNativeRoots(seeded.ydoc));
    const copy = noticeCopy(seeded.encodeState(), 2, true);
    try {
      const before = copy.encodeState();
      assert.deepEqual(copy.commands.putBack(savedBeat()), { kind: "refused", reason: "taken" });
      assert.deepEqual(copy.encodeState(), before);
      assert.deepEqual(copy.pendingEdits?.data(), { through: 0, entries: [] });
    } finally {
      copy.close();
      seeded.close();
    }
  }
});

test("a literal put-back witness catches each omitted shared write at that command", t => {
  const state = noticeSeed(base), saved = savedBeat();
  const { set } = Y.Map.prototype, { push } = Y.Array.prototype, { insert, insertEmbed, format } = Y.Text.prototype;

  function run(mute: number) {
    const copy = noticeCopy(state, 2), calls: string[] = [];
    const record = (step: string) => calls.push(step) - 1 !== mute;
    const setters = [
      t.mock.method(Y.Map.prototype, "set", function (this: Y.Map<unknown>, key: string, value: unknown): unknown {
        if (record("set " + key)) return set.call(this, key, value);
        return undefined;
      }),
      t.mock.method(Y.Array.prototype, "push", function (this: Y.Array<unknown>, values: unknown[]) {
        if (record("order")) push.call(this, values);
      }),
      t.mock.method(Y.Text.prototype, "insert", function (this: Y.Text, at: number, value: string, attributes?: Record<string, unknown>) {
        if (record("text " + value)) insert.call(this, at, value, attributes);
      }),
      t.mock.method(Y.Text.prototype, "insertEmbed", function (this: Y.Text, at: number, embed: Record<string, unknown>, attributes?: Record<string, unknown>) {
        if (record("embed")) insertEmbed.call(this, at, embed, attributes);
      }),
      t.mock.method(Y.Text.prototype, "format", function (this: Y.Text, at: number, length: number, attributes: Record<string, unknown>) {
        if (record("format")) format.call(this, at, length, attributes);
      })
    ];
    try {
      const id = putBack(copy, saved), roots = declareNativeRoots(copy.ydoc), key = "b:" + id;
      const segment = roots.segments.get(key), beat = roots.beats.get(id);
      const shown = readNativeOnce(roots, reader => reader.noticeBeat(id));
      const runs = (cell: NonNullable<typeof shown>["narration"] | undefined) =>
        cell?.map(run => [run.text, run.atom ?? null, tagStack(run.marks), run.marks.b ?? false, run.marks.i ?? false]);
      return { calls, observed: {
        ordered: roots.order.toArray().includes(key), head: segment?.get("head"),
        narrationCell: segment?.get("text") instanceof Y.Text, visualCell: roots.visuals.get(id) instanceof Y.Text,
        rank: typeof beat?.get("rank") === "string", status: beat?.get("status"), length: beat?.get("lengthSeconds"), notes: beat?.get('f:"notes"'),
        narration: runs(shown?.narration), visual: runs(shown?.visual)
      } };
    } finally {
      for (const setter of setters) setter.mock.restore();
      copy.close();
    }
  }

  const clean = run(-1);
  assert.deepEqual(clean.observed, {
    ordered: true, head: { b: "r2-0" }, narrationCell: true, visualCell: true,
    rank: true, status: '"shot"', length: "2", notes: '{"line":"keep"}',
    narration: [["go", null, [LAMP, ROPE], true, false], [" now", null, [LAMP], false, false],
      [" ", null, [], false, false], ["there", null, [LAMP], false, false], ["B-roll: Cutaway", "broll", [], false, true]],
    visual: [["frame", null, [LAMP], false, false], ["@Crew", "who", [], false, false]]
  });
  assert.deepEqual(clean.calls, [
    "set b:r2-0", "set head", "set text", "text go", "format", "text  now", "text  ", "text there", "embed",
    "order", "set r2-0", "set rank", "set status", "set lengthSeconds", 'set f:"notes"', "set r2-0", "text frame", "embed"
  ]);
  for (const [index, call] of clean.calls.entries()) {
    const muted = run(index);
    assert.deepEqual(muted.calls, clean.calls, call);
    assert.notDeepEqual(muted.observed, clean.observed, call);
  }
});
