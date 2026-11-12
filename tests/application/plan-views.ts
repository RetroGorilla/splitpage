import assert from "node:assert/strict";
import type { Command, DocumentView, Plan } from "../../src/application/session/document-session.ts";
import type { CapabilityPort } from "../../src/application/session/ports.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migratedThenSet } from "../core/migrate-ports.ts";
import { createSessionCapabilities } from "../../src/application/session/capabilities.ts";

type Bag = Record<string, unknown>;

export const MAY_EDIT: CapabilityPort = createSessionCapabilities("standalone", {
  edit: function () { return { allowed: true }; },
  comment: function () { return { allowed: true }; }
});

export const REVIEW_ONLY: CapabilityPort = createSessionCapabilities("standalone", {
  edit: function () { return { allowed: false, reason: "review" }; },
  comment: function () { return { allowed: true }; }
});

export function rowsOf(ids: readonly string[], extra: Bag = {}): Bag[] {
  return ids.map(function (id) { return { id: id, visualText: "", audioText: "", status: "todo", ...extra }; });
}

export function docOf(fields: Bag): ValidatedDocument {
  return migratedThenSet({ title: "Plan", docId: "d" + "7".repeat(32), rows: [], comments: [], productionTags: [], brollShots: [], ...fields });
}

export function viewOf(fields: Bag): DocumentView {
  return docOf(fields);
}

export function liveOf(fields: Bag): ValidatedDocument {
  return docOf(fields);
}

export function planOf(command: Command, doc: DocumentView, capability: CapabilityPort = MAY_EDIT): Plan {
  const planned = command.plan(doc, capability);
  assert.ok(planned && !("refused" in planned), "expected " + command.name + " to plan an edit");
  return planned;
}

export function idsIn(doc: ValidatedDocument): string[] {
  return doc.rows.map(function (r) { return r.id; });
}
