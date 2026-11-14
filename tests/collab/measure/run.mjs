import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import * as Y from "yjs";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { createSharedDocument, applySharedUpdate, encodeSharedState, destroySharedDocument, observeSharedUpdates } from "../../../src/adapters/collab/document.ts";
import { CollabDocumentState, collabState, transactCollabState } from "../../../src/adapters/collab/state.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { inlineStateImages } from "../../../src/adapters/storage/02c-blobs.ts";
import { isMain } from "../../../tools/main-module.mjs";

const MIB = 1024 ** 2;
const CAP = 2 * MIB;
const copy = value => globalThis.structuredClone(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value, null, 2));
const target = owner => ({ owner, segment: "b:" + owner, field: "audioText" });

export function scaleFixture(base, copies) {
  const result = copy(base);
  result.rows = []; result.comments = []; result.brollShots = [];
  for (let k = 0; k < copies; k++) {
    const suffix = k ? "-" + k : "";
    const retag = text => typeof text === "string" ? text.replace(/(data-cmt|data-broll-id)="([^"]*)"/g,
      (_, attribute, id) => `${attribute}="${id}${suffix}"`) : text;
    for (const row of base.rows) result.rows.push({ ...copy(row), id: row.id + suffix,
      visualText: retag(row.visualText), audioText: retag(row.audioText) });
    for (const comment of base.comments) result.comments.push({ ...copy(comment), id: comment.id + suffix,
      rowId: comment.rowId + suffix, ...comment.anchorId ? { anchorId: comment.anchorId + suffix } : {} });
    for (const shot of base.brollShots) result.brollShots.push({ ...copy(shot), id: shot.id + suffix });
  }
  return result;
}

export function fixtures() {
  const { fixtures: recorded } = JSON.parse(readFileSync(new URL("../fixtures/projection-reference.json", import.meta.url), "utf8"));
  const short = recorded.find(value => value.name === "src/seed-state.json");
  const long = recorded.find(value => value.name === "src/starters/long-demo.json");
  assert.equal(short.appSaved.bytes, 1734); assert.equal(long.appSaved.bytes, 38432);
  const largePlain = scaleFixture(JSON.parse(long.appSaved.full), 10);
  assert.equal(bytes(largePlain), 334208);
  return [
    { name: "short", document: short.document, plain: short.appSaved.bytes },
    { name: "long", document: long.document, plain: long.appSaved.bytes },
    { name: "large", document: scaleFixture(long.document, 10), plain: bytes(largePlain) }
  ];
}

function open(state = null) {
  const handle = createSharedDocument();
  collabState(handle).doc.clientID = state ? 0x81234568 : 0x81234567;
  if (state) Y.applyUpdate(collabState(handle).doc, state);
  registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle);
  registerSharedSplitHandlers(handle, { cells: () => { throw new Error("Workload supplies no initial HTML"); } });
  registerSharedJoinHandlers(handle); registerSharedRemovalHandlers(handle);
  return handle;
}

export function writer(handle) {
  let serial = 0;
  const ends = new Map();
  const author = () => ({ id: "m" + ++serial, by: "Measurement" });
  const operationOf = raw => {
    const operation = readOperation({ ...raw, ...author() });
    assert.ok(operation, "invalid measurement operation");
    return operation;
  };
  const command = raw => {
    const operation = operationOf(raw);
    const execution = executeSharedCommand(handle, [operation], { label: raw.kind, selection: null, typing: null });
    assert.deepEqual(execution.result, { ok: true }, raw.kind);
    assert.ok(execution.record, "missing undo record for " + raw.kind);
    ends.clear();
    return execution.record;
  };
  const reverse = record => {
    const result = reverseSharedUndoRecord(handle, record, { by: "Measurement", nextId: () => author().id });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.effective, true);
    ends.clear();
    return result.inverse;
  };
  const history = address => {
    const result = readSharedTextHistory(handle, address);
    assert.ok(result); return result;
  };
  const gap = (address, offset) => {
    const anchor = createSharedAnchor(handle, address, offset, offset ? "before" : "after");
    assert.ok(anchor); return { left: anchor, right: null, affinity: "after" };
  };
  const type = (address, value, record = true) => {
    const key = JSON.stringify(address), offset = ends.get(key) ?? history(address).units.length;
    const raw = { kind: "text-insert", target: address, at: gap(address, offset), content: [{ value, marks: [] }] };
    let result = null;
    if (record) result = command(raw);
    else assert.deepEqual(executeSharedOperations(handle, [operationOf(raw)]), { ok: true });
    ends.set(key, offset + value.length);
    return result;
  };
  const typeBatch = (address, count) => {
    const key = JSON.stringify(address), offset = ends.get(key) ?? history(address).units.length, at = gap(address, offset);
    const operations = Array.from({ length: count }, () => operationOf({ kind: "text-insert", target: address, at, content: [{ value: "x", marks: [] }] }));
    assert.deepEqual(executeSharedOperations(handle, operations), { ok: true });
    ends.set(key, offset + count);
  };
  return { command, reverse, history, gap, type, typeBatch };
}

