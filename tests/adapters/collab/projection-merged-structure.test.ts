import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { replicas, agree, execute, ref } from "./executor-support.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { literalMergedDocument, mergedProjectionSave, readPureMergedProjection } from "./projection-merged-support.ts";
import { joinWithPrevious, startsParagraph } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";

function join(handle: SharedDocumentHandle, from: string, into: string, id: string, glue = " "): void {
  transactSharedDocument(handle, "local-command", () => {
    const beat = collabState(handle).roots.beats.get(from); assert.ok(beat instanceof Y.Map);
    const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map);
    joins.set(id, { into, glue });
  });
}

test("seeded merged structure: raw joins, cycles, moves, removal, retirement, scalars and status with no declared limits", t => {
  const declaredLimits: readonly string[] = [], covered = new Set<string>(), coveredVariants = new Set<string>();
  const variants = [
    { order: ["R3", "R4", "R1", "R2", "R5"], removed: "R5", root: "R3", rows: [row("R3", "c d a b", { status: "ready" })],
      recovery: [{ kind: "removed-beat", row: row("R5", "e"), members: ["R5"] }] },
    { order: ["R2", "R4", "R1", "R3", "R5"], removed: "R5", root: "R2", rows: [row("R2", "b d a c", { status: "ready" })],
      recovery: [{ kind: "removed-beat", row: row("R5", "e"), members: ["R5"] }] },
    { order: ["R3", "R4", "R1", "R2", "R5"], removed: "R1", root: "R3", rows: [row("R3", "c b"), row("R5", "e")],
      recovery: [{ kind: "removed-beat", row: row("R1", "a d", { status: "ready" }), members: ["R1", "R4"] }] },
    { order: ["R2", "R4", "R1", "R3", "R5"], removed: "R1", root: "R2", rows: [row("R2", "b c"), row("R5", "e")],
      recovery: [{ kind: "removed-beat", row: row("R1", "a d", { status: "ready" }), members: ["R1", "R4"] }] }
  ];
  let random = 0x6b577, checkpoints = 0, actionsCount = 0;
  for (let seed = 0; seed < 24; seed++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const variant = variants[(random >>> 16) % variants.length]; assert.ok(variant); coveredVariants.add(variant.root + variant.removed);
    const run = replicas(copies, { rows: [row("R1", "a"), row("R2", "b"), row("R3", "c"), row("R4", "d"), row("R5", "e")],
      sections: [{ id: "H0", name: "Clear", firstSceneId: "R5" }] });
    const handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
    const actions = [
      { kind: "move", apply: (handle: SharedDocumentHandle) => {
        move(handle, variant.order); transactSharedDocument(handle, "local-command", () => collabState(handle).roots.order.push(["h:H0"]));
      } },
      { kind: "heading-clear", apply: (handle: SharedDocumentHandle) => transactSharedDocument(handle, "local-command", () => {
        const segment = collabState(handle).roots.segments.get("h:H0"); assert.ok(segment instanceof Y.Map);
        const text = segment.get("text"); assert.ok(text instanceof Y.Text); text.delete(0, text.length);
      }) },
      ...[["R1", "R2"], ["R2", "R3"], ["R3", "R1"], ["R4", "R1"]].map(([from, into], index) => ({ kind: "join",
        apply: (handle: SharedDocumentHandle) => { assert.ok(from && into); join(handle, from, into, "cycle" + index); } })),
      { kind: "remove", apply: (handle: SharedDocumentHandle) => remove(handle, variant.removed) },
      { kind: "retirement", apply: (handle: SharedDocumentHandle) => {
        join(handle, "R4", "R5", "retired"); transactSharedDocument(handle, "local-command", () => collabState(handle).roots.retiredJoins.set("retired", true));
      } },
      { kind: "scalar", apply: (handle: SharedDocumentHandle) => execute(handle, { kind: "scalar", id: "scalar", by: "writer", target: { scope: "beat", record: "R4" }, field: "lengthSeconds", value: 30 }) },
      { kind: "scalar", apply: (handle: SharedDocumentHandle) => execute(handle, { kind: "scalar", id: "flag", by: "writer", target: { scope: "beat", record: "R4" }, field: "paragraphStart", value: true }) },
      { kind: "status", apply: (handle: SharedDocumentHandle) => execute(handle, { kind: "status", id: "status", by: "writer", target: { scope: "beat", record: "R4" }, value: "ready", parents: [] }) },
      { kind: "malformed", apply: (handle: SharedDocumentHandle) => transactSharedDocument(handle, "local-command", () => {
        const beat = collabState(handle).roots.beats.get("R1"); assert.ok(beat instanceof Y.Map);
        const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map);
        for (const [index, value] of [null, true, 1, [], { into: "R2", glue: 2 }, { into: "", glue: " " }].entries()) joins.set("bad" + index, value);
      }) }
    ];
    try {
      for (let index = actions.length - 1; index > 0; index--) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const other = random % (index + 1), first = actions[index], second = actions[other]; assert.ok(first && second);
        actions[index] = second; actions[other] = first;
      }
      actions.forEach((action, index) => { const handle = handles[(seed + index) % copies]; assert.ok(handle); action.apply(handle); covered.add(action.kind); actionsCount++; });
      run.queue.flush(order);
      const document = { ...literalMergedDocument(""), rows: variant.rows };
      const expected = { document, recovery: variant.recovery };
      for (const handle of handles) {
        const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, expected, "unmatched violation at seed " + seed);
        assert.equal(actual.save, mergedProjectionSave(document));
      }
      agree("seeded structure " + seed, order, handles, readPureMergedProjection); checkpoints++;
    } finally { run.close(); }
  }
  assert.deepEqual([...covered].sort(), ["heading-clear", "join", "malformed", "move", "remove", "retirement", "scalar", "status"]);
  assert.deepEqual([...coveredVariants].sort(), ["R2R1", "R2R5", "R3R1", "R3R5"]);
  assert.deepEqual(declaredLimits, []); assert.equal(actionsCount, 1728); assert.equal(checkpoints, 144);
  t.diagnostic(JSON.stringify({ seeds: 24, actions: actionsCount, checkpoints, declaredLimits }));
});
function remove(handle: SharedDocumentHandle, id: string): void {
  transactSharedDocument(handle, "local-command", () => {
    const beat = collabState(handle).roots.beats.get(id); assert.ok(beat instanceof Y.Map);
    const removals = beat.get("removals"); assert.ok(removals instanceof Y.Map); removals.set("remove", true);
  });
}
function move(handle: SharedDocumentHandle, ids: readonly string[]): void {
  transactSharedDocument(handle, "local-command", () => {
    const order = collabState(handle).roots.order; order.delete(0, order.length); order.insert(0, ids.map(id => "b:" + id));
  });
}
function row(id: string, audioText: string, extra: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  return { id, status: "todo", visualText: "", audioText, imageRef: null, updatedAt: "", updatedBy: null, ...extra };
}
const cycles = [
  { name: "two beats", rows: ["R1", "R2"], order: ["R2", "R1"], edges: [["R1", "R2"], ["R2", "R1"]], root: "R2", text: "b a", visual: "R2<br>R1", length: 12, by: "P2" },
  { name: "three beats", rows: ["R1", "R2", "R3"], order: ["R3", "R1", "R2"], edges: [["R1", "R2"], ["R2", "R3"], ["R3", "R1"]], root: "R3", text: "c a b", visual: "R3<br>R1<br>R2", length: 13, by: "P3" },
  { name: "cycle with an incoming fourth beat", rows: ["R1", "R2", "R3", "R4"], order: ["R3", "R4", "R1", "R2"],
    edges: [["R1", "R2"], ["R2", "R3"], ["R3", "R1"], ["R4", "R1"]], root: "R3", text: "c d a b", visual: "R3<br>R4<br>R1<br>R2", length: 13, by: "P3" },
  { name: "incoming beat precedes every cycle member", rows: ["R1", "R2", "R3", "R4"], order: ["R4", "R3", "R1", "R2"],
    edges: [["R1", "R2"], ["R2", "R3"], ["R3", "R1"], ["R4", "R1"]], root: "R3", text: "c d a b", visual: "R3<br>R4<br>R1<br>R2", length: 13, by: "P3" }
] as const;

