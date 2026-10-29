import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserDraftOrigin, desktopDraftOrigin, draftOriginSignature, draftPayloadFor, draftRefsFor, draftRefusal
} from "../../../src/application/recovery/draft-origin.ts";
import { SCHEMA_VERSION } from "../../../src/core/document/fields.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const ID = "d" + "c".repeat(32);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function doc(fields: Record<string, unknown> = {}) {
  return migrateRows({ title: "Pilot", docId: ID, rows: [{ id: "r1", audioText: "hi" }], ...fields }, fakeMigration().ports);
}

test("draft origin: a browser draft is a server copy only while it has a target", () => {
  assert.deepEqual(browserDraftOrigin(null), {
    kind: "untitled", fileId: null, fileKind: null, importName: null, baseLastModified: null, baseSize: null, server: null
  });
  const origin = browserDraftOrigin({ base: "https://s", docId: "doc1", rev: 3, copy: true });
  assert.equal(origin.kind, "server");
  assert.deepEqual(origin.server, { base: "https://s", docId: "doc1", rev: 3, copy: true });
});

test("draft origin: a desktop draft names its file, then its import, then nothing", () => {
  let importReads = 0;
  const imported = { kind: "import" as const, name: "notes.docx", lastModified: 7 };
  const importHome = () => { importReads++; return imported; };
  const file = { kind: "file" as const, handle: { _desktopId: "f1" }, format: "splitpage", lastModified: 5 };
  const fromFile = desktopDraftOrigin(file, importHome);
  assert.deepEqual([fromFile.kind, fromFile.fileId, fromFile.fileKind, fromFile.baseLastModified], ["file", "f1", "splitpage", 5]);
  assert.equal(importReads, 0);
  const fromImport = desktopDraftOrigin({ kind: "file", handle: {} }, importHome);
  assert.deepEqual([fromImport.kind, fromImport.importName, fromImport.baseLastModified, fromImport.fileId], ["import", "notes.docx", 7, null]);
  assert.equal(importReads, 1);
  assert.equal(desktopDraftOrigin(null, () => null).kind, "untitled");
  assert.equal(desktopDraftOrigin(null, () => ({ kind: "import" })).baseLastModified, null);
});

test("draft origin: the signature changes with the origin, the document id and whether the id was written out", () => {
  const untitled = browserDraftOrigin(null);
  const server = browserDraftOrigin({ base: "b", docId: "x", rev: 2, copy: false });
  assert.equal(draftOriginSignature(untitled, null, false), "untitled|||||" + "|0");
  assert.equal(draftOriginSignature(server, doc(), true), "server||||x@2@b|" + ID + "|1");
  assert.notEqual(draftOriginSignature(untitled, doc(), false), draftOriginSignature(untitled, doc(), true));
});

test("draft origin: the payload carries the capture, the origin and the schema", () => {
  const origin = desktopDraftOrigin({ kind: "file", handle: { _desktopId: "f1" }, format: "splitpage" }, () => null);
  const payload = draftPayloadFor({ seq: 4, editSeq: 9, doc: doc(), writtenOut: true, origin, stateJson: "{}", baseJson: null });
  assert.deepEqual(payload, {
    seq: 4, editSeq: 9, title: "Pilot", docId: ID, docIdWrittenOut: true, schema: SCHEMA_VERSION,
    originKind: "file", fileId: "f1", fileKind: "splitpage", importName: null, baseLastModified: null, baseSize: null,
    server: null, stateJson: "{}", baseJson: null
  });
  assert.deepEqual(Object.keys(payload), ["seq", "editSeq", "title", "docId", "docIdWrittenOut", "schema", "originKind", "fileId", "fileKind",
    "importName", "baseLastModified", "baseSize", "server", "stateJson", "baseJson"]);
  const bare = draftPayloadFor({ seq: 1, editSeq: 0, doc: doc({ title: "", docId: "not-an-id" }), writtenOut: false, origin, stateJson: "s", baseJson: "b" });
  assert.equal(bare.title, "");
  assert.equal(bare.baseJson, "b");
});

test("draft origin: the base's picture references join only when the base is sent", () => {
  const withImage = (sha: string) => ({ rows: [{ id: "r", imageRef: { sha256: sha } }] });
  const mine = doc();
  const mineRefs = draftRefsFor(mine, withImage(SHA_B), false);
  assert.equal(mineRefs.includes(SHA_B), false);
  const refs = draftRefsFor(mine, withImage(SHA_B), true);
  assert.ok(refs.includes(SHA_B));
  assert.deepEqual(draftRefsFor(mine, null, true), mineRefs);
  const both = draftRefsFor(doc(withImage(SHA_A)), withImage(SHA_A), true);
  assert.deepEqual(both, [SHA_A]);
});

test("draft origin: refusals stop, turn browser drafts off, pause, or just retry", () => {
  assert.equal(draftRefusal("DISCARDED", true), "stop");
  assert.equal(draftRefusal("NO_TAB", false), "stop");
  assert.equal(draftRefusal("UNAVAILABLE", false), "browser-off");
  assert.equal(draftRefusal("UNAVAILABLE", true), "pause");
  assert.equal(draftRefusal("ENOSPC", true), "pause");
  assert.equal(draftRefusal("STALE_SEQ", true), "retry");
});
