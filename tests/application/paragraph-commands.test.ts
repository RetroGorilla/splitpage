import { test } from "node:test";
import assert from "node:assert/strict";
import { addBeatCommand, deleteBeatCommand, moveBeatCommand, swapBeatsCommand } from "../../src/application/commands/rows.ts";
import { pasteBeatsCommand, removeBeatsCommand } from "../../src/application/commands/beats.ts";
import { addSceneCommand, removeSceneCommand, moveSceneCommand } from "../../src/application/commands/scenes.ts";
import { joinBeatsCommand, splitBeatCommand, textCut } from "../../src/application/commands/split-join.ts";
import { importRowsCommand } from "../../src/application/commands/import-rows.ts";
import { createUndo } from "../../src/application/editing/undo/undo.ts";
import { scenesInOrder } from "../../src/core/document/scenes.ts";
import { cloneState } from "../../src/core/document/clone.ts";
import type { DocumentShape, DocumentRow } from "../../src/core/document/validated.ts";
import type { Command } from "../../src/application/session/document-session.ts";
import { harness, runConfined } from "./session-fakes.ts";
import type { Harness } from "./session-fakes.ts";

const ports = {
  clock: { nowIso: () => "2030-01-01T00:00:00.000Z" }, editor: { name: () => "Editor" },
  cells: (html: string) => html ? [{ text: html, marks: {} }] : [],
  plainText: (html: string | null | undefined) => html || ""
};

function opened(flags: string[] = [], sections: string[] = []): Harness {
  const h = harness();
  h.session.adopt({ schema: 2, title: "Paragraphs", rows: ["a", "b", "c", "d", "e", "f"].map(id => ({
    id, audioText: id, updatedAt: "2020-01-01T00:00:00.000Z", updatedBy: "Alice",
    ...(flags.includes(id) ? { paragraphStart: true } : {})
  })), sections: sections.map(id => ({ id: "s" + id, name: id, firstSceneId: id })) });
  h.log.length = 0;
  return h;
}

function snapshot(h: Harness): DocumentShape {
  return h.session.read(doc => cloneState(doc)) as DocumentShape;
}

function flags(h: Harness): string[] {
  return snapshot(h).rows.filter(row => row.paragraphStart).map(row => row.id);
}

function paste(afterRowId: string | null, rows: DocumentRow[], replaced: string | null = null): Command {
  return pasteBeatsCommand({
    plan: () => ({ inserted: rows.map(row => row.id), replaced, afterRowId, title: false, saveNow: true }),
    apply(live) {
      const at = replaced ? live.rows.findIndex(row => row.id === replaced)
        : afterRowId ? live.rows.findIndex(row => row.id === afterRowId) + 1 : live.rows.length;
      live.rows.splice(at, replaced ? 1 : 0, ...cloneState(rows).map(row => ({ visualText: "", audioText: "", imageRef: null,
        status: "todo", updatedAt: "", updatedBy: null, ...row })));
    }
  });
}

function partners(doc: DocumentShape): Map<string, string> {
  const anchors = new Set((scenesInOrder(doc) ?? []).map(scene => scene.firstSceneId));
  const out = new Map<string, string>();
  let group = "";
  for (const row of doc.rows) {
    if (!group || row.paragraphStart || anchors.has(row.id)) group = row.id;
    out.set(row.id, group);
  }
  return out;
}

function content(doc: DocumentShape): unknown {
  return JSON.parse(JSON.stringify(doc, (key, value: unknown) =>
    ["updatedAt", "updatedBy", "lastEditedAt", "lastEditedBy", "rev"].includes(key) ? undefined : value));
}

function undoFor(h: Harness) {
  let now = 0;
  const undo = createUndo({ held: h.session.held, runs: html => ports.cells(String(html ?? "")),
    now: () => now += 2000, cleared: () => {} });
  undo.track();
  undo.routeReplays(h.session.replay, { clock: ports.clock, editor: { name: () => "Bob" } });
  return undo;
}

function visible(row: DocumentRow): string {
  return JSON.stringify(row, (key, value: unknown) =>
    ["paragraphStart", "updatedAt", "updatedBy"].includes(key) ? undefined : value);
}

function assertEditedAttribution(before: DocumentShape, after: DocumentShape, editor: string, label: string): void {
  for (const row of after.rows) {
    const was = before.rows.find(item => item.id === row.id);
    if (!was || visible(was) === visible(row)) continue;
    assert.deepEqual([row.updatedAt, row.updatedBy], [ports.clock.nowIso(), editor], `${label}: ${row.id} attribution`);
  }
}