const flowRuntime = createFlowLoadRuntime();

for (const copies of [2, 3]) for (const order of deliveryOrders) test(`native split boundary cuts one stored tag occurrence per beat: ${copies} copies ${order}`, () => {
  const box = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">';
  const run = replicas(copies, { rows: [row("R1", box + "abcd</span>"), row("R2", "")], productionTags: [{ id: "t_box", cat: "prop", name: "Box" }] });
  const handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
  try {
    transactSharedDocument(run.a, "local-command", () => {
      const roots = collabState(run.a).roots, segment = roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
      const text = segment.get("text"); assert.ok(text instanceof Y.Text); text.insertEmbed(2, { b: "R2" }); roots.order.delete(1, 1);
      const beat = roots.beats.get("R2"); assert.ok(beat instanceof Y.Map); beat.set("segment", "b:R1");
    });
    run.queue.flush(order);
    const address = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    // why: This reader fixture imports a mark on an invisible boundary; native editing now requires a projected range.
    transactSharedDocument(run.b, "hydration", () => {
      const mark = prepareSharedMarkRecord(run.b, address, "boundary-mark", 2, 3, { type: "add", mark: { kind: "comment", id: ref("boundary"), value: "C1" } });
      assert.ok(mark); assert.deepEqual(writeSharedMarkRecord(run.b, address, "boundary-mark", mark), { ok: true });
    }); run.queue.flush(order);
    const document = { ...literalMergedDocument(""), rows: [row("R1", box + "ab</span>"), row("R2", box + "cd</span>")],
      productionTags: [{ id: "t_box", cat: "prop", name: "Box", owner: "", notes: "", status: "needed" }] };
    for (const handle of handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree("native boundary tag parts", order, handles, readPureMergedProjection);
  } finally { run.close(); }
});

for (const copies of [2, 3]) for (const order of deliveryOrders) test(`native heading without a following beat is recovered: ${copies} copies ${order}`, () => {
  const run = replicas(copies, { rows: [row("R1", "a")], sections: [{ id: "H1", name: "Heading", firstSceneId: "R1" }] });
  const handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
  try {
    transactSharedDocument(run.b, "local-command", () => {
      const roots = collabState(run.b).roots, segment = roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
      const text = segment.get("text"); assert.ok(text instanceof Y.Text); text.insertEmbed(1, { h: "H1" }); text.insert(2, "Heading"); roots.order.delete(0, 1);
    });
    run.queue.flush(order);
    const document = literalMergedDocument("a"), recovery = [{ kind: "scene-with-no-beats", heading: { id: "H1", name: "Heading" }, beforeRowId: null }];
    for (const handle of handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery }); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree("native empty scene", order, handles, readPureMergedProjection);
  } finally { run.close(); }
});

