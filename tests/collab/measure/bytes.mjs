import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import * as Y from "yjs";
import { fixtures, open, writer } from "./run.mjs";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { destroySharedDocument, encodeSharedState, observeSharedUpdates } from "../../../src/adapters/collab/document.ts";
import { isMain } from "../../../tools/main-module.mjs";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";

function pathOf(type, doc) {
  if (!type._item) return [...doc.share].find(([, value]) => value === type)?.[0] ?? "root";
  return pathOf(type._item.parent, doc) + "/" + (type._item.parentSub ?? "[]");
}

function ledger(handle) {
  const doc = collabState(handle).doc, rows = [];
  for (const structs of doc.store.clients.values()) for (const item of structs) {
    const encoder = new Y.UpdateEncoderV1(); item.write(encoder, 0);
    const payload = item instanceof Y.Item ? item.content.getContent() : [];
    const path = item instanceof Y.Item ? pathOf(item.parent, doc) : "GC";
    const kind = item instanceof Y.Item ? item.content.constructor.name : item.constructor.name;
    const record = payload[0];
    const category = path.endsWith("/markRecords") ? "markRecords:" + (record?.type ?? kind)
      : kind === "ContentString" ? "text" : kind === "ContentDeleted" || kind === "GC" ? "tombstones"
      : path + (item.parentSub ? "/" + item.parentSub : "");
    rows.push({ id: item.id.client + ":" + item.id.clock, length: item.length, kind, path,
      key: item.parentSub ?? null, category, bytes: encoder.toUint8Array().length,
      value: payload.map(value => value instanceof Y.AbstractType ? value.constructor.name : value) });
  }
  const binary = encodeSharedState(handle), decoded = Y.decodeUpdate(binary);
  assert.equal(decoded.structs.length, rows.length);
  return { bytes: binary.length, overhead: binary.length - rows.reduce((sum, row) => sum + row.bytes, 0), rows,
    decoded: decoded.structs.map(item => ({ id: item.id.client + ":" + item.id.clock, length: item.length,
      kind: item.content?.constructor.name ?? item.constructor.name,
      origin: item.origin, rightOrigin: item.rightOrigin, parent: item.parent, key: item.parentSub })),
    deletes: [...decoded.ds.clients] };
}

function difference(before, after) {
  const totals = state => {
    const result = { "envelope + delete set": state.overhead };
    for (const row of state.rows) result[row.category] = (result[row.category] ?? 0) + row.bytes;
    return result;
  };
  const a = totals(before), b = totals(after), parts = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const delta = (b[key] ?? 0) - (a[key] ?? 0); if (delta) parts[key] = delta;
  }
  assert.equal(Object.values(parts).reduce((sum, value) => sum + value, 0), after.bytes - before.bytes);
  const previous = new Map(before.rows.map(row => [row.id, row]));
  return { bytes: after.bytes - before.bytes, parts, changed: after.rows.filter(row => JSON.stringify(previous.get(row.id)) !== JSON.stringify(row)),
    decoded: after.decoded.filter(row => !previous.has(row.id)), deletes: after.deletes };
}

function anyBytes(value) {
  const encoder = new Y.UpdateEncoderV1(); encoder.writeAny(value); return encoder.toUint8Array().length;
}

function recode(binary, change) {
  const decoded = Y.decodeUpdate(binary), groups = new Map(), encoder = new Y.UpdateEncoderV1();
  for (const item of decoded.structs) {
    if (item.content instanceof Y.ContentAny) item.content.arr = item.content.arr.map(value => change(value, item));
    const group = groups.get(item.id.client) ?? [];
    group.push(item); groups.set(item.id.client, group);
  }
  encoder.writeLen(groups.size);
  for (const [client, items] of groups) {
    encoder.writeLen(items.length); encoder.writeClient(client); encoder.writeLen(items[0].id.clock);
    for (const item of items) item.write(encoder, 0);
  }
  encoder.writeLen(decoded.ds.clients.size);
  for (const [client, ranges] of decoded.ds.clients) {
    encoder.writeClient(client); encoder.writeLen(ranges.length);
    for (const range of ranges) { encoder.writeDsClock(range.clock); encoder.writeDsLen(range.len); }
  }
  const result = encoder.toUint8Array(), check = new Y.Doc(), verify = new Y.Doc();
  const payloads = binary => Y.decodeUpdate(binary).structs.map(item => ({ id: item.id, length: item.length,
    kind: item.content?.constructor.name ?? item.constructor.name,
    value: item.content instanceof Y.ContentType ? item.content.type.constructor.name : item.content?.getContent() ?? [] }));
  try {
    Y.applyUpdate(check, result);
    const canonical = Y.encodeStateAsUpdate(check);
    assert.deepEqual(payloads(canonical), payloads(result));
    Y.applyUpdate(verify, canonical); assert.deepEqual(Y.encodeStateAsUpdate(verify), canonical);
    return canonical;
  } finally { check.destroy(); verify.destroy(); }
}

