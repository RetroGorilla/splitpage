import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocumentView } from "../../src/application/session/document-session.ts";
import type { DocumentReader } from "../../src/application/session/document-reader.ts";
import type { LiveDocumentPort } from "../../src/application/transitions/ports.ts";
import type { RecordsReconcilerPorts } from "../../src/application/production/broll-records.ts";
import type { LocalWorkPorts } from "../../src/application/recovery/stashed-work.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import type { BeatClipPorts } from "../../src/features/clipboard/ports.ts";
import type { insertBeats } from "../../src/features/clipboard/beat-clip.ts";
import type { documentReader } from "../../src/bootstrap/wiring/ports/document.ts";
import type { currentDocument, liveDocumentPort } from "../../src/bootstrap/wiring/session-owner.ts";
import { identifierMentions, sourceModuleCount, under } from "./session-caller-scan.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

interface ReadContracts {
  readonly sharedReaderGivesAView: Same<ReturnType<typeof documentReader["current"]>, DocumentView | null>;
  readonly transitionsReadAView: Same<LiveDocumentPort["current"], DocumentReader["current"]>;
  readonly bridgePortReadsAView: Same<ReturnType<typeof liveDocumentPort["current"]>, DocumentView | null>;
  readonly beatClipHasNoReader: Same<Extract<keyof BeatClipPorts, "document">, never>;
  readonly beatInsertWritesTheGivenDocument: Same<Parameters<typeof insertBeats>[1]["state"], ValidatedDocument>;
}

interface StandaloneWritableReads {
  readonly bridgeFunction: Same<ReturnType<typeof currentDocument>, ValidatedDocument | null>;
  readonly brollRecordsViewed: Same<RecordsReconcilerPorts["viewed"], () => ValidatedDocument | null>;
  readonly localWorkStash: Same<LocalWorkPorts<ValidatedDocument>["current"], () => ValidatedDocument | null>;
}

const NAMED: ReadContracts = {
  sharedReaderGivesAView: true,
  transitionsReadAView: true,
  bridgePortReadsAView: true,
  beatClipHasNoReader: true,
  beatInsertWritesTheGivenDocument: true
};

const LEFT: StandaloneWritableReads = {
  bridgeFunction: true,
  brollRecordsViewed: true,
  localWorkStash: true
};

const BRIDGE_FUNCTION = {
  "bootstrap/wiring/broll.ts": 3,
  "bootstrap/wiring/desktop-owners.ts": 2,
  "bootstrap/wiring/document-identity.ts": 2,
  "bootstrap/wiring/editor.ts": 6,
  "bootstrap/wiring/panels.ts": 4,
  "bootstrap/wiring/ports/document-identity.ts": 2,
  "bootstrap/wiring/ports/document.ts": 2,
  "bootstrap/wiring/ports/person-colors.ts": 2,
  "bootstrap/wiring/ports/shot-hiding.ts": 2,
  "bootstrap/wiring/recovery-owners.ts": 2,
  "bootstrap/wiring/session-owner.ts": 3,
  "bootstrap/wiring/shot-hiding.ts": 2
};

const BEAT_INSERTS = {
  "core/flow/flow.ts": 5,
  "features/clipboard/beat-clip.ts": 3,
  "features/clipboard/flow-clip.ts": 2
};

test("the writable-read scan reads the app's modules", () => {
  assert.ok(sourceModuleCount() > 500);
});

test("the shared document reader and the transitions' live port hand out the read-only view", () => {
  assert.deepEqual(Object.keys(NAMED).sort(), ["beatClipHasNoReader", "beatInsertWritesTheGivenDocument", "bridgePortReadsAView", "sharedReaderGivesAView", "transitionsReadAView"]);
});

test("the writable reads left are the bridge function and the two standalone owners that take it", () => {
  assert.deepEqual(Object.keys(LEFT).sort(), ["bridgeFunction", "brollRecordsViewed", "localWorkStash"]);
  assert.deepEqual(under(identifierMentions("currentDocument"), "bootstrap/"), BRIDGE_FUNCTION);
});

test("the beat clipboard's insert, which writes into the document it is handed, is called from the audited app modules only", () => {
  assert.deepEqual(identifierMentions("insertBeats"), BEAT_INSERTS);
});