const removedCycles = [
  { name: "Carol removes R1 in order R2 R1", ids: ["R1", "R2"], order: ["R2", "R1"], edges: [["R1", "R2"], ["R2", "R1"]], removed: ["R1"],
    rows: [row("R2", "b")], recovery: [{ kind: "removed-beat", row: row("R1", "a"), members: ["R1"] }], restored: [row("R2", "b a")] },
  { name: "removed first member cannot be the live root", ids: ["R1", "R2"], order: ["R1", "R2"], edges: [["R1", "R2"], ["R2", "R1"]], removed: ["R1"],
    rows: [row("R2", "b")], recovery: [{ kind: "removed-beat", row: row("R1", "a"), members: ["R1"] }], restored: [row("R1", "a b")] },
  { name: "both cycle members removed", ids: ["R1", "R2"], order: ["R2", "R1"], edges: [["R1", "R2"], ["R2", "R1"]], removed: ["R1", "R2"],
    rows: [], recovery: [{ kind: "removed-beat", row: row("R2", "b a"), members: ["R2", "R1"] }], restored: [row("R2", "b a")] },
  { name: "middle of a three-beat cycle removed", ids: ["R1", "R2", "R3"], order: ["R1", "R2", "R3"], edges: [["R1", "R2"], ["R2", "R3"], ["R3", "R1"]], removed: ["R2"],
    rows: [row("R1", "a c")], recovery: [{ kind: "removed-beat", row: row("R2", "b"), members: ["R2"] }], restored: [row("R1", "a b c")] },
  { name: "outside beat joined into removed member", ids: ["R1", "R2", "R4"], order: ["R2", "R4", "R1"], edges: [["R1", "R2"], ["R2", "R1"], ["R4", "R1"]], removed: ["R1"],
    rows: [row("R2", "b")], recovery: [{ kind: "removed-beat", row: row("R1", "a d"), members: ["R1", "R4"] }], restored: [row("R2", "b d a")] },
  { name: "outside beat joined into removed middle", ids: ["R1", "R2", "R3", "R4"], order: ["R3", "R2", "R4", "R1"], edges: [["R1", "R2"], ["R2", "R3"], ["R3", "R1"], ["R4", "R2"]], removed: ["R2"],
    rows: [row("R3", "c a")], recovery: [{ kind: "removed-beat", row: row("R2", "b d"), members: ["R2", "R4"] }], restored: [row("R3", "c b d a")] }
] as const;
for (const scenario of removedCycles) for (const copies of [2, 3]) for (const order of deliveryOrders)
  test(`cycle removal constructed directly: ${scenario.name}, ${copies} copies ${order}`, () => {
    const run = replicas(copies, { rows: scenario.ids.map(id => row(id, id === "R1" ? "a" : id === "R2" ? "b" : id === "R3" ? "c" : "d")) });
    const handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])], carol = copies === 3 ? run.c : run.a;
    try {
      move(run.b, scenario.order);
      scenario.edges.forEach(([from, into], index) => { const handle = handles[index % 2]; assert.ok(handle); join(handle, from, into, "j" + index); });
      for (const id of scenario.removed) remove(carol, id);
      run.queue.flush(order);
      const document = { ...literalMergedDocument(""), rows: [...scenario.rows] };
      for (const handle of handles) {
        const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: scenario.recovery });
        assert.equal(actual.save, mergedProjectionSave(document));
      }
      agree("cycle removal " + scenario.name, order, handles, readPureMergedProjection);
      transactSharedDocument(carol, "local-command", () => {
        for (const id of scenario.removed) {
          const beat = collabState(carol).roots.beats.get(id); assert.ok(beat instanceof Y.Map);
          const removals = beat.get("removals"); assert.ok(removals instanceof Y.Map); removals.delete("remove");
        }
      });
      run.queue.flush(order);
      for (const handle of handles) {
        const actual = readPureMergedProjection(handle);
        const restored = { ...literalMergedDocument(""), rows: [...scenario.restored] };
        assert.deepEqual(actual.view, { document: restored, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(restored));
      }
      agree("removal flag cleared " + scenario.name, order, handles, readPureMergedProjection);
    } finally { run.close(); }
  });
