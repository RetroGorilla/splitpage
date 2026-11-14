import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { Buffer } from "node:buffer";
import * as Y from "yjs";
import { apply, fixtures, quantile, restoreCheckpoint, saveCheckpoint, scaleFixture, summary, writer } from "./run.mjs";
import { enterSharedDocument } from "../../../../src/core/migrate.ts";
import { createSharedDocument, encodeSharedState, destroySharedDocument, observeSharedUpdates } from "../../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../../src/adapters/collab/state.ts";
import { registerSharedTextOperationHandlers } from "../../../../src/adapters/collab/text-executor.ts";
import { projectSharedDocument } from "../../../../src/adapters/collab/project.ts";
import { readSharedTextHistory } from "../../../../src/adapters/collab/text-history.ts";

test("nearest-rank percentiles and cross-run medians keep tails and outliers", () => {
  const samples = Array.from({ length: 500 }, (_, index) => 500 - index);
  assert.equal(quantile(samples, 0.5), 250);
  assert.equal(quantile(samples, 0.95), 475);
  assert.equal(summary([5, 1, 100, 3, 2]), "3.00 [1.00–100.00]");
  assert.equal(summary([1, 2, 3, 4]), "2.50 [1.00–4.00]");
});

test("checkpoint round trips binary updates and refuses a changed source or runtime", () => {
  const checkpoint = { fingerprint: "source", result: { node: process.version, arch: process.arch, admission: [{ runs: [1] }] },
    states: [{ fresh: Buffer.from([0, 255]), edited: Buffer.from([128, 1]) }],
    streams: { "short/fresh": { updates: [Buffer.from([1, 254])], final: Buffer.from([2, 3]) } } };
  const saved = JSON.parse(JSON.stringify(saveCheckpoint(checkpoint)));
  assert.deepEqual(restoreCheckpoint(saved, "source"), checkpoint);
  assert.throws(() => restoreCheckpoint(saved, "other"), /source differs/);
  assert.throws(() => restoreCheckpoint({ ...saved, result: { ...saved.result, node: "other" } }, "source"), /Node version/);
  assert.throws(() => restoreCheckpoint({ ...saved, result: { ...saved.result, arch: "other" } }, "source"), /architecture/);
});

test("Stage 0 fixtures and scale rule preserve references and registry counts", () => {
  const all = fixtures();
  assert.deepEqual(all.map(row => [row.name, row.plain, row.document.rows.length, row.document.comments.length]),
    [["short", 1734, 2, 1], ["long", 38432, 30, 4], ["large", 334208, 300, 40]]);
  assert.equal(all[2].document.people.length, 2);
  assert.equal(all[2].document.productionTags.length, 31);
  const source = { rows: [{ id: "r", audioText: '<span data-cmt="c">x</span>', visualText: '<span data-broll-id="s">y</span>' }],
    comments: [{ id: "c", rowId: "r", anchorId: "c" }], brollShots: [{ id: "s" }] };
  const result = scaleFixture(source, 2);
  assert.equal(result.rows[1].audioText, '<span data-cmt="c-1">x</span>');
  assert.equal(result.rows[1].visualText, '<span data-broll-id="s-1">y</span>');
  assert.deepEqual(result.comments[1], { id: "c-1", rowId: "r-1", anchorId: "c-1" });
  assert.equal(result.brollShots[1].id, "s-1");
  assert.equal(source.rows.length, 1);
});

test("admission controls apply identical causal updates and a failed batch leaves live state intact", () => {
  const sender = createSharedDocument(), updates = [];
  try {
    collabState(sender).doc.clientID = 123456789;
    hydrateSharedDocument(sender, enterSharedDocument(globalThis.structuredClone(fixtures()[0].document)));
    registerSharedTextOperationHandlers(sender);
    const initial = encodeSharedState(sender), stop = observeSharedUpdates(sender, update => updates.push(update));
    const edit = writer(sender), address = { owner: "r1", segment: "b:r1", field: "audioText" };
    for (let index = 0; index < 3; index++) edit.type(address, "x");
    stop();
    assert.equal(updates.length, 3);
    assert.ok(projectSharedDocument(sender).rows[0].audioText.endsWith("xxx"));
    const uncaptured = createSharedDocument();
    try {
      Y.applyUpdate(collabState(uncaptured).doc, initial);
      collabState(uncaptured).doc.clientID = 123456789;
      registerSharedTextOperationHandlers(uncaptured);
      const directCommands = writer(uncaptured);
      for (let index = 0; index < 3; index++) directCommands.type(address, "x", false);
      assert.deepEqual(encodeSharedState(uncaptured), encodeSharedState(sender));
    } finally { destroySharedDocument(uncaptured); }
    const grouped = createSharedDocument();
    try {
      Y.applyUpdate(collabState(grouped).doc, initial);
      collabState(grouped).doc.clientID = 123456789;
      registerSharedTextOperationHandlers(grouped);
      writer(grouped).typeBatch(address, 3);
      assert.deepEqual(projectSharedDocument(grouped), projectSharedDocument(sender));
      assert.equal(readSharedTextHistory(grouped, address).records.filter(entry => entry.record.type === "birth").length, 3);
      assert.equal(encodeSharedState(grouped).length - encodeSharedState(sender).length, 12);
    } finally { destroySharedDocument(grouped); }
    for (const mode of ["current", "direct", "decode", "batch"]) {
      const receiver = createSharedDocument();
      try {
        Y.applyUpdate(collabState(receiver).doc, initial);
        apply(receiver, updates, mode);
        assert.deepEqual(encodeSharedState(receiver), encodeSharedState(sender), mode);
      } finally { destroySharedDocument(receiver); }
    }
    const edited = createSharedDocument();
    let editedState, expected;
    try {
      Y.applyUpdate(collabState(edited).doc, initial);
      registerSharedTextOperationHandlers(edited);
      const local = writer(edited);
      local.type(address, "y");
      local.command({ kind: "text-delete", target: address, observed: local.history(address).units.slice(-1).map(unit => unit.identity) });
      editedState = encodeSharedState(edited);
      apply(edited, updates, "direct");
      expected = encodeSharedState(edited);
      assert.deepEqual(projectSharedDocument(edited), projectSharedDocument(sender));
    } finally { destroySharedDocument(edited); }
    for (const mode of ["current", "direct", "decode", "batch"]) {
      const receiver = createSharedDocument();
      try {
        Y.applyUpdate(collabState(receiver).doc, editedState);
        apply(receiver, updates, mode);
        assert.deepEqual(encodeSharedState(receiver), expected, "stale peer: " + mode);
      } finally { destroySharedDocument(receiver); }
    }
    const receiver = createSharedDocument();
    try {
      Y.applyUpdate(collabState(receiver).doc, initial);
      assert.throws(() => apply(receiver, [updates[0], Uint8Array.of(255)], "batch"));
      assert.deepEqual(encodeSharedState(receiver), initial);
    } finally { destroySharedDocument(receiver); }
  } finally { destroySharedDocument(sender); }
});