export function workload(handle, document) {
  const edit = writer(handle), address = target(document.rows[0].id);
  const fresh = encodeSharedState(handle).length;
  for (let block = 0; block < 100; block++) {
    edit.typeBatch(address, 100);
    const deletion = edit.command({ kind: "text-delete", target: address, observed: edit.history(address).units.slice(-100).map(unit => unit.identity) });
    edit.reverse(edit.reverse(deletion));
    if ((block + 1) % 25 === 0) process.stderr.write(`Text workload: ${block + 1}/100 blocks\n`);
  }
  const afterText = encodeSharedState(handle).length;
  for (let index = 0; index < 200; index++) {
    let record;
    if (index < 50) record = edit.command({ kind: "split", target: address, at: edit.gap(address, 2), observed: [],
      boundary: "boundary" + index, beat: "beat" + index, fields: {} });
    else if (index < 100) record = edit.command({ kind: "join", from: document.rows[1].id, into: document.rows[0].id, glue: " " });
    else {
      const owner = document.rows[1].id;
      record = edit.command({ kind: "remove", removalKind: "beat", targets: [owner],
        observed: edit.history(target(owner)).units.map(unit => unit.identity), boundaries: [owner], components: [], gallery: [], at: 1 });
    }
    edit.reverse(record);
  }
  for (let index = 0; index < 100; index++) {
    const record = edit.command({ kind: "mark", target: address, observed: edit.history(address).units.slice(0, 2).map(unit => unit.identity), mark: { kind: "b", value: true } });
    edit.reverse(record);
  }
  process.stderr.write("Completed 200 structural commands with undo and 100 formatting commands with undo\n");
  return { afterText, per1000Typed: (afterText - fresh) / 10 };
}

function growth(fixture) {
  const handle = open();
  try {
    hydrateSharedDocument(handle, enterSharedDocument(copy(fixture.document)));
    const entered = enterSharedDocument(projectSharedDocument(handle));
    const fresh = encodeSharedState(handle);
    const textGrowth = workload(handle, fixture.document), edited = encodeSharedState(handle);
    const projected = enterSharedDocument(projectSharedDocument(handle));
    assert.deepEqual(projected, entered);
    const probe = open(edited);
    let per100Pairs;
    try {
      const edit = writer(probe), record = edit.type(target(fixture.document.rows[0].id), "x");
      let next = record;
      const before = encodeSharedState(probe).length;
      for (let pair = 0; pair < 100; pair++) next = edit.reverse(edit.reverse(next));
      per100Pairs = encodeSharedState(probe).length - before;
    } finally { destroySharedDocument(probe); }
    const plainFile = copy(projected);
    inlineStateImages(plainFile);
    return { name: fixture.name, plain: fixture.plain, fresh, edited, ...textGrowth, per100Pairs,
      editedPlain: bytes(plainFile) };
  } finally { destroySharedDocument(handle); }
}

function updatesFor(state, owner) {
  const sender = open(state), updates = [];
  collabState(sender).doc.clientID = 0x81234569;
  const stop = observeSharedUpdates(sender, update => updates.push(update));
  try {
    const edit = writer(sender);
    for (let index = 0; index < 1000; index++) edit.type(target(owner), "x", false);
    assert.equal(updates.length, 1000);
    return { updates, final: encodeSharedState(sender) };
  } finally { stop(); destroySharedDocument(sender); }
}

