import assert from "node:assert/strict";
import { test } from "node:test";
import { execute, replicas } from "./executor-support.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { assertIncremental, nativeText } from "./incremental-support.ts";

const marker = (id: string): string => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;

test("b-roll keys scan only the changed cell's units, yet a new first occurrence re-keys a marker in an unscanned row", () => {
  const rows = Array.from({ length: 300 }, (_unused, index) => ({ id: "R" + String(index), audioText: "text " + String(index),
    visualText: index % 3 ? "" : marker(index % 2 ? "S1" : "S2") }));
  const run = replicas(2, { title: "Script", rows, brollShots: [{ id: "S1", name: "Street", status: "unshot", origin: "list" }] });
  const work: string[] = [], projector = createSharedIncrementalProjector(run.a, (kind, key) => { if (kind === "broll-scan") work.push(key); });
  const stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    assert.equal(work.length, 600);
    assertIncremental(run.a, projector);
    const visual = (index: number): unknown => projector.read().document.rows[index]?.visualText ?? projector.read().document.rows[index]?.audioText;
    const ids = (): unknown[] => [0, 3, 6, 9, 15].map(index => visual(index));
    assert.deepEqual(ids(), ["S2", "S1", "broll_00530032_1_227", "broll_00530031_1_315", "broll_00530031_1_497"].map(marker));
    const kept = projector.read().document.rows.slice(4);
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R150").insert(0, "x"));
    assert.deepEqual(work, ["[\"R150\",\"audioText\"]"]);
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").insertEmbed(0, { k: "S1", label: "B-roll:" }));
    assert.deepEqual(work, ["[\"R1\",\"audioText\"]"]);
    assert.equal(projector.read().document.rows[1]?.audioText, marker("S1") + "text 1");
    assert.deepEqual(ids(), ["S2", "broll_00530031_1_139", "broll_00530032_1_227", "broll_00530031_1_315", "broll_00530031_1_497"].map(marker));
    assert.deepEqual(projector.read().document.rows.slice(4).flatMap((row, at) => row === kept[at] ? [] : [row.id]), ["R150"]);
    registerSharedRecordHandlers(run.a);
    execute(run.a, { kind: "record-create", id: "reserve", by: "Writer", target: { collection: "shots", record: "broll_00530031_1_139" },
      fields: { id: "broll_00530031_1_139", name: "Reserved", status: "unshot", origin: "list" } });
    assert.deepEqual(work, ["[\"R1\",\"audioText\"]"]);
    assert.deepEqual(ids(), ["S2", "broll_00530031_1_139_", "broll_00530032_1_227", "broll_00530031_1_315", "broll_00530031_1_497"].map(marker));
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").delete(0, 1));
    assert.deepEqual(work, ["[\"R1\",\"audioText\"]"]);
    assert.deepEqual(ids(), ["S2", "S1", "broll_00530032_1_227", "broll_00530031_1_315", "broll_00530031_1_497"].map(marker));
  } finally { stop(); projector.dispose(); run.close(); }
});