function assertUntouchedAttribution(before: DocumentShape, after: DocumentShape, label: string, edited = new Set<string>()): void {
  for (const row of before.rows) {
    if (edited.has(row.id)) continue;
    const next = after.rows.find(item => item.id === row.id);
    if (!next || visible(row) !== visible(next)) continue;
    assert.deepEqual([next.updatedAt, next.updatedBy], [row.updatedAt, row.updatedBy], `${label}: ${row.id} attribution`);
  }
}

test("paragraph-only command changes preserve attribution forward, on undo and on redo", () => {
  for (const [command, rowId] of [
    [moveBeatCommand("b", "a", false), "a"], [swapBeatsCommand("b", -1), "a"],
    [removeSceneCommand("sb"), "b"], [deleteBeatCommand("d"), "e"],
    [removeBeatsCommand(["d"]), "e"], [paste(null, [{ id: "new" }], "d"), "e"]
  ] as const) {
    const h = opened(["d"], ["b", "c"]), undo = undoFor(h);
    const before = snapshot(h);
    assert.equal(runConfined(h.session, command).kind, "applied");
    const after = snapshot(h);
    assert.equal(after.rows.find(row => row.id === rowId)?.paragraphStart, true, command.name);
    assertUntouchedAttribution(before, after, command.name);
    undo.noteEdit(); undo.flush();
    assert.equal(undo.undo().ok, true);
    assert.deepEqual(snapshot(h), before, `${command.name} undo`);
    assert.deepEqual(h.published.at(-1)?.changes.cells, [{ rowId, field: "paragraphStart" }]);
    assert.equal(undo.redo().ok, true);
    assert.deepEqual(snapshot(h), after, `${command.name} redo`);
    assert.deepEqual(h.published.at(-1)?.changes.cells, [{ rowId, field: "paragraphStart" }]);
    h.session.dispose();
  }
});

test("content edits still stamp a beat when it also carries a paragraph flag", () => {
  const h = opened(["b"]), undo = undoFor(h);
  runConfined(h.session, joinBeatsCommand("b", ports));
  assert.equal(snapshot(h).rows.find(row => row.id === "b")?.updatedBy, "Editor");
  undo.noteEdit(); undo.flush();
  for (const replay of [undo.undo, undo.redo]) {
    assert.equal(replay().ok, true);
    assert.equal(snapshot(h).rows.find(row => row.id === "b")?.updatedBy, "Bob");
    assert.equal(snapshot(h).rows.find(row => row.id === "b")?.updatedAt, ports.clock.nowIso());
  }
  h.session.dispose();
});

test("one undo entry holding a paragraph flag and a content edit still stamps the edited beat on replay", () => {
  const h = opened([], ["b"]), undo = undoFor(h);
  const row = (id: string) => snapshot(h).rows.find(item => item.id === id);
  runConfined(h.session, removeSceneCommand("sb"));
  runConfined(h.session, joinBeatsCommand("b", ports));
  assert.equal(row("b")?.paragraphStart, true);
  undo.noteEdit(); undo.flush();
  for (const replay of [undo.undo, undo.redo]) {
    assert.equal(replay().ok, true);
    assert.deepEqual([row("b")?.updatedAt, row("b")?.updatedBy], [ports.clock.nowIso(), "Bob"]);
    assert.deepEqual([row("a")?.updatedAt, row("a")?.updatedBy], ["2020-01-01T00:00:00.000Z", "Alice"]);
  }
  h.session.dispose();
});

test("deleting paragraph starts promotes only the next survivor in the same paragraph", () => {
  const h = opened(["c", "f"]);
  const outcome = runConfined(h.session, removeBeatsCommand(["c", "d"]));
  assert.equal(outcome.kind, "applied");
  assert.deepEqual(flags(h), ["e", "f"]);
  assert.deepEqual(outcome.kind === "applied" && outcome.changes.cells, [{ rowId: "e", field: "paragraphStart" }]);
  assert.equal(h.log.filter(line => line === "undo.record").length, 1);
  runConfined(h.session, deleteBeatCommand("e"));
  assert.deepEqual(flags(h), ["f"]);
});

test("unflagged deletes, moves and swaps keep one paragraph without adding stored flags", () => {
  for (const command of [deleteBeatCommand("a"), removeBeatsCommand(["a", "c"]), moveBeatCommand("a", "d", true),
    moveBeatCommand("a", "f", true), moveBeatCommand("e", "a", false), swapBeatsCommand("a", 1)]) {
    const h = opened();
    runConfined(h.session, command);
    assert.deepEqual(flags(h), [], command.name);
  }
});

