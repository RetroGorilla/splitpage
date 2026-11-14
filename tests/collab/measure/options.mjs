import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import * as Y from "yjs";
import { apply, open, quantile, summary } from "./run.mjs";
import { collabState, CollabDocumentState, transactCollabState } from "../../../src/adapters/collab/state.ts";
import { destroySharedDocument, encodeSharedState, observeSharedUpdates } from "../../../src/adapters/collab/document.ts";
import { isMain } from "../../../tools/main-module.mjs";

function decode(update) {
  const decoded = Y.decodeUpdate(update);
  assert.ok(decoded.structs.every(struct => struct.length > 0));
  return decoded;
}

function direct(handle, update) {
  const state = collabState(handle);
  transactCollabState(state, "remote", () => Y.applyUpdate(state.doc, update, "remote"));
}

export function checkReferences(doc, decoded) {
  const incoming = new Map();
  for (const struct of decoded.structs) {
    const list = incoming.get(struct.id.client) ?? [];
    list.push(struct); incoming.set(struct.id.client, list);
  }
  const present = id => {
    const stored = doc.store.clients.get(id.client);
    if (stored?.length && id.clock < stored.at(-1).id.clock + stored.at(-1).length) return true;
    return incoming.get(id.client)?.some(item => item.id.clock <= id.clock && item.id.clock + item.length > id.clock) ?? false;
  };
  let unresolved = 0;
  for (const item of decoded.structs) if (item instanceof Y.Item) {
    for (const id of [item.origin, item.rightOrigin, item.parent instanceof Y.ID ? item.parent : null]) {
      if (id && !present(id)) unresolved++;
    }
  }
  return unresolved;
}

export function admission(handle, mode) {
  if (mode !== "shadow") return {
    accept: updates => {
      if (mode === "batch") return apply(handle, updates, "batch");
      for (const update of updates) {
        const decoded = decode(update);
        if (mode === "references") assert.equal(checkReferences(collabState(handle).doc, decoded), 0, "Unresolved update references");
        direct(handle, update);
      }
    },
    close: () => {}, rebuild: () => {}
  };
  let shadow = null, accepting = false;
  const rebuild = () => {
    shadow?.doc.destroy();
    shadow = new CollabDocumentState();
    Y.applyUpdate(shadow.doc, encodeSharedState(handle));
  };
  rebuild();
  const stop = observeSharedUpdates(handle, update => { if (!accepting) Y.applyUpdate(shadow.doc, update); });
  return {
    accept: updates => {
      for (const update of updates) {
        try { decode(update); Y.applyUpdate(shadow.doc, update); }
        catch (error) { rebuild(); throw error; }
        accepting = true;
        try { direct(handle, update); } finally { accepting = false; }
      }
    },
    rebuild,
    close: () => { stop(); shadow.doc.destroy(); }
  };
}

function gcHeap() { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; }

function measure(state, updates, mode, singles, expected) {
  const handle = open(state), policy = admission(handle, mode);
  try {
    gcHeap();
    const samples = [], start = performance.now();
    if (singles) for (const update of updates) {
      const before = performance.now(); policy.accept([update]); samples.push(performance.now() - before);
    }
    else policy.accept(updates);
    const total = performance.now() - start;
    assert.deepEqual(encodeSharedState(handle), expected);
    return { total, ...singles ? { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), max: Math.max(...samples) } : {} };
  } finally { policy.close(); destroySharedDocument(handle); }
}

function heap(state, updates, mode) {
  const handle = open(state);
  const before = gcHeap(), policy = admission(handle, mode), second = gcHeap() - before;
  try {
    const baseline = gcHeap();
    let peak = baseline;
    if (mode === "batch") { policy.accept(updates); peak = process.memoryUsage().heapUsed; }
    else for (const update of updates) { policy.accept([update]); peak = Math.max(peak, process.memoryUsage().heapUsed); }
    const retained = gcHeap() - baseline;
    const start = performance.now();
    if (mode === "shadow") assert.throws(() => policy.accept([Uint8Array.of(255)]));
    const rebuild = performance.now() - start;
    return { secondMiB: second / 1024 ** 2, peakMiB: (peak - baseline) / 1024 ** 2, retainedMiB: retained / 1024 ** 2, rebuild };
  } finally { policy.close(); destroySharedDocument(handle); }
}