const linked = '<a href="https://example.test/" target="_blank" rel="noopener">';
const comment = '<span class="cmt-anchor" data-cmt="C1">';
for (const example of [
  { name: "common links", a: linked + "a</a>", b: linked + "b</a>", expected: linked + "a b</a>" },
  { name: "common comments", a: comment + "a</span>", b: comment + "b</span>", expected: comment + "a b</span>" },
  { name: "bold stops at the boundary", a: "<strong>a</strong>", b: "<strong>b</strong>", expected: "<strong>a</strong> <strong>b</strong>" },
  { name: "directions include glue", a: '<span class="stage-dir">a</span>', b: '<span class="stage-dir">b</span>', expected: '<span class="stage-dir">a b</span>' }
]) for (const copies of [2, 3]) for (const order of deliveryOrders) test(`live join glue matches standalone: ${example.name}, ${copies} copies ${order}`, () => {
  const first = row("R1", example.a, { visualText: "<strong>first</strong>" }), second = row("R2", example.b, { visualText: "<em>second</em>" });
  const run = replicas(copies, { rows: [first, second] }), handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
  try {
    join(run.b, "R2", "R1", "join"); run.queue.flush(order);
    const standalone = joinWithPrevious({ rows: [first, second], comments: [] }, "R2", flowRuntime.ports);
    assert.ok(standalone && "rows" in standalone);
    assert.equal(standalone.rows[0]?.audioText, example.expected); assert.equal(standalone.rows[0]?.visualText, "<strong>first</strong><br><em>second</em>");
    const document = { ...literalMergedDocument(""), rows: [row("R1", example.expected, { visualText: "<strong>first</strong><br><em>second</em>" })] };
    for (const handle of handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] });
      assert.equal(actual.view.document.rows?.[0]?.audioText, standalone.rows[0]?.audioText); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree(example.name, order, handles, readPureMergedProjection);
  } finally { run.close(); }
});