test("moves and swaps preserve source survivors and flow into the middle of the destination paragraph", () => {
  for (const command of [moveBeatCommand("c", "a", true), swapBeatsCommand("c", -1)]) {
    const h = opened(["c"]);
    runConfined(h.session, command);
    assert.deepEqual(flags(h), ["d"]);
    assert.equal(partners(snapshot(h)).get("c"), "a");
  }
  const h = opened(["b", "d"]);
  runConfined(h.session, moveBeatCommand("a", "c", true));
  assert.deepEqual(flags(h), ["b", "a", "d"], "the implicit single-beat first paragraph stays separate between paragraphs");
});

test("scene removal materializes its implicit start; adding and moving scenes changes no flags", () => {
  const h = opened([], ["c", "e"]);
  runConfined(h.session, removeSceneCommand("sc"));
  assert.deepEqual(flags(h), ["c"]);
  runConfined(h.session, addSceneCommand("b", "sb", "B"));
  runConfined(h.session, moveSceneCommand("se", "sb", false));
  assert.deepEqual(flags(h), ["c"]);
  const first = opened([], ["a"]);
  runConfined(first.session, removeSceneCommand("sa"));
  assert.deepEqual(flags(first), ["a"], "header removal explicitly records even a script-first break");
});

test("join keeps the first beat's flag, leaves the follower untouched when combining two visuals", () => {
  for (const sourceFlags of [["b"], ["c"], ["b", "c", "d"]]) {
    const h = opened(sourceFlags);
    const before = snapshot(h);
    runConfined(h.session, joinBeatsCommand("b", ports));
    assert.equal(snapshot(h).rows.find(row => row.id === "b")?.paragraphStart, before.rows[1]?.paragraphStart);
    assert.deepEqual(snapshot(h).rows.find(row => row.id === "d"), before.rows[3]);
  }
  const h = opened(["b"]);
  const before = snapshot(h);
  assert.ok(before.rows[0] && before.rows[1]);
  before.rows[0].visualText = "one";
  before.rows[1].visualText = "two";
  const untouched = cloneState(before.rows.slice(2));
  h.session.adopt(before);
  assert.equal(runConfined(h.session, joinBeatsCommand("a", ports)).kind, "applied");
  const joined = snapshot(h);
  assert.deepEqual(joined.rows.map(row => row.id), ["a", "c", "d", "e", "f"]);
  assert.equal(joined.rows[0]?.audioText, "a b");
  assert.equal(joined.rows[0]?.visualText, "one<br>two");
  assert.deepEqual(flags(h), []);
  assert.deepEqual(joined.rows.slice(1), untouched);
});

test("paste adjusts the first copied flag at the destination, retains interior flags, and preserves a replaced start", () => {
  for (const [after, expected] of [["a", ["y", "c"]], ["b", ["x", "y", "c"]], ["f", ["c", "x", "y"]]] as const) {
    const h = opened(["c"]);
    runConfined(h.session, paste(after, [{ id: "x", paragraphStart: true }, { id: "y", paragraphStart: true }]));
    assert.deepEqual(flags(h), expected);
  }
  const h = opened(["c"]);
  runConfined(h.session, paste(null, [{ id: "x" }], "c"));
  assert.deepEqual(flags(h), ["x", "d"]);
  const scene = opened([], ["c"]);
  runConfined(scene.session, paste(null, [{ id: "x" }], "c"));
  assert.deepEqual(flags(scene), ["d"]);
  assert.equal(scenesInOrder(snapshot(scene))?.[0]?.firstSceneId, "x");
});

test("new, split and imported beats do not accidentally copy a paragraph flag", () => {
  const h = opened(["b"]);
  runConfined(h.session, addBeatCommand("b", "add", ports));
  runConfined(h.session, splitBeatCommand("b", "audioText", textCut(0, 0), "split", ports));
  const source = snapshot(h).rows[1];
  assert.ok(source);
  runConfined(h.session, importRowsCommand({ rows: [{ ...source, id: "import" }], replace: false, scan: () => "" }, ports).command);
  assert.deepEqual(flags(h), ["b"]);
});

test("a failure after flag adjustments rolls back structure and flags without an undo entry", () => {
  const h = harness(undefined, { reconcile: () => { throw new Error("anchor failure"); } });
  h.session.adopt({ rows: [{ id: "a" }, { id: "b", paragraphStart: true }, { id: "c" }] });
  const before = snapshot(h);
  h.log.length = 0;
  assert.equal(runConfined(h.session, deleteBeatCommand("b")).kind, "failed");
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.log.includes("undo.record"), false);
  assert.equal(h.session.generation(), 0);
});