function decode(update) {
  assert.ok(!Y.decodeUpdate(update).structs.some(struct => struct.length <= 0));
}

function direct(handle, update) {
  const state = collabState(handle);
  transactCollabState(state, "remote", () => Y.applyUpdate(state.doc, update, "remote"));
}

export function apply(handle, updates, mode) {
  if (mode === "batch") {
    const trial = new CollabDocumentState();
    try {
      Y.applyUpdate(trial.doc, encodeSharedState(handle));
      for (const update of updates) { decode(update); Y.applyUpdate(trial.doc, update); }
    } finally { trial.doc.destroy(); }
    for (const update of updates) direct(handle, update);
  } else for (const update of updates) {
    if (mode === "current") assert.equal(applySharedUpdate(handle, update).ok, true);
    else { if (mode === "decode") decode(update); direct(handle, update); }
  }
}

export function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function collectedHeap() { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; }

function timed(state, updates, mode, singles, expected) {
  const handle = open(state);
  try {
    collectedHeap();
    const samples = [], start = performance.now();
    if (singles) for (const update of updates) {
      const before = performance.now(); apply(handle, [update], mode); samples.push(performance.now() - before);
    }
    else apply(handle, updates, mode);
    const total = performance.now() - start;
    if (expected) assert.deepEqual(encodeSharedState(handle), expected);
    return { total, ...singles ? { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), max: Math.max(...samples) } : {} };
  } finally { destroySharedDocument(handle); }
}

function burstHeap(state, updates) {
  const handle = open(state);
  try {
    const before = collectedHeap();
    let peak = before;
    for (const update of updates) { apply(handle, [update], "current"); peak = Math.max(peak, process.memoryUsage().heapUsed); }
    return { peak: (peak - before) / MIB, retained: (collectedHeap() - before) / MIB };
  } finally { destroySharedDocument(handle); }
}

