import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";
import * as Y from "yjs";
import { NativeReplica, nativeCopy, nativeRuns } from "./variant.ts";

const plain = delta => nativeRuns(delta).map(run => run.atom ? "￼" : run.text).join("");

const scheme = process.argv[4] === "act" ? "act" : "name";

const subject = {
  create(document, client, editor) {
    const replica = new NativeReplica(client, 0, scheme);
    replica.hydrate(document);
    if (!editor) replica.undo.destroy();
    return { replica, editor };
  },
  clone(source, client, editor) {
    const replica = nativeCopy(source.replica, client);
    if (!editor) replica.undo.destroy();
    return { replica, editor };
  },
  length(target, beat, field) {
    const cell = target.replica.cell(beat, field);
    return cell.end - cell.start;
  },
  prepare(target, op) {
    return () => {
      target.replica.splice(op.beat, op.field, op.from, op.to, op.insert);
      return target.replica.changes();
    };
  },
  capture(target) {
    let updates = [];
    target.replica.doc.on("update", (update, origin) => { if (origin !== "remote") updates.push(update); });
    return () => { const taken = updates; updates = []; return taken; };
  },
  receive(target, update) {
    Y.applyUpdate(target.replica.doc, update, "remote");
    const changes = target.replica.changes();
    assert.ok(changes.rows.length > 0);
    return changes;
  },
  pull(to, from) {
    Y.applyUpdate(to.replica.doc, Y.encodeStateAsUpdate(from.replica.doc, Y.encodeStateVector(to.replica.doc)), "remote");
    to.replica.changes();
  },
  encode(target) { return target.replica.encode(); },
  text(target) {
    target.replica.changes();
    return target.replica.blocks().filter(block => block.kind === "b").map(block => ({ id: block.id, audio: plain(block.delta),
      visual: plain(target.replica.visuals.get(block.id)?.toDelta() ?? []) }));
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
