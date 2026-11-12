import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommonDocumentSession, StandaloneDocumentSession } from "../../src/application/session/document-session.ts";
import type { ImportDialogPorts } from "../../src/features/imports/ports.ts";
import type { legacyEdit } from "../../src/bootstrap/wiring/ports/document.ts";
import { identifierMentions, liveSessionMembers, sourceModuleCount, standaloneTypeMentions, under } from "./session-caller-scan.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

interface NoteEditContracts {
  readonly sharedPort: Same<typeof legacyEdit, Pick<StandaloneDocumentSession, "noteEdit">>;
  readonly newDocumentImport: Same<ImportDialogPorts["noteEdit"], StandaloneDocumentSession["noteEdit"]>;
  readonly commonHasNoNoteEdit: Same<Extract<keyof CommonDocumentSession, "noteEdit">, never>;
}

const NAMED: NoteEditContracts = {
  sharedPort: true,
  newDocumentImport: true,
  commonHasNoNoteEdit: true
};

const NOTE_EDIT_TYPES = {
  "bootstrap/wiring/ports/document.ts": 1,
  "features/imports/ports.ts": 1
};

const BRIDGE_FUNCTION = {
  "bootstrap/wiring/ports/document.ts": 2,
  "bootstrap/wiring/session-owner.ts": 1
};

const SHARED_PORT = {
  "bootstrap/wiring/desktop.ts": 2,
  "bootstrap/wiring/imports.ts": 2,
  "bootstrap/wiring/ports/document.ts": 1
};

const IMPORT_DIALOG_WRAPPER = {
  "features/imports/imports.ts": 2
};

const NOTE_EDIT = {
  "application/editing/undo/undo.ts": 4,
  "application/session/document-session.ts": 2,
  "bootstrap/wiring/desktop.ts": 1,
  "bootstrap/wiring/imports.ts": 2,
  "bootstrap/wiring/ports/document.ts": 1,
  "bootstrap/wiring/session-owner.ts": 3,
  "bootstrap/wiring/undo.ts": 1,
  "features/imports/imports.ts": 1,
  "features/imports/ports.ts": 1
};

test("the noteEdit scan reads the app's modules", () => {
  assert.ok(sourceModuleCount() > 500);
});

test("every port that carries the session's noteEdit names the standalone session", () => {
  assert.deepEqual(Object.keys(NAMED).sort(), ["commonHasNoNoteEdit", "newDocumentImport", "sharedPort"]);
  assert.deepEqual(standaloneTypeMentions("noteEdit"), NOTE_EDIT_TYPES);
});

test("the wiring reaches the session's noteEdit through one shared port, used by the new-document import and one test hook", () => {
  assert.deepEqual(under(identifierMentions("noteSessionEdit"), "bootstrap/"), BRIDGE_FUNCTION);
  assert.deepEqual(identifierMentions("legacyEdit"), SHARED_PORT);
  for (const [file, members] of Object.entries(liveSessionMembers())) assert.ok(!members.includes("noteEdit"), file);
});

test("the modules that mention noteEdit are the audited ones, and the import dialog is the only feature among them", () => {
  assert.deepEqual(identifierMentions("noteEdit"), NOTE_EDIT);
  assert.deepEqual(under(identifierMentions("noteSessionEdit"), "features/"), IMPORT_DIALOG_WRAPPER);
  assert.deepEqual(Object.keys(under(identifierMentions("noteEdit"), "features/")), ["features/imports/imports.ts", "features/imports/ports.ts"]);
  assert.deepEqual(under(identifierMentions("noteEdit"), "adapters/"), {});
});
