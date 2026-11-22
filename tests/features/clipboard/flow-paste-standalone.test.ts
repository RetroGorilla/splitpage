import "../../../src/test/_dom.mjs";
import "../../../src/test/_copy-paste-mounted.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { standaloneFlowCommand } from "../../../src/application/commands/flow.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { beatPos, caretAt } from "../../../src/core/flow/flow.ts";
import { startBeatClip } from "../../../src/features/clipboard/beat-clip.ts";
import { pasteFlowClipboard } from "../../../src/features/clipboard/flow-clip.ts";

const stamps = { clock: { nowIso: () => "2026-11-13T12:00:00.000Z" }, editor: { name: () => "Alice" } };
const image = { sha256: "a".repeat(64), width: 3, height: 2, mime: "image/jpeg" };
const annotation = { imageRef: { sha256: "c".repeat(64), width: 3, height: 2, mime: "image/jpeg" },
  marks: [{ kind: "pen", color: "#e5383b", width: 0.01, points: [0.1, 0.1, 0.5, 0.5] }] };
const changed = { updatedAt: "2026-11-13T12:00:00.000Z", updatedBy: "Alice" };
const at = caretAt(beatPos("R1", 1));

function expectedRow(id: string, audioText: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, status: "todo", visualText: "", audioText, imageRef: null, updatedAt: "", updatedBy: null, ...extra };
}

function expectedDocument(rows: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows,
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0, ...extra };
}

function wire(rows: readonly Record<string, unknown>[], records: Record<string, unknown> = {}, headers: readonly unknown[] = []) {
  const payload = JSON.stringify({ format: "splitpage-flow", version: 1, text: "X", wholeIds: rows.map(row => row.id), headers,
    beats: rows.length ? { format: "splitpage-scenes", version: 1, rows, ...records } : null });
  return { getData: (type: string) => type === "application/x-splitpage-flow" ? payload : "" };
}

function clipboardRuntime() {
  const runtime = createFlowLoadRuntime(); let next = 0;
  const clip = startBeatClip({ ids: { id: prefix => prefix + ++next }, pictures: { dataUrlFor: () => null,
    internDataUrl: () => null, queuePersist: () => {} }, text: { cellOf: runtime.cells,
    fromHtml: html => runtime.rich.decode(html, { media: true }), inertBody: runtime.rich.inertBody },
  migrate: runtime.load, tagsInRows: () => [], recordPastedBroll: () => {} });
  return { ...runtime, close: clip.dispose };
}

for (const literal of [
  { name: "marked gallery picture", rows: [{ id: "old", audioText: "X", imageRef: image, imageName: "wide.jpg", imageAnnotation: annotation }], headers: [],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow("r1", "X", { ...changed, imageRef: image, imageName: "wide.jpg", imageAnnotation: annotation }), expectedRow("R2", "B")]) },
  { name: "heading only", rows: [], headers: [{ index: 0, scene: { name: "Scene" } }],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow("R2", "B")], { sections: [{ id: "new3", name: "Scene", firstSceneId: "R2" }] }) }
]) test("standalone Writer paste retains " + literal.name, () => {
  const runtime = clipboardRuntime();
  try {
    const standalone = runtime.load({ schema: 2, docId: "d00000000000000000000000000000000", rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "B" }] });
    const data = wire(literal.rows, {}, literal.headers);
    const command = standaloneFlowCommand("paste", () => pasteFlowClipboard(standalone, at, data, runtime.ports, runtime.rich.inertBody, runtime.load) ?? null, stamps, at);
    const plan = command.plan(standalone, createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) }));
    assert.ok(plan && !("refused" in plan));
    plan.apply(standalone);
    assert.deepEqual(standalone, literal.expected);
  } finally { runtime.close(); }
});