test("seeded arbitrary join, retirement and removal shapes terminate and conserve both texts after reload", t => {
  const values: unknown[] = [null, undefined, false, 0, "bad", {}, [], new Array(2), { into: "R1", glue: " " },
    { into: "missing", glue: "" }, { into: "R2", glue: " " }, { into: "bad\ud800", glue: " " }, { into: "R1", glue: true }];
  let seed = 0x6b104, checkpoints = 0;
  for (const order of ["D1", "rev", "dup"] as const) {
    const run = replicas(3, { rows: [row("R1", "a"), row("R2", "b")] });
    const handles = [run.a, run.b, run.c];
    try {
      for (let index = 0; index < 40; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const handle = handles[index % 3]; assert.ok(handle);
        transactSharedDocument(handle, "local-command", () => {
          const roots = collabState(handle).roots, beat = roots.beats.get(index % 2 ? "R1" : "R2"); assert.ok(beat instanceof Y.Map);
          const joins = new Y.Map<unknown>(), removals = new Y.Map<unknown>(); beat.set("joins", joins); beat.set("removals", removals);
          for (const id of ["a", "z", "bad\ud800"]) joins.set(id, values[(seed >>> (id === "a" ? 0 : 8)) % values.length]);
          removals.set("remove", index % 7 === 0 ? true : values[(seed >>> 16) % values.length]);
          roots.retiredJoins.set("a", values[(seed >>> 24) % values.length]);
        });
        run.queue.flush(order);
        for (const copy of handles) {
          const actual = readPureMergedProjection(copy).view;
          const rows = [...actual.document.rows, ...actual.recovery.flatMap(entry => entry.kind === "removed-beat" ? [entry.row] : [])];
          assert.equal(rows.map(row => String(row.audioText)).join("").replaceAll(" ", "").split("").sort().join(""), "ab");
        }
        agree("arbitrary structure " + index, order, handles, readPureMergedProjection); checkpoints++;
      }
    } finally { run.close(); }
  }
  assert.equal(checkpoints, 120); t.diagnostic(JSON.stringify({ checkpoints, declaredLimits: [] }));
});

for (const scenario of cycles) for (const copies of [2, 3]) for (const mirrored of [false, true]) for (const order of deliveryOrders)
  test(`join cycle constructed directly: ${scenario.name}, ${copies} copies, mirrored=${mirrored}, ${order}`, () => {
    const source = scenario.rows.map((id, index) => ({ id, audioText: String.fromCharCode(97 + index), visualText: id,
      lengthSeconds: index + 11, updatedAt: "stamp" + id, updatedBy: "P" + (index + 1), paragraphStart: true, futureField: id }));
    const run = replicas(copies, { rows: source }), handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
    try {
      move(mirrored ? run.a : run.b, scenario.order);
      scenario.edges.forEach(([from, into], index) => {
        const handle = handles[(index + (mirrored ? 1 : 0)) % copies]; assert.ok(handle);
        join(handle, from, into, "j" + index);
      });
      run.queue.flush(order);
      const document = { ...literalMergedDocument(""), rows: [row(scenario.root, scenario.text, { visualText: scenario.visual,
        updatedAt: "stamp" + scenario.root, updatedBy: scenario.by, futureField: scenario.root, lengthSeconds: scenario.length, paragraphStart: true })] };
      for (const handle of handles) {
        const actual = readPureMergedProjection(handle);
        assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
        for (const [from] of scenario.edges) {
          const beat = collabState(handle).roots.beats.get(from); assert.ok(beat instanceof Y.Map);
          const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map); assert.equal(joins.size, 1);
        }
      }
      agree(scenario.name, order, handles, readPureMergedProjection);
    } finally { run.close(); }
  });

