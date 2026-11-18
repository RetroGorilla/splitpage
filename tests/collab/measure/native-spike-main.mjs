import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { FlowOperationTrace } from "../../../src/core/flow/operations.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { createSharedDocument, applySharedUpdate, encodeSharedState, encodeSharedStateVector, encodeSharedUpdate, observeSharedUpdates,
  shouldDeliverSharedUpdate } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedUndoOwner } from "../../../src/bootstrap/wiring/ports/shared-undo.ts";

const strip = html => String(html ?? "").replace(/<span class="(?:broll-key|who-anchor)"[^>]*>[^<]*<\/span>/g, "￼").replace(/<br>/g, "\n").replace(/<[^>]*>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function attach(handle, client, editor) {
  let serial = 0;
  const author = () => ({ id: "k" + client + "_" + ++serial, by: "Writer " + client });
  if (!editor) return { handle, author, replica: null };
  const undo = sharedUndoOwner(handle, author, () => 0, error => { throw error; });
  return { handle, author, replica: createSharedReplica(handle, undefined, undo) };
}

function open(client) {
  const handle = createSharedDocument();
  collabState(handle).doc.clientID = client;
  registerSharedOperationFamilies(handle, { cells: () => { throw new Error("The workload supplies no initial HTML"); } });
  return handle;
}

const address = (beat, field) => ({ owner: beat, segment: beat, field });

const subject = {
  create(document, client, editor) {
    const handle = open(client);
    hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(document)));
    return attach(handle, client, editor);
  },
  clone(source, client, editor) {
    const handle = open(client);
    assert.equal(applySharedUpdate(handle, encodeSharedState(source.handle)).ok, true);
    return attach(handle, client, editor);
  },
  length(target, beat, field) {
    const painted = readSharedPaintedText(target.handle, address(beat, field));
    assert.ok(painted);
    return painted.text.length;
  },
  prepare(target, op) {
    const where = address(op.beat, op.field), painted = readSharedPaintedText(target.handle, where), author = target.author(), operations = [];
    assert.ok(painted);
    if (op.insert.length) {
      const trace = new FlowOperationTrace({ rows: [] }, { cells: () => [] }, { id: author.id + ":0", by: author.by });
      trace.insert(op.beat, [], 0, op.insert, "audioText");
      const insertion = trace.ops[0], right = op.from < painted.text.length ? painted.identity(op.from) : painted.emptyGap ?? null;
      const left = right ? null : painted.endGap ?? null;
      assert.equal(insertion?.kind, "text-insert");
      operations.push({ ...insertion, target: where, at: { left, right, affinity: right ? "before" : "after" } });
    }
    if (op.to > op.from) operations.push({ kind: "text-delete", target: where, id: author.id + ":0:delete", by: author.by,
      observed: Array.from({ length: op.to - op.from }, (_, offset) => painted.identity(op.from + offset)) });
    const typing = op.insert.map(run => run.atom ? "￼" : run.text).join("");
    if (!target.replica) return () => { assert.deepEqual(executeSharedOperations(target.handle, operations, { base: painted.revision }), { ok: true }); };
    return () => {
      const result = target.replica.execute(operations, { base: painted.revision, description: { label: "typing", selection: null, typing } });
      assert.deepEqual(result, { ok: true });
      return target.replica.changes();
    };
  },
  capture(target) {
    let updates = [];
    observeSharedUpdates(target.handle, (update, origin) => { if (shouldDeliverSharedUpdate(origin)) updates.push(Uint8Array.from(update)); });
    return () => { const taken = updates; updates = []; return taken; };
  },
  receive(target, update) {
    assert.equal(applySharedUpdate(target.handle, update).ok, true);
    return target.replica.changes();
  },
  pull(to, from) {
    assert.equal(applySharedUpdate(to.handle, encodeSharedUpdate(from.handle, encodeSharedStateVector(to.handle))).ok, true);
  },
  encode(target) { return encodeSharedState(target.handle); },
  text(target) {
    return projectSharedDocument(target.handle).rows.map(row => ({ id: row.id, audio: strip(row.audioText), visual: strip(row.visualText) }));
  }
};

// why: bench.ts requires the text from here to the line exporting measure to be identical in both subject files
const now = () => performance.now();
const collect = () => { if (typeof globalThis.gc === "function") { globalThis.gc(); globalThis.gc(); } };

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  return { n: samples.length, median: quantile(samples, 0.5), p95: quantile(samples, 0.95), max: Math.max(...samples) };
}

function timeEach(count, warmup, step) {
  const samples = [];
  for (let index = 0; index < warmup + count; index++) {
    const work = step(index), start = now();
    work();
    const elapsed = now() - start;
    if (index >= warmup) samples.push(elapsed);
  }
  return samples;
}

function typist(driver, target, beat) {
  let end = driver.length(target, beat, "audioText");
  return () => {
    const at = end++;
    return driver.prepare(target, { beat, field: "audioText", from: at, to: at, insert: [{ text: "x", marks: {} }] });
  };
}

function measure(job, driver) {
  if (job.kind === "size") {
    const hub = driver.create(job.document, 100, false), writers = [];
    for (let index = 0; index < job.writers; index++) writers.push(driver.clone(hub, index + 1, false));
    const fresh = driver.encode(hub).length;
    let current = null;
    for (const op of job.ops) {
      if (op.op === "turn") {
        if (current) driver.pull(hub, current);
        current = writers[op.writer];
        driver.pull(current, hub);
      } else driver.prepare(current, op)();
    }
    driver.pull(hub, current);
    const bytes = driver.encode(hub).length, text = driver.text(hub);
    const lone = driver.clone(hub, 200, false), next = typist(driver, lone, job.beat), before = driver.encode(lone).length;
    for (let index = 0; index < job.extra; index++) next()();
    return { fresh, bytes, text, extra: job.extra, extraBytes: driver.encode(lone).length - before };
  }
  if (job.kind === "typing") {
    const target = driver.create(job.document, 1, true), next = typist(driver, target, job.beat);
    for (let index = 0; index < job.pretype; index++) next()();
    collect();
    return summarize(timeEach(job.samples, job.warmup, next));
  }
  if (job.kind === "remote") {
    const base = driver.create(job.document, 1, false), sender = driver.clone(base, 2, false), receiver = driver.clone(base, 3, true);
    const take = driver.capture(sender), next = typist(driver, sender, job.beat), groups = [];
    for (let index = 0; index < job.warmup + job.samples; index++) { next()(); groups.push(take()); }
    collect();
    const result = summarize(timeEach(job.samples, job.warmup, index => () => { for (const update of groups[index]) driver.receive(receiver, update); }));
    const sizes = groups.map(group => group.reduce((sum, update) => sum + update.byteLength, 0));
    return { ...result, updatesPerKeystroke: quantile(groups.map(group => group.length), 0.5), updateBytes: quantile(sizes, 0.5) };
  }
  throw new Error("Unknown job " + job.kind);
}

export { measure };

if (process.argv[2] && process.argv[3]) {
  const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
  writeFileSync(process.argv[3], JSON.stringify(measure(job, subject)));
}