test("seeded command sequences preserve untouched partners and attribution, nonempty scenes and undo content", () => {
  let random = 0x1a202611;
  const pick = (n: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return n ? (random >>> 8) % n : 0; };
  for (let trial = 0; trial < 80; trial++) {
    const h = opened(["b", "c", "d", "e", "f"].filter(() => pick(3) === 0), ["c", "e"].filter(() => pick(2) === 0));
    const history = undoFor(h);
    const versions = [snapshot(h)];
    for (let step = 0; step < 45; step++) {
      const before = snapshot(h), groups = partners(before);
      const at = pick(before.rows.length), other = pick(before.rows.length);
      const id = before.rows[at]?.id, target = before.rows[other]?.id;
      const fresh = "new" + trial + "_" + step;
      const touched = new Set<string>();
      const touchParagraph = (rowId: string | undefined): void => {
        for (const [key, value] of groups) if (value === groups.get(rowId ?? "")) touched.add(key);
      };
      const scenes = scenesInOrder(before) ?? [];
      let command: Command;
      switch (pick(10)) {
        case 0: command = deleteBeatCommand(id ?? "missing"); touched.add(id ?? ""); break;
        case 1: command = removeBeatsCommand([id ?? "", target ?? ""]); touched.add(id ?? ""); touched.add(target ?? ""); break;
        case 2: command = moveBeatCommand(id ?? "", target ?? "", !!pick(2)); touched.add(id ?? ""); break;
        case 3: command = swapBeatsCommand(id ?? "", pick(2) ? 1 : -1); touched.add(id ?? ""); break;
        case 4:
          command = joinBeatsCommand(id ?? "", ports);
          touchParagraph(id); touchParagraph(before.rows[at + 1]?.id); break;
        case 5:
          command = paste(id ?? null, [{ id: fresh }, { id: fresh + "b", ...(pick(2) ? { paragraphStart: true } : {}) }]);
          touchParagraph(id); break;
        case 6: command = removeSceneCommand(scenes[pick(scenes.length)]?.id ?? ""); break;
        case 7: command = moveSceneCommand(scenes[0]?.id ?? "", scenes[1]?.id ?? "", !!pick(2)); break;
        case 8: command = addBeatCommand(id ?? null, fresh, ports); break;
        default: command = splitBeatCommand(id ?? "", "audioText", textCut(0, 0), fresh, ports); break;
      }
      const outcome = runConfined(h.session, command);
      assert.notEqual(outcome.kind, "failed", `trial ${trial}, step ${step}, ${command.name}`);
      if (outcome.kind !== "applied") continue;
      const after = snapshot(h), nextGroups = partners(after);
      const edited = new Set(outcome.changes.cells.flatMap(cell =>
        cell.field !== "paragraphStart" && cell.rowId ? [cell.rowId] : []));
      assertUntouchedAttribution(before, after, `trial ${trial}, step ${step}, ${command.name}`, edited);
      const untouched = before.rows.filter(row => !touched.has(row.id) && nextGroups.has(row.id));
      for (const a of untouched) for (const b of untouched) {
        assert.equal(nextGroups.get(a.id) === nextGroups.get(b.id), groups.get(a.id) === groups.get(b.id),
          `trial ${trial}, step ${step}, ${command.name}: ${a.id}/${b.id}`);
      }
      for (const scene of scenesInOrder(after) ?? []) assert.ok(after.rows.some(row => row.id === scene.firstSceneId));
      assert.equal(scenesInOrder(after)?.length ?? 0, Array.isArray(after.sections) ? after.sections.length : 0);
      assert.equal(new Set(after.rows.map(row => row.id)).size, after.rows.length);
      assert.ok(after.rows.every(row => !Object.hasOwn(row, "paragraphStart") || row.paragraphStart === true));
      history.noteEdit(); history.flush();
      versions.push(after);
    }
    for (let at = versions.length - 2; at >= 0; at--) {
      const before = snapshot(h);
      assert.equal(history.undo().ok, true, `trial ${trial}`);
      const previous = versions[at];
      assert.ok(previous);
      assert.deepEqual(content(snapshot(h)), content(previous));
      assertUntouchedAttribution(before, snapshot(h), `trial ${trial}, undo ${at}`);
      assertEditedAttribution(before, snapshot(h), "Bob", `trial ${trial}, undo ${at}`);
    }
    for (let at = 1; at < versions.length; at++) {
      const before = snapshot(h);
      assert.equal(history.redo().ok, true, `trial ${trial}`);
      const next = versions[at];
      assert.ok(next);
      assert.deepEqual(content(snapshot(h)), content(next));
      assertUntouchedAttribution(before, snapshot(h), `trial ${trial}, redo ${at}`);
      assertEditedAttribution(before, snapshot(h), "Bob", `trial ${trial}, redo ${at}`);
    }
    h.session.dispose();
  }
});