for (const copies of [2, 3]) for (const order of deliveryOrders) test(`join roots keep entered fields and use highest status: ${copies} copies ${order}`, () => {
  const first = row("R1", "a", { lengthSeconds: 12, paragraphStart: true, updatedAt: "root", updatedBy: "P1", futureField: { z: 2, a: 1 } });
  const second = row("R2", "b", { lengthSeconds: 20, paragraphStart: true, updatedAt: "child", updatedBy: "P2", futureField: "child", status: "shot" });
  const run = replicas(copies, { rows: [first, second] }), handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
  try {
    join(run.a, "R2", "R1", "join");
    execute(run.b, { kind: "scalar", id: "duration", by: "P2", target: { scope: "beat", record: "R2" }, field: "lengthSeconds", value: 30 });
    run.queue.flush(order);
    const document = { ...literalMergedDocument(""), rows: [row("R1", "a b", { futureField: { a: 1, z: 2 }, lengthSeconds: 12, paragraphStart: true,
      updatedAt: "root", updatedBy: "P1", status: "shot" })] };
    const standalone = joinWithPrevious({ rows: [first, { ...second, lengthSeconds: 30 }], comments: [] }, "R2", {
      cells: text => [{ text: text ?? "", marks: {} }], newId: () => "unused", hasVisual: () => false
    });
    assert.ok(standalone && "rows" in standalone); const joined = standalone.rows[0]; assert.ok(joined);
    for (const handle of handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] });
      for (const field of ["id", "lengthSeconds", "updatedAt", "updatedBy", "futureField", "paragraphStart", "status"])
        assert.deepEqual(actual.view.document.rows?.[0]?.[field], joined[field], field);
      assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree("root fields", order, handles, readPureMergedProjection);
    transactSharedDocument(run.a, "local-command", () => collabState(run.a).roots.retiredJoins.set("join", true)); run.queue.flush(order);
    for (const handle of handles) assert.deepEqual(readPureMergedProjection(handle).view.document.rows,
      [first, { ...second, lengthSeconds: 30 }]);
    agree("stored child fields survive join retirement", order, handles, readPureMergedProjection);
  } finally { run.close(); }
});

