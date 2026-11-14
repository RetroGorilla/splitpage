import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommonDocumentSession, StandaloneDocumentSession } from "../../src/application/session/document-session.ts";
import type { UndoPorts } from "../../src/application/editing/undo/undo.ts";
import type { RecordsReconcilerPorts } from "../../src/application/production/broll-records.ts";
import type { ProjectFilesPorts } from "../../src/application/save/project-files.ts";
import type { SessionMergeSession } from "../../src/application/session/session-merge-ports.ts";
import type { heldDocument } from "../../src/bootstrap/wiring/session-owner.ts";
import { identifierMentions, liveSessionMembers, sourceModuleCount, standaloneTypeMentions, under } from "./session-caller-scan.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type SessionHeld = StandaloneDocumentSession["held"];

interface HeldContracts {
  readonly bridgeAccessor: Same<typeof heldDocument, SessionHeld>;
  readonly brollRecords: Same<RecordsReconcilerPorts["held"], SessionHeld>;
  readonly undoOwner: Same<UndoPorts["held"], SessionHeld>;
  readonly projectFiles: Same<ProjectFilesPorts["heldDocument"], SessionHeld>;
  readonly sessionMerge: Same<SessionMergeSession["held"], SessionHeld>;
  readonly commonHasNoHeld: Same<Extract<keyof CommonDocumentSession, "held">, never>;
}

const NAMED: HeldContracts = {
  bridgeAccessor: true,
  brollRecords: true,
  undoOwner: true,
  projectFiles: true,
  sessionMerge: true,
  commonHasNoHeld: true
};

const HELD_TYPES = {
  "application/editing/undo/undo.ts": 1,
  "application/production/broll-records.ts": 1,
  "application/save/project-files.ts": 1,
  "application/session/session-merge-ports.ts": 1
};

const BROLL_AND_UNDO = {
  "bootstrap/wiring/broll.ts": 2,
  "bootstrap/wiring/undo.ts": 2
};

const TRANSITIONS_AND_MERGE = {
  "bootstrap/wiring/ports/project-files.ts": 2,
  "bootstrap/wiring/ports/session-merge.ts": 2,
  "bootstrap/wiring/startup.ts": 2
};

const BRIDGE = {
  "bootstrap/wiring/session-owner.ts": 1
};

const OWNER_ALIASES = {
  "application/save/project-files.ts": 2,
  "application/session/session-merge.ts": 2
};

const HELD_IN_WIRING = {
  "bootstrap/wiring/broll.ts": 1,
  "bootstrap/wiring/ports/session-merge.ts": 1,
  "bootstrap/wiring/session-owner.ts": 4,
  "bootstrap/wiring/undo.ts": 1
};

const HELD_IN_OWNERS = {
  "application/editing/undo/undo.ts": 14,
  "application/production/broll-records.ts": 2
};

test("the held scan reads the app's modules", () => {
  assert.ok(sourceModuleCount() > 500);
});

test("every port that carries the session's held document names the standalone session", () => {
  assert.deepEqual(Object.keys(NAMED).sort(), ["bridgeAccessor", "brollRecords", "commonHasNoHeld", "projectFiles", "sessionMerge", "undoOwner"]);
  assert.deepEqual(standaloneTypeMentions("held"), HELD_TYPES);
});

test("the wiring modules that take the held document are the b-roll and undo wiring and the audited transition and merge ports", () => {
  assert.deepEqual(under(identifierMentions("heldDocument"), "bootstrap/"), { ...BROLL_AND_UNDO, ...TRANSITIONS_AND_MERGE, ...BRIDGE });
  assert.deepEqual(under(identifierMentions("held"), "bootstrap/"), HELD_IN_WIRING);
  for (const [file, members] of Object.entries(liveSessionMembers())) assert.ok(!members.includes("held"), file);
});

test("outside the wiring only the two standalone owners and the two audited aliases reach the held document, and no feature or adapter does", () => {
  const held = identifierMentions("held");
  assert.deepEqual(Object.fromEntries(Object.keys(HELD_IN_OWNERS).map(function (file) { return [file, held[file]]; })), HELD_IN_OWNERS);
  assert.deepEqual(under(identifierMentions("heldDocument"), "application/"), OWNER_ALIASES);
  assert.deepEqual(under(identifierMentions("heldDocument"), "features/"), {});
  assert.deepEqual(under(identifierMentions("heldDocument"), "adapters/"), {});
  assert.deepEqual(under(identifierMentions("heldDocument"), "core/"), {});
});