function compactBirth(value, shape) {
  if (value?.type !== "birth") return value;
  const anchor = raw => {
    const parsed = JSON.parse(raw);
    return [parsed.target ?? parsed.segment, Uint8Array.from(parsed.relative)];
  };
  const start = anchor(value.start), end = anchor(value.end);
  return shape === "binary-anchors" ? { ...value, start, end }
    : [0, value.operation, value.writer, start, end, value.observed, [value.born.client, value.born.clock, value.born.length]];
}

function nativeMarkReferences(binary) {
  const identities = new Map();
  const location = item => item.parent instanceof Y.ID ? item.parent.client + ":" + item.parent.clock + "/" : null;
  for (const item of Y.decodeUpdate(binary).structs) {
    const value = item.content instanceof Y.ContentAny ? item.content.arr[0] : null, store = location(item);
    if (store && ["birth", "add", "remove"].includes(value?.type)) identities.set(store + item.parentSub, [item.id.client, item.id.clock]);
  }
  return recode(binary, (value, item) => {
    const store = location(item);
    if (!store || !["birth", "add", "remove"].includes(value?.type) || !Array.isArray(value.observed)) return value;
    return { ...value, observed: value.observed.map(reference => identities.get(store + reference) ?? reference) };
  });
}

export function byteProbes(includeVariants = true, prepared = null) {
  const source = fixtures()[0], address = { owner: source.document.rows[0].id, segment: "b:" + source.document.rows[0].id, field: "audioText" };
  const fresh = () => {
    const handle = open(); hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(source.document))); return handle;
  };
  const probes = {};
  for (const name of ["typed", "corrected", "undo-redo", "split", "bold", "long-author"]) {
    const handle = fresh(), edit = writer(handle, { by: name === "long-author" ? "A".repeat(100) : "Measurement" });
    try {
      let record, before = ledger(handle);
      if (name === "typed" || name === "corrected" || name === "undo-redo" || name === "long-author") {
        record = edit.type(address, "x");
        if (name === "undo-redo") before = ledger(handle);
        if (name === "corrected") edit.command({ kind: "text-delete", target: address,
          observed: edit.history(address).units.slice(-1).map(unit => unit.identity) });
        if (name === "undo-redo") edit.reverse(edit.reverse(record));
      } else if (name === "split") record = edit.command({ kind: "split", target: address, at: edit.gap(address, 2), observed: [], boundary: "boundary0", beat: "beat0", fields: {} });
      else record = edit.command({ kind: "mark", target: address,
        observed: edit.history(address).units.slice(0, 2).map(unit => unit.identity), mark: { kind: "b", value: true } });
      const after = ledger(handle);
      probes[name] = difference(before, after);
      if (name === "typed") {
        const birth = probes[name].changed.find(row => row.category === "markRecords:birth"), value = birth.value[0];
        const fields = Object.fromEntries(Object.keys(value).map(key => {
          const without = { ...value }; delete without[key]; return [key, anyBytes(value) - anyBytes(without)];
        }));
        probes[name].birthFields = fields;
        probes[name].birthObjectBytes = anyBytes(value);
        probes[name].birthFramingBytes = birth.bytes - anyBytes(value);
      }
      if (name === "split" || name === "bold") {
        edit.reverse(record); probes[name + "-undo"] = difference(after, ledger(handle));
      }
    } finally { destroySharedDocument(handle); }
  }
  if (!includeVariants) return { node: process.version, probes, variants: [] };
  const variants = [];
  let typedState, typedBefore;
  for (const count of [1, 10, 100, 1000]) {
    const handle = fresh(), edit = writer(handle), before = encodeSharedState(handle).length;
    collabState(handle).doc.clientID = 0x81234569;
    try {
      if (count === 1 && prepared) {
        assert.deepEqual(Buffer.from(encodeSharedState(handle)), Buffer.from(prepared.states.find(row => row.name === "short").fresh, "base64"));
        typedState = Buffer.from(prepared.streams.short.final, "base64"); typedBefore = before;
        variants.push({ shape: "real insertion run 1", bytes: typedState.length - before });
        continue;
      }
      for (let i = 0; i < 1000; i += count) edit.type(address, "x".repeat(count), false);
      variants.push({ shape: "real insertion run " + count, bytes: encodeSharedState(handle).length - before });
      if (count === 1) { typedState = encodeSharedState(handle); typedBefore = before; }
    } finally { destroySharedDocument(handle); }
  }
  for (const shape of ["binary-anchors", "tuple-record", "current-writer-id", "36-character-id-prefix"]) {
    const encoded = recode(typedState, (value, item) => {
      if (value?.type !== "birth") return value;
      if (shape === "36-character-id-prefix" || shape === "current-writer-id") {
        const operation = JSON.parse(value.operation);
        operation[1] = (shape === "current-writer-id" ? "w" + value.writer + "_" : "m".repeat(36)) + operation[1].slice(1);
        const id = JSON.stringify(operation); item.parentSub = JSON.stringify([value.writer, id]);
        return { ...value, operation: id };
      }
      return compactBirth(value, shape);
    });
    variants.push({ shape, bytes: encoded.length - typedBefore });
  }
  {
    const handle = fresh(), edit = writer(handle);
    try {
      let record = edit.type(address, "x");
      const before = encodeSharedState(handle).length;
      for (let pair = 1; pair <= 100; pair++) {
        record = edit.reverse(edit.reverse(record));
        if ([1, 10, 100].includes(pair)) variants.push({ shape: pair + " undo-redo pairs", bytes: encodeSharedState(handle).length - before });
      }
    } finally { destroySharedDocument(handle); }
  }
  for (const shape of ["native-text", "compact-birth", "compact-birth-no-observed", "stamps", "typed-with-stamps"]) {
    const handle = fresh(), doc = collabState(handle).doc, edit = writer(handle);
    doc.clientID = 0x81234569;
    const segment = collabState(handle).roots.segments.get(address.segment), text = segment.get("text"), marks = segment.get("markRecords");
    const before = encodeSharedState(handle).length;
    try {
      for (let i = 0; i < 1000; i++) {
        if (shape === "stamps" || shape === "typed-with-stamps") {
          if (shape === "typed-with-stamps") edit.type(address, "x", false);
          const operation = readOperation({ kind: "scalar", id: "stamp" + i, by: "Measurement",
            target: { scope: "beat", record: address.owner }, field: "stamp",
            value: { at: new Date(1700000000000 + i).toISOString(), by: "Measurement" } });
          assert.ok(operation); assert.deepEqual(executeSharedOperations(handle, [operation]), { ok: true });
        }
        else doc.transact(() => {
          const clock = Y.getState(doc.store, doc.clientID);
          text.insert(text.length, "x");
          if (shape !== "native-text") marks.set(JSON.stringify([doc.clientID, i]), shape === "compact-birth"
            ? [clock, 1, []] : [clock, 1]);
        });
      }
      variants.push({ shape, bytes: encodeSharedState(handle).length - before });
    } finally { destroySharedDocument(handle); }
  }
  return { node: process.version, probes, variants };
}