function footprint(fixture, state) {
  const before = collectedHeap(), plain = copy(fixture.document);
  const plainHeap = collectedHeap() - before;
  const handle = open(state);
  try {
    const sharedHeap = collectedHeap() - before - plainHeap;
    assert.equal(plain.rows.length, fixture.document.rows.length);
    return { plain: plainHeap / MIB, shared: sharedHeap / MIB, extra: (sharedHeap - plainHeap) / MIB, ratio: sharedHeap / plainHeap };
  } finally { destroySharedDocument(handle); }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summary(values, digits = 2) {
  return `${median(values).toFixed(digits)} [${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)}]`;
}

export function report(result) {
  const lines = [`Measured commit: ${result.commit}; Node ${result.node}; ${result.arch}; ${result.rounds} rounds.`, "",
    "Values are medians [min–max] of per-round statistics, not pooled updates.", "",
    "| Script | Fresh plain bytes | Fresh bytes / plain / cap % | Edited bytes / fresh plain / cap % | Edited plain bytes / edited multiple | Bytes per 1,000 corrected characters | Bytes per 100 undo/redo pairs |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of result.growth) {
    const format = value => `${value} / ${(value / row.plain).toFixed(2)}x / ${(100 * value / CAP).toFixed(2)}%`;
    lines.push(`| ${row.name} | ${row.plain} | ${format(row.fresh)} | ${format(row.edited)} | ${row.editedPlain} / ${(row.edited / row.editedPlain).toFixed(2)}x | ${row.per1000Typed} | ${row.per100Pairs} |`);
  }
  lines.push("", "| Script / state | Bytes added by 1,000 typed characters without deletion |", "| --- | --- |");
  for (const row of result.admission) lines.push(`| ${row.name} / ${row.phase} | ${row.per1000Typed} |`);
  lines.push("", "| Script / state | Admission p50 ms | p95 ms | max ms | Direct p50 ms | Decode-only p50 / p95 ms | Trial + validation % / trial estimate % (500 total) |", "| --- | --- | --- | --- | --- | --- | --- |");
  const stats = (row, select, digits = 2) => summary(row.runs.map(select), digits);
  for (const row of result.admission) lines.push(`| ${row.name} / ${row.phase} | ${stats(row, r => r.current.single.p50)} | ${stats(row, r => r.current.single.p95)} | ${stats(row, r => r.current.single.max)} | ${stats(row, r => r.direct.single.p50)} | ${stats(row, r => r.decode.single.p50)} / ${stats(row, r => r.decode.single.p95)} | ${stats(row, r => 100 * (1 - r.direct.single.total / r.current.single.total))} / ${stats(row, r => 100 * (1 - r.decode.single.total / r.current.single.total))} |`);
  lines.push("", "Input budget screen only; passing admission alone does not establish end-to-end input latency.", "",
    "| Script / state | Available added p50 ms (Stage 0 reference) | Added p50 budget | Admission p50 alone vs 8 ms | Admission p95 alone vs 25/40 ms | Any admission above 50 ms |",
    "| --- | --- | --- | --- | --- | --- |");
  for (const row of result.admission) {
    const added = Math.min(3, 8 - { short: 2.5, long: 2.8, large: 5.3 }[row.name]);
    const p50 = median(row.runs.map(run => run.current.single.p50));
    const p95 = median(row.runs.map(run => run.current.single.p95));
    const status = (value, limit) => value > limit ? "EXCEEDS" : "within alone";
    lines.push(`| ${row.name} / ${row.phase} | ${added.toFixed(1)} | ${status(p50, added)} | ${status(p50, 8)} | ${status(p95, row.name === "large" ? 40 : 25)} | ${row.runs.some(run => run.current.single.max > 50) ? "yes" : "no"} |`);
  }
  lines.push("", "| Script / state / burst | Current ms | Direct ms | Decode-only ms | One trial ms | Current / direct | Peak heap delta MiB | Retained heap delta MiB | Heap passes |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of result.admission) for (const count of [100, 1000]) {
    const heaps = row.runs.filter(run => run.heap);
    lines.push(`| ${row.name} / ${row.phase} / ${count} | ${stats(row, r => r.current[count].total)} | ${stats(row, r => r.direct[count].total)} | ${stats(row, r => r.decode[count].total)} | ${stats(row, r => r.batch[count].total)} | ${stats(row, r => r.current[count].total / r.direct[count].total)}x | ${summary(heaps.map(r => r.heap[count].peak))} | ${summary(heaps.map(r => r.heap[count].retained))} | ${heaps.length} |`);
  }
  lines.push("", "| Script / state | Plain retained MiB | Shared retained MiB | Shared minus plain MiB | Shared / plain |", "| --- | --- | --- | --- | --- |");
  for (const row of result.admission) lines.push(`| ${row.name} / ${row.phase} | ${stats(row, r => r.footprint.plain, 3)} | ${stats(row, r => r.footprint.shared, 3)} | ${stats(row, r => r.footprint.extra, 3)} | ${stats(row, r => r.footprint.ratio)}x |`);
  return lines.join("\n") + "\n";
}

export function restoreCheckpoint(saved, fingerprint) {
  assert.equal(saved.fingerprint, fingerprint, "Checkpoint source differs from current source");
  assert.equal(saved.result.node, process.version, "Checkpoint Node version differs");
  assert.equal(saved.result.arch, process.arch, "Checkpoint CPU architecture differs");
  return { ...saved, states: saved.states.map(row => ({ ...row,
    fresh: Buffer.from(row.fresh, "base64"), edited: Buffer.from(row.edited, "base64") })),
  streams: Object.fromEntries(Object.entries(saved.streams).map(([key, stream]) => [key, {
    updates: stream.updates.map(update => Buffer.from(update, "base64")), final: Buffer.from(stream.final, "base64") }])) };
}

export function saveCheckpoint(checkpoint) {
  return { ...checkpoint, states: checkpoint.states.map(row => ({ ...row,
    fresh: Buffer.from(row.fresh).toString("base64"), edited: Buffer.from(row.edited).toString("base64") })),
  streams: Object.fromEntries(Object.entries(checkpoint.streams).map(([key, stream]) => [key, {
    updates: stream.updates.map(update => Buffer.from(update).toString("base64")), final: Buffer.from(stream.final).toString("base64") }])) };
}

export function sourceFingerprint() {
  const runner = createHash("sha256").update(readFileSync(new URL("./run.mjs", import.meta.url))).digest("hex");
  return runner + "\n" + execFileSync("git", ["rev-parse", "HEAD:src", "HEAD:shared", "HEAD:package.json", "HEAD:package-lock.json",
    "HEAD:tests/collab/fixtures/projection-reference.json"], { encoding: "utf8" }).trim();
}

export function run(rounds = 5, saved = null, persist = () => {}) {
  assert.equal(process.versions.node, "24.22.1", "Use the repository Node pin");
  assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
  assert.ok(Number.isInteger(rounds) && rounds >= 5, "At least five rounds are required");
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "src", "shared", "package.json", "package-lock.json", "tests/collab/fixtures/projection-reference.json"], { encoding: "utf8" });
  assert.equal(dirty.trim(), "", "Commit measured source, dependencies and fixtures before running");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const fingerprint = sourceFingerprint();
  const checkpoint = saved ? restoreCheckpoint(saved, fingerprint) : null;
  const sources = fixtures(), states = checkpoint?.states ?? [];
  const result = checkpoint?.result ?? { commit, node: process.version,
    arch: process.arch, rounds, growth: [], admission: [] };
  assert.equal(result.rounds, rounds);
  const streams = checkpoint?.streams ?? {};
  const publish = () => persist(saveCheckpoint({ fingerprint, result, states, streams }));
  publish();
  for (const [index, source] of sources.entries()) if (!states[index]) {
    process.stderr.write(`Preparing ${source.name}\n`);
    const row = growth(source);
    states.push(row);
    result.growth.push({ ...row, fresh: row.fresh.length, edited: row.edited.length });
    publish();
  }
  for (const [index, source] of sources.entries()) for (const phase of ["fresh", "edited"]) {
    let row = result.admission.find(value => value.name === source.name && value.phase === phase);
    if (row?.runs.length === rounds) continue;
    const state = states[index][phase], key = source.name + "/fresh";
    const generated = streams[key] ?? (streams[key] = updatesFor(states[index].fresh, source.document.rows[0].id));
    const control = open(state);
    let expected;
    try {
      const address = target(source.document.rows[0].id), before = readSharedTextHistory(control, address).units.length;
      apply(control, generated.updates, "direct");
      assert.equal(readSharedTextHistory(control, address).units.length, before + 1000);
      expected = encodeSharedState(control);
    }
    finally { destroySharedDocument(control); }
    if (!row) {
      row = { name: source.name, phase, senderBase: key.split("/")[1], per1000Typed: expected.length - state.length, runs: [] };
      result.admission.push(row);
    }
    publish();
    for (let round = row.runs.length; round < rounds; round++) {
      const measured = { footprint: footprint(source, state) };
      const modes = ["current", "direct", "decode", "batch"];
      for (const mode of [...modes.slice(round % 4), ...modes.slice(0, round % 4)]) {
        measured[mode] = {};
        if (mode !== "batch") measured[mode].single = timed(state, generated.updates.slice(0, 500), mode, true);
        for (const count of [100, 1000]) measured[mode][count] = timed(state, generated.updates.slice(0, count), mode, false, count === 1000 ? expected : null);
      }
      if (!row.runs.some(run => run.heap)) {
        measured.heap = {};
        for (const count of [100, 1000]) measured.heap[count] = burstHeap(state, generated.updates.slice(0, count));
      }
      row.runs.push(measured);
      publish();
      process.stderr.write(`${source.name} ${phase}: round ${round + 1}/${rounds}\n`);
    }
  }
  return result;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 1, "Usage: node --expose-gc tools/measure-shared-admission.mjs [results.json]");
  const cache = args[0] ? args[0] + ".checkpoint.json" : null;
  const saved = cache && existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : null;
  const result = run(5, saved, checkpoint => {
    if (cache) {
      writeFileSync(cache, JSON.stringify(checkpoint));
      writeFileSync(args[0], JSON.stringify(checkpoint.result, null, 2) + "\n");
    }
  });
  if (args[0]) writeFileSync(args[0], JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(report(result));
}
