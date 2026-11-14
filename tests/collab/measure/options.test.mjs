import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { admission, checkReferences } from "./options.mjs";
import { fixtures, open, writer } from "./run.mjs";
import { byteProbes } from "./bytes.mjs";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, observeSharedUpdates, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";

function invalidOrigin() {
  const encoder = new Y.UpdateEncoderV1();
  encoder.writeLen(1); encoder.writeLen(1); encoder.writeClient(7); encoder.writeLen(0);
  new Y.Item(Y.createID(7, 0), null, Y.createID(7, 5), null, null, "meta", "x", new Y.ContentAny([1])).write(encoder, 0);
  encoder.writeLen(0);
  return encoder.toUint8Array();
}

function invalidCycleAfterPrefix() {
  const encoder = new Y.UpdateEncoderV1();
  encoder.writeLen(1); encoder.writeLen(3); encoder.writeClient(7); encoder.writeLen(0);
  new Y.Item(Y.createID(7, 0), null, null, null, null, "meta", "prefix", new Y.ContentAny([1])).write(encoder, 0);
  new Y.Item(Y.createID(7, 1), null, Y.createID(7, 2), null, null, "meta", "cycle", new Y.ContentAny([2])).write(encoder, 0);
  new Y.Item(Y.createID(7, 2), null, Y.createID(7, 1), null, null, "meta", "cycle", new Y.ContentAny([3])).write(encoder, 0);
  encoder.writeLen(0);
  return encoder.toUint8Array();
}

test("encoded accounting retains birth records after deletion and separates undo writes", () => {
  const { probes } = byteProbes(false);
  for (const probe of Object.values(probes)) assert.equal(Object.values(probe.parts).reduce((sum, value) => sum + value, 0), probe.bytes);
  assert.deepEqual(probes.typed.changed.map(row => row.kind), ["ContentString", "ContentAny"]);
  assert.equal(probes.corrected.parts["markRecords:birth"], probes.typed.parts["markRecords:birth"]);
  assert.ok(probes.corrected.changed.some(row => row.kind === "ContentDeleted"));
  assert.ok(probes["bold-undo"].changed.some(row => row.key === "provenance"));
  assert.ok(probes["split-undo"].changed.some(row => row.key.startsWith("splitRetired:")));
});

test("all alternatives retain native text and birth records on causal text updates", () => {
  const sender = open(), updates = [], source = fixtures()[0];
  try {
    hydrateSharedDocument(sender, enterSharedDocument(globalThis.structuredClone(source.document)));
    const initial = encodeSharedState(sender), stop = observeSharedUpdates(sender, update => updates.push(update));
    const edit = writer(sender), address = { owner: source.document.rows[0].id, segment: "b:" + source.document.rows[0].id, field: "audioText" };
    for (let index = 0; index < 3; index++) edit.type(address, "x", false);
    stop();
    for (const mode of ["shadow", "batch", "decode", "references"]) {
      const live = open(initial), policy = admission(live, mode);
      try { policy.accept(updates); assert.deepEqual(encodeSharedState(live), encodeSharedState(sender)); }
      finally { policy.close(); destroySharedDocument(live); }
    }
  } finally { destroySharedDocument(sender); }
});

test("shadow follows local writes, isolates refusal, rebuilds and accepts subsequent updates", () => {
  const live = open(), sender = open(), policy = admission(live, "shadow");
  try {
    transactSharedDocument(live, "local-command", () => collabState(live).roots.meta.set("local", true));
    collabState(sender).doc.clientID = 7;
    Y.applyUpdate(collabState(sender).doc, encodeSharedState(live));
    const before = encodeSharedState(live);
    assert.throws(() => policy.accept([Uint8Array.of(255)]));
    assert.deepEqual(encodeSharedState(live), before);
    const vector = Y.encodeStateVector(collabState(sender).doc);
    transactSharedDocument(sender, "local-command", () => collabState(sender).roots.meta.set("remote", true));
    policy.accept([Y.encodeStateAsUpdate(collabState(sender).doc, vector)]);
    assert.deepEqual(encodeSharedState(live), encodeSharedState(sender));
  } finally { policy.close(); destroySharedDocument(live); destroySharedDocument(sender); }
});

test("positive decoded length alone does not prove integration; live-reference check catches absent origin", () => {
  const update = invalidOrigin(), live = open();
  try {
    const decoded = Y.decodeUpdate(update), before = encodeSharedState(live);
    assert.equal(decoded.structs[0].length, 1);
    assert.equal(checkReferences(collabState(live).doc, decoded), 1);
    assert.deepEqual(applySharedUpdate(live, update), { ok: false, reason: "invalid-update" });
    assert.deepEqual(encodeSharedState(live), before);
    for (const mode of ["shadow", "batch", "references"]) {
      const policy = admission(live, mode);
      try { assert.throws(() => policy.accept([update])); assert.deepEqual(encodeSharedState(live), before); }
      finally { policy.close(); }
    }
  } finally { destroySharedDocument(live); }
});

test("reference precheck refuses pending dependencies which the present trial deliberately accepts", () => {
  const sender = open(), live = open();
  try {
    collabState(sender).doc.clientID = 7;
    transactSharedDocument(sender, "local-command", () => collabState(sender).roots.meta.set("x", 1));
    const vector = Y.encodeStateVector(collabState(sender).doc);
    transactSharedDocument(sender, "local-command", () => collabState(sender).roots.meta.set("x", 2));
    const update = Y.encodeStateAsUpdate(collabState(sender).doc, vector);
    assert.equal(checkReferences(collabState(live).doc, Y.decodeUpdate(update)), 1);
    assert.deepEqual(applySharedUpdate(live, update), { ok: true });
    assert.equal(collabState(live).roots.meta.get("x"), undefined);
  } finally { destroySharedDocument(live); destroySharedDocument(sender); }
});

test("an incoming cycle passes reference presence but copy-free controls can leave a partially applied prefix", () => {
  const update = invalidCycleAfterPrefix();
  for (const mode of ["current", "shadow", "batch", "decode", "references"]) {
    const live = open(), before = encodeSharedState(live);
    try {
      assert.equal(checkReferences(collabState(live).doc, Y.decodeUpdate(update)), 0);
      if (mode === "current") assert.deepEqual(applySharedUpdate(live, update), { ok: false, reason: "invalid-update" });
      else {
        const policy = admission(live, mode);
        try { assert.throws(() => policy.accept([update])); }
        finally { policy.close(); }
      }
      if (mode === "decode" || mode === "references") assert.equal(collabState(live).roots.meta.get("prefix"), 1);
      else assert.deepEqual(encodeSharedState(live), before);
    } finally { destroySharedDocument(live); }
  }
});