function editedLocalProbes(checkpoint) {
  return checkpoint.states.map(row => {
    const binary = Buffer.from(row.edited, "base64"), handle = open(binary), updates = [];
    const source = fixtures().find(fixture => fixture.name === row.name), owner = source.document.rows[0].id;
    const stop = observeSharedUpdates(handle, update => updates.push(update));
    try {
      const before = encodeSharedState(handle).length;
      writer(handle).type({ owner, segment: "b:" + owner, field: "audioText" }, "x", false);
      const structs = updates.flatMap(update => Y.decodeUpdate(update).structs);
      const births = structs.flatMap(item => item.content instanceof Y.ContentAny ? item.content.arr : []).filter(value => value?.type === "birth");
      const nativeBefore = nativeMarkReferences(binary), nativeAfter = nativeMarkReferences(encodeSharedState(handle));
      return { name: row.name, bytes: encodeSharedState(handle).length - before,
        observed: births.map(value => value.observed.length), births,
        editedBytes: binary.length, editedBinaryAnchors: recode(binary, value => compactBirth(value, "binary-anchors")).length,
        editedTupleRecords: recode(binary, value => compactBirth(value, "tuple-record")).length,
        editedNativeReferences: nativeBefore.length, localKeyNativeReferences: nativeAfter.length - nativeBefore.length,
        editedTupleAndNativeReferences: recode(nativeBefore, value => compactBirth(value, "tuple-record")).length };
    } finally { stop(); destroySharedDocument(handle); }
  });
}

if (isMain(import.meta.url)) {
  assert.equal(process.versions.node, "24.22.1");
  const args = process.argv.slice(2), filenames = args.filter(value => value !== "--small");
  const checkpoint = filenames[1] ? JSON.parse(readFileSync(filenames[1], "utf8")) : null;
  const result = byteProbes(!args.includes("--small"), checkpoint), output = filenames[0];
  if (checkpoint) result.editedLocal = editedLocalProbes(checkpoint);
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