const cases = [
  { name: "smallest join id wins and chains reach their root", source: { rows: [row("R1", "a"), row("R2", "b"), row("R3", "c")] },
    change: (a: SharedDocumentHandle, b: SharedDocumentHandle) => { move(b, ["R1", "R3", "R2"]); join(a, "R3", "R1", "z"); join(b, "R3", "R2", "a"); join(a, "R2", "R1", "chain"); },
    rows: [row("R1", "a b c")], recovery: [] },
  { name: "removed join target recovers the entire group", source: { rows: [row("R1", "a"), row("R2", "b")] },
    change: (a: SharedDocumentHandle, b: SharedDocumentHandle) => { join(a, "R2", "R1", "join"); remove(b, "R1"); }, rows: [],
    recovery: [{ kind: "removed-beat", row: row("R1", "a b"), members: ["R1", "R2"] }] },
  { name: "removed joining beat recovers separately", source: { rows: [row("R1", "a"), row("R2", "b", { paragraphStart: true })] },
    change: (a: SharedDocumentHandle, b: SharedDocumentHandle) => { join(a, "R2", "R1", "join"); remove(b, "R2"); }, rows: [row("R1", "a")],
    recovery: [{ kind: "removed-beat", row: row("R2", "b", { paragraphStart: true }), members: ["R2"] }] },
  { name: "empty script has no invented beat", source: { rows: [row("R1", "a")] },
    change: (a: SharedDocumentHandle) => remove(a, "R1"), rows: [], recovery: [{ kind: "removed-beat", row: row("R1", "a"), members: ["R1"] }] },
  { name: "scene without beats remains in recovery", source: { rows: [row("R1", "a"), row("R2", "b")],
    sections: [{ id: "H1", name: "First", firstSceneId: "R1" }, { id: "H2", name: "Second", firstSceneId: "R2" }] },
    change: (a: SharedDocumentHandle, b: SharedDocumentHandle) => {
      remove(a, "R1"); transactSharedDocument(b, "local-command", () => {
        const segment = collabState(b).roots.segments.get("h:H1"); assert.ok(segment instanceof Y.Map);
        const text = segment.get("text"); assert.ok(text instanceof Y.Text); text.insert(text.length, "!");
      });
    }, rows: [row("R2", "b")], sections: [{ id: "H2", name: "Second", firstSceneId: "R2" }],
    recovery: [{ kind: "removed-beat", row: row("R1", "a"), members: ["R1"] }, { kind: "scene-with-no-beats", heading: { id: "H1", name: "First!" }, beforeRowId: "R2" }] },
  { name: "empty script keeps its heading in recovery", source: { rows: [row("R1", "a")], sections: [{ id: "H1", name: "First", firstSceneId: "R1" }] },
    change: (a: SharedDocumentHandle) => remove(a, "R1"), rows: [], recovery: [{ kind: "removed-beat", row: row("R1", "a"), members: ["R1"] },
      { kind: "scene-with-no-beats", heading: { id: "H1", name: "First" }, beforeRowId: null }] },
  { name: "cleared heading creates no scene", source: { rows: [row("R1", "a", { paragraphStart: true })], sections: [{ id: "H1", name: "First", firstSceneId: "R1" }] },
    change: (a: SharedDocumentHandle) => transactSharedDocument(a, "local-command", () => {
      const segment = collabState(a).roots.segments.get("h:H1"); assert.ok(segment instanceof Y.Map);
      const text = segment.get("text"); assert.ok(text instanceof Y.Text); text.delete(0, text.length);
    }), rows: [row("R1", "a", { paragraphStart: true })], recovery: [] }
];
for (const scenario of cases) for (const copies of [2, 3]) for (const order of deliveryOrders)
  test(`merged structure constructed directly: ${scenario.name}, ${copies} copies ${order}`, () => {
    const run = replicas(copies, scenario.source), handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
    try {
      scenario.change(run.a, run.b); run.queue.flush(order);
      const document = { ...literalMergedDocument(""), rows: scenario.rows, ...("sections" in scenario ? { sections: scenario.sections } : {}) };
      for (const handle of handles) {
        const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: scenario.recovery });
        assert.equal(actual.save, mergedProjectionSave(document));
        if (scenario.rows.length === 1) assert.equal(startsParagraph({ rows: scenario.rows, comments: [] }, 0), true);
      }
      agree(scenario.name, order, handles, readPureMergedProjection);
    } finally { run.close(); }
  });

for (const copies of [2, 3]) for (const order of deliveryOrders) test(`paragraph flags are inert at implicit and joined starts: ${copies} copies ${order}`, () => {
  const run = replicas(copies, { rows: [row("R1", "a", {}), row("R2", "b"), row("R3", "c", {})],
    sections: [{ id: "H3", name: "Scene", firstSceneId: "R3" }] });
  const handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
  try {
    join(run.a, "R2", "R1", "join");
    execute(run.b, { kind: "scalar", id: "flag", by: "writer", target: { scope: "beat", record: "R2" }, field: "paragraphStart", value: true });
    run.queue.flush(order);
    const document = { ...literalMergedDocument(""), rows: [row("R1", "a b", {}), row("R3", "c", {})],
      sections: [{ id: "H3", name: "Scene", firstSceneId: "R3" }] };
    for (const handle of handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] });
      assert.equal(actual.save, mergedProjectionSave(document));
      assert.equal(startsParagraph(actual.view.document, 0), true); assert.equal(startsParagraph(actual.view.document, 1), true);
      const beat = collabState(handle).roots.beats.get("R2"); assert.ok(beat instanceof Y.Map); assert.equal(beat.get("paragraphStart"), true);
    }
    agree("implicit paragraph starts", order, handles, readPureMergedProjection);
    transactSharedDocument(run.a, "local-command", () => collabState(run.a).roots.retiredJoins.set("join", true)); run.queue.flush(order);
    for (const handle of handles) {
      const actual = readPureMergedProjection(handle);
      assert.deepEqual(actual.view.document.rows, [row("R1", "a", {}), row("R2", "b", { paragraphStart: true }), row("R3", "c", {})]);
      assert.equal(startsParagraph(actual.view.document, 1), true);
    }
    agree("explicit paragraph survives retirement", order, handles, readPureMergedProjection);
  } finally { run.close(); }
});

