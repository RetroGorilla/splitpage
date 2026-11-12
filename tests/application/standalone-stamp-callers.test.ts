import { test } from "node:test";
import assert from "node:assert/strict";
import type { StandaloneDocumentSession } from "../../src/application/session/document-session.ts";
import type { DocumentIdentityPorts } from "../../src/application/identity/ports.ts";
import type { FileSavingPorts } from "../../src/application/save/file-saving-ports.ts";
import type { SaveCompletionPorts } from "../../src/application/save/save-completion.ts";
import type { LiveDocumentPort } from "../../src/application/transitions/ports.ts";
import type { ProductionTagPorts } from "../../src/features/tags/ports.ts";
import type { stamping } from "../../src/bootstrap/wiring/ports/document.ts";
import { identifierMentions, liveSessionMembers, sourceModuleCount, standaloneTypeMentions, under } from "./session-caller-scan.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type SessionStamp = StandaloneDocumentSession["stamp"];

interface StampContracts {
  readonly sharedPort: Same<typeof stamping, Pick<StandaloneDocumentSession, "stamp">>;
  readonly registryHealing: Same<ProductionTagPorts["stamping"], Pick<StandaloneDocumentSession, "stamp">>;
  readonly idReassignment: Same<DocumentIdentityPorts["session"]["stampDocument"], SessionStamp>;
  readonly saveStamps: Same<Parameters<FileSavingPorts["document"]["stamp"]>, Parameters<SessionStamp>>;
  readonly saveCompletion: Same<SaveCompletionPorts["document"]["stamp"], FileSavingPorts["document"]["stamp"]>;
  readonly transitionsHoldNone: Same<Extract<keyof LiveDocumentPort, "stamp">, never>;
}

const NAMED: StampContracts = {
  sharedPort: true,
  registryHealing: true,
  idReassignment: true,
  saveStamps: true,
  saveCompletion: true,
  transitionsHoldNone: true
};

const STAMP_TYPES = {
  "application/identity/ports.ts": 1,
  "application/save/file-saving-ports.ts": 1,
  "bootstrap/wiring/ports/document.ts": 1,
  "features/tags/ports.ts": 1
};

const BRIDGE_FUNCTION = {
  "bootstrap/wiring/ports/document-identity.ts": 1,
  "bootstrap/wiring/ports/document.ts": 2,
  "bootstrap/wiring/session-owner.ts": 1
};

const SHARED_PORT = {
  "bootstrap/wiring/file-saving.ts": 2,
  "bootstrap/wiring/ports/document-identity.ts": 2,
  "bootstrap/wiring/ports/document.ts": 1,
  "bootstrap/wiring/production-tags.ts": 2
};

const STAMP_IN_WIRING = {
  "bootstrap/wiring.ts": 1,
  "bootstrap/wiring/file-saving.ts": 2,
  "bootstrap/wiring/ports/document-identity.ts": 1,
  "bootstrap/wiring/ports/document.ts": 1,
  "bootstrap/wiring/session-owner.ts": 4
};

const STAMP_BUILDERS = {
  "application/commands/save-stamps.ts": 3,
  "application/session/document-session.ts": 3,
  "bootstrap/wiring/session-owner.ts": 3,
  "features/tags/production-tags.ts": 2
};

test("the stamp scan reads the app's modules", () => {
  assert.ok(sourceModuleCount() > 500);
});

test("every port that carries the session's stamp names the standalone session", () => {
  assert.deepEqual(Object.keys(NAMED).sort(), ["idReassignment", "registryHealing", "saveCompletion", "saveStamps", "sharedPort", "transitionsHoldNone"]);
  assert.deepEqual(standaloneTypeMentions("stamp"), STAMP_TYPES);
});

test("the wiring reaches the session's stamp through one shared port with three audited users", () => {
  assert.deepEqual(under(identifierMentions("stampDocument"), "bootstrap/"), BRIDGE_FUNCTION);
  assert.deepEqual(under(identifierMentions("stamping"), "bootstrap/"), SHARED_PORT);
  assert.deepEqual(under(identifierMentions("stamp"), "bootstrap/"), STAMP_IN_WIRING);
  for (const [file, members] of Object.entries(liveSessionMembers())) assert.ok(!members.includes("stamp"), file);
});

test("the modules that can build a stamp are the audited four", () => {
  assert.deepEqual(identifierMentions("Stamp"), STAMP_BUILDERS);
});