export function optionsReport(result) {
  const lines = ["Values: median [min–max] across five rounds. Milliseconds unless marked MiB.", "",
    "| Case | Method | p50 | p95 | Max | 100 drain | 1,000 drain | Second copy MiB | Rebuild | Peak / retained MiB (100 / 1,000) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of result.rows) for (const mode of ["shadow", "batch", "decode", "references"]) {
    const stat = key => summary(row.runs.map(run => key(run[mode])), 2);
    const singles = key => mode === "batch" ? "singleton = full trial" : stat(run => run.single[key]);
    const heaps = [100, 1000].map(count => stat(run => run.heap[count].peakMiB) + " / " + stat(run => run.heap[count].retainedMiB)).join("; ");
    lines.push(`| ${row.name}/${row.phase} | ${mode} | ${singles("p50")} | ${singles("p95")} | ${singles("max")} | ${stat(run => run[100].total)} | ${stat(run => run[1000].total)} | ${stat(run => run.heap[100].secondMiB)} | ${mode === "shadow" ? stat(run => run.heap[100].rebuild) : "—"} | ${heaps} |`);
  }
  return lines.join("\n") + "\n";
}

if (isMain(import.meta.url)) {
  assert.equal(process.versions.node, "24.22.1");
  assert.equal(typeof globalThis.gc, "function");
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", "src", "shared", "package.json", "package-lock.json",
    "tests/collab/fixtures/projection-reference.json"], { encoding: "utf8" }).trim(), "");
  const [checkpointFile, output] = process.argv.slice(2);
  assert.ok(checkpointFile && output, "Supply preparation checkpoint and local results filename");
  const saved = JSON.parse(readFileSync(checkpointFile, "utf8"));
  const trees = execFileSync("git", ["rev-parse", "HEAD:src", "HEAD:shared", "HEAD:package-lock.json",
    "HEAD:tests/collab/fixtures/projection-reference.json"], { encoding: "utf8" }).trim();
  assert.equal(saved.trees, trees); assert.equal(saved.result.node, process.version); assert.equal(saved.result.arch, process.arch);
  const fingerprint = createHash("sha256").update(readFileSync(new URL("./options.mjs", import.meta.url)))
    .update(readFileSync(new URL("./run.mjs", import.meta.url))).update(saved.trees).digest("hex");
  const result = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : { fingerprint, trees, node: process.version, arch: process.arch, rounds: 5, rows: [] };
  assert.equal(result.fingerprint, fingerprint);
  for (const state of saved.states) for (const phase of ["fresh", "edited"]) {
    const binary = Buffer.from(state[phase], "base64"), updates = saved.streams[state.name].updates.map(value => Buffer.from(value, "base64"));
    const expected = {};
    for (const count of [100, 500, 1000]) {
      const control = open(binary);
      try { apply(control, updates.slice(0, count), "direct"); expected[count] = encodeSharedState(control); }
      finally { destroySharedDocument(control); }
    }
    let row = result.rows.find(value => value.name === state.name && value.phase === phase);
    if (!row) { row = { name: state.name, phase, bytes: binary.length, runs: [] }; result.rows.push(row); }
    for (let round = row.runs.length; round < 5; round++) {
      const run = {}, modes = ["shadow", "batch", "decode", "references"];
      for (const mode of [...modes.slice(round % 4), ...modes.slice(0, round % 4)]) {
        const measured = { heap: {} };
        if (mode !== "batch") measured.single = measure(binary, updates.slice(0, 500), mode, true, expected[500]);
        for (const count of [100, 1000]) {
          measured[count] = measure(binary, updates.slice(0, count), mode, false, expected[count]);
          assert.ok(count !== 1000 || measured[count].total < 60000, "Stop: 1,000 drain exceeded one minute");
          measured.heap[count] = heap(binary, updates.slice(0, count), mode);
        }
        run[mode] = measured;
      }
      row.runs.push(run); writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
      process.stderr.write(`${state.name}/${phase}: ${round + 1}/5\n`);
    }
  }
  process.stdout.write(optionsReport(result));
}