for (const same of [false, true]) for (const copies of [2, 3]) for (const order of deliveryOrders)
  test(`existing causal status reader feeds join groups: same=${same}, ${copies} copies ${order}`, () => {
    const run = replicas(copies, { rows: [row("R1", "a"), row("R2", "b")] }), handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
    const target = { scope: "beat" as const, record: ref("R2") };
    try {
      join(copies === 3 ? run.c : run.a, "R2", "R1", "join");
      execute(run.a, { kind: "status", id: "a", by: "A", target, value: same ? "shot" : "ready", parents: [] });
      execute(run.b, { kind: "status", id: "b", by: "B", target, value: "shot", parents: [] }); run.queue.flush(order);
      const document = { ...literalMergedDocument(""), rows: [row("R1", "a b", { status: same ? "shot" : "todo" })] };
      for (const handle of handles) {
        const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
      }
      agree("concurrent group status", order, handles, readPureMergedProjection);
      execute(run.a, { kind: "status", id: "after", by: "A", target, value: "ready", parents: readSharedStatusHeads(run.a, target) }); run.queue.flush(order);
      for (const handle of handles) assert.deepEqual(readPureMergedProjection(handle).view.document.rows, [row("R1", "a b", { status: "ready" })]);
      agree("later group status", order, handles, readPureMergedProjection);
    } finally { run.close(); }
  });

for (const copies of [2, 3]) for (const order of deliveryOrders) test(`removed join group retains marked text, comments, replies and pictures: ${copies} copies ${order}`, () => {
  const firstImage = { sha256: "a".repeat(64), width: 10, height: 20, mime: "image/png" };
  const secondImage = { sha256: "b".repeat(64), width: 20, height: 30, mime: "image/png" };
  const audio = '<span class="cmt-anchor" data-cmt="anchor">b</span>';
  const run = replicas(copies, { rows: [row("R1", "<strong>a</strong>", { visualText: "<em>first</em>", imageRef: firstImage, imageName: "First" }),
    row("R2", audio, { visualText: "second", imageRef: secondImage, imageName: "Second" })],
    comments: [{ id: "C1", rowId: "R2", field: "audioText", anchorId: "anchor", quotedText: "b", author: "Ada", body: "Typed comment",
      replies: [{ id: "RP1", author: "Bob", body: "Typed reply" }] }] });
  const handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
  try {
    join(run.a, "R2", "R1", "join"); remove(run.b, "R1"); run.queue.flush(order);
    const document = { ...literalMergedDocument(""), rows: [], comments: [{ id: "C1", rowId: "R1", field: "audioText", anchorId: "anchor", quotedText: "b", author: "Ada",
      body: "Typed comment", resolved: false, resolvedBy: null, resolvedAt: null, assignee: "", updatedAt: null, kind: "anchor",
      replies: [{ id: "RP1", author: "Bob", body: "Typed reply" }] }] };
    const recovery = [{ kind: "removed-beat", row: row("R1", "<strong>a</strong> " + audio, { visualText: "<em>first</em><br>second",
      imageRef: firstImage, imageName: "First", moreImages: [{ imageRef: secondImage, name: "Second" }] }), members: ["R1", "R2"], comments: ["C1"] }];
    for (const handle of handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery }); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree("removed content is recoverable", order, handles, readPureMergedProjection);
  } finally { run.close(); }
});
