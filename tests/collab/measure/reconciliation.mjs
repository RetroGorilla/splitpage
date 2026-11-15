import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import * as Y from "yjs";
import { retainedBytes } from "./retained-bytes.mjs";
import { open, writer } from "./run.mjs";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { isMain } from "../../../tools/main-module.mjs";

export function insertionMarks(attributes, comments = []) {
  return Object.entries(attributes).filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([key, value]) => key.startsWith("t:") ? { kind: "tag", id: value, value }
    : key.startsWith("c:") ? { kind: "comment", id: comments.find(comment => comment.id === key.slice(2))?.anchorId ?? key.slice(2), value }
      : key.startsWith("l:") ? { kind: "link", id: value, value } : { kind: key, value });
}

function semanticMarks(marks) {
  return [...new Set(marks.flatMap(mark => mark.values.map(value => JSON.stringify([mark.kind, value]))))].sort();
}

export function executeMeasured(handle, raw, serial) {
  const operation = readOperation({ ...raw, id: "key" + serial, by: "Writer" + collabState(handle).doc.clientID });
  assert.ok(operation, JSON.stringify(raw));
  assert.deepEqual(executeSharedOperations(handle, [operation]), { ok: true }, raw.kind);
}

function metrics(ledger, typedCharacters, finalCharacters, exportedFileBytes) {
  const encodedBytes = ledger.encodedBytes;
  return { ...ledger, typedCharacters, finalCharacters, exportedFileBytes,
    bytesPer1000Final: encodedBytes * 1000 / finalCharacters, bytesPer1000Typed: encodedBytes * 1000 / typedCharacters,
    encodedOverExport: encodedBytes / exportedFileBytes, within2MiB: encodedBytes <= 2 * 1024 ** 2,
    within10x: encodedBytes <= 10 * exportedFileBytes };
}

export function replayStageTwo(input, writers) {
  const source = globalThis.structuredClone(input.source);
  source.rows = source.rows.map(row => ({ ...row, audioText: "", visualText: "" }));
  const handle = open(), edits = writer(handle), expected = new Map(), expectedMarks = new Map();
  try {
    for (const row of source.rows) for (const field of ["audioText", "visualText"]) {
      const key = JSON.stringify({ owner: row.id, field, segment: field === "visualText" ? row.id : "b:" + row.id });
      expected.set(key, []); expectedMarks.set(key, []);
    }
    collabState(handle).doc.clientID = 100;
    hydrateSharedDocument(handle, enterSharedDocument(source));
    const fresh = retainedBytes(collabState(handle).doc);
    let serial = 0, previousWriter = null, turn = -1;
    const order = source.rows.map(row => row.id);
    let lastOwner = null;
    for (const event of input.tape) {
      if (event.target.owner !== lastOwner || event.writer !== previousWriter) {
        turn++; previousWriter = event.writer; lastOwner = event.target.owner;
      }
      collabState(handle).doc.clientID = turn % writers + 1;
      const target = { ...event.target, segment: event.target.field === "visualText" ? event.target.owner : "b:" + event.target.owner }, key = JSON.stringify(target);
      assert.ok(order.includes(event.target.owner), "unknown tape cell");
      const units = expected.get(key) ?? []; expected.set(key, units);
      const marks = expectedMarks.get(key) ?? []; expectedMarks.set(key, marks);
      if (event.kind === "delete") {
        const observed = edits.history(target).units.slice(event.index, event.index + event.count).map(unit => unit.identity);
        assert.equal(observed.length, event.count);
        executeMeasured(handle, { kind: "text-delete", target, observed }, ++serial);
        units.splice(event.index, event.count);
        marks.splice(event.index, event.count);
      } else {
        const value = event.kind === "insert" ? event.text : "w" in event.value ? { atom: "who", name: event.value.w }
          : { atom: "broll", id: event.value.k, text: event.value.label };
        const insertion = insertionMarks(event.attributes, source.comments);
        executeMeasured(handle, { kind: "text-insert", target, at: edits.gap(target, event.index), content: [{ value, marks: insertion }] }, ++serial);
        units.splice(event.index, 0, ...(typeof value === "string" ? value.split("") : [value]));
        const semantics = [...new Set(insertion.map(mark => JSON.stringify([mark.kind, "id" in mark ? mark.id : mark.value])))].sort();
        marks.splice(event.index, 0, ...Array.from({ length: typeof value === "string" ? value.length : 1 }, () => semantics));
      }
    }
    let finalCharacters = 0;
    const { document: projected, recovery } = projectSharedDocumentWithRecovery(handle), runtime = createFlowLoadRuntime();
    for (const [key, units] of expected) {
      const target = JSON.parse(key), history = edits.history(target), actual = history.units.map(unit => unit.value);
      assert.deepEqual(actual, units, "Stage 2 replay differs from the Stage 1 text tape");
      assert.deepEqual(history.units.map(unit => semanticMarks(unit.marks)), expectedMarks.get(key), "Stage 2 replay differs from the Stage 1 mark payloads");
      const wantedText = units.map(value => typeof value === "string" ? value : value.atom === "who" ? "@" + value.name : value.text ?? "B-roll:").join("");
      const row = projected.rows.find(value => value.id === target.owner); assert.ok(row);
      const visible = runtime.cells(String(row[target.field] ?? "")).map(run => run.text ?? "").join("");
      assert.equal(visible, wantedText, "visible projection differs from the Stage 1 text tape");
      finalCharacters += units.reduce((sum, value) => sum + (typeof value === "string" ? value.length
        : value.atom === "who" ? 1 + value.name.length : value.text?.length ?? 7), 0);
    }
    const exportedFileBytes = Buffer.byteLength(JSON.stringify(projected, null, 2));
    const stageOne = input.results.find(result => result.writers === writers).typing;
    assert.equal(finalCharacters, stageOne.finalCharacters);
    const recoveryKinds = {};
    for (const entry of recovery) recoveryKinds[entry.kind] = (recoveryKinds[entry.kind] ?? 0) + 1;
    return { writers, blocks: 1, fresh, recoveryKinds, ...metrics(retainedBytes(collabState(handle).doc), stageOne.typedCharacters, finalCharacters, exportedFileBytes) };
  } finally { destroySharedDocument(handle); }
}

export function reconcile(input) {
  const stageOne = input.results.map(result => {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, Buffer.from(result.typing.encoded, "base64"));
      const { typedCharacters, finalCharacters, exportedFileBytes } = result.typing;
      return { writers: result.writers, blocks: 1, ...metrics(retainedBytes(doc), typedCharacters, finalCharacters, exportedFileBytes), fullWorkload: result.full };
    } finally { doc.destroy(); }
  });
  return { version: 1, source: "cafd0a73dfb0cd373b19e84b3503761e5e740840", runtime: process.version,
    comparison: "identical Stage 1 typing, immediate corrections, first-five-beat half rewrites; structural tail excluded from both",
    exportNote: "Stage 1 uses its serializeProjection; Stage 2 uses pretty JSON of its plain projection, all beats active",
    tapeOperations: input.tape.length, stageOne, stageTwo: [2, 6].map(writers => replayStageTwo(input, writers)) };
}

if (isMain(import.meta.url)) {
  const input = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8"))
    : JSON.parse(execFileSync(process.execPath, ["prototypes/collab/src/perf/lifetime/byte-replay.ts"], { encoding: "utf8", maxBuffer: 32 * 1024 ** 2 }));
  writeFileSync(process.argv[3] ?? "docs/collaboration/stage-2-byte-reconciliation.json", JSON.stringify(reconcile(input), null, 2) + "\n");
}
