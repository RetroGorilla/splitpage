import { test } from "node:test";
import assert from "node:assert/strict";
import { commitWriterInventory } from "./commit-writer-scan.ts";
import type { WriterInventory, WriterScanRules } from "./commit-writer-scan.ts";
import { typedStandaloneInventory } from "./session-caller-scan.ts";

const RULES: WriterScanRules = {
  owners: ["application/session/document-session.ts", "application/session/shared-session.ts"],
  fields: ["updatedAt", "updatedBy", "createdAt", "resolvedAt", "resolvedBy", "rev", "lastEditedAt", "lastEditedBy"],
  assigned: ["personColors", "rowId", "field"],
  collections: ["productionTags", "brollShots", "people", "comments"],
  engines: [
    "adapters/production/broll-anchors.ts#anchorBrollInRows",
    "application/production/broll-records.ts#recordPastedBroll",
    "application/session/document-session.ts#AttributionPort.attribute",
    "application/session/document-session.ts#Plan.shared",
    "application/session/ports.ts#ReconcilePort.anchors",
    "application/session/ports.ts#ReconcilePort.records",
    "application/session/shared-session.ts#ReplicaPort.execute",
    "core/document/person-colors.ts#colorsWithMine",
    "core/production/broll.ts#applyBrollRecords",
    "core/production/broll.ts#planBrollAnchors",
    "core/production/broll.ts#planBrollRecords",
    "core/production/index.ts#ProductionIndexOwner.recordsPlan",
    "core/production/owners.ts#applyOwnerSync",
    "core/production/owners.ts#planOwnerSync",
    "core/production/records.ts#addBrollRecord",
    "core/production/records.ts#addPerson",
    "core/production/records.ts#addRegistryTag",
    "core/production/tags.ts#planRegistryHealing",
    "core/text/anchors.ts#syncCommentAnchors"
  ]
};

type Family = "attribution" | "records" | "anchors" | "other";
type Shared = "derivation" | "operation" | "not applicable" | "undetermined";

interface Writer {
  readonly family: Family;
  readonly shared: Shared;
  readonly reason: string;
}

const WRITERS = {
  "beat-stamp": {
    family: "attribution", shared: "operation",
    reason: "A command that changes a beat writes who and when (updatedAt, updatedBy). Shared: one scalar `stamp` {at, by} for that beat in the command's list, or the fields of the operation that creates the beat; once per typing group (decided 2026-11-09)."
  },
  "beat-stamp-read": {
    family: "attribution", shared: "derivation",
    reason: "The projection turns the stored `stamp` into updatedAt and updatedBy."
  },
  "undo-stamp": {
    family: "attribution", shared: "undetermined",
    reason: "Undo and redo stamp every beat they change with the person and time of the undo. No rule says whether a shared undo stamps, puts the earlier stamp back or leaves the stamp alone."
  },
  "comment-stamp": {
    family: "attribution", shared: "operation",
    reason: "Who and when on a comment or reply (createdAt, updatedAt, the resolution) are fields of the comment command's own record operations; a later resolve or reopen wins (decided)."
  },
  "save-stamp": {
    family: "attribution", shared: "not applicable",
    reason: "rev, lastEditedBy and lastEditedAt after a confirmed save. Decided 2026-11-09: written only on export; file saving is disabled in a shared session."
  },
  "capture-read": {
    family: "attribution", shared: "derivation",
    reason: "The projection shows the revision hydration retained, or 0; nothing writes it during a session."
  },
  "person-colour": {
    family: "attribution", shared: "undetermined",
    reason: "Every commit adds the editor's colour to personColors when it is missing or different. No rule says how one person's colour reaches the other copies."
  },
  "record-stated": {
    family: "records", shared: "operation",
    reason: "A record the command's caller asked for: created, changed or removed by the command's own record operations."
  },
  "record-with-text": {
    family: "records", shared: "operation",
    reason: "Tags, shots, people and comments that arrive with typed or pasted text, named by the caller: record-create operations in the same list as the text."
  },
  "tag-from-text": {
    family: "records", shared: "operation",
    reason: "A tag found in text with no registry entry gets one. Shared: record-create by the copy whose command introduced the tag; a tag without an entry projects untagged and is never registered on receipt."
  },
  "cue-retitle": {
    family: "records", shared: "undetermined",
    reason: "A sound cue's registry entry is renamed when its cue text is edited, found by comparing this copy's text before and after. No rule says whether a cue entry follows its text or is renamed by an operation."
  },
  "shot-from-line": {
    family: "records", shared: "operation",
    reason: "A B-roll line with no shot gets one, seeded from its beat. Shared: record-create by the copy that typed or pasted the line, with the id of its key."
  },
  "shot-name-from-line": {
    family: "records", shared: "derivation",
    reason: "A shot's name and description follow its B-roll line. Shared: derived from the line while its key is in the text; the stored name is the fallback once the line is gone (record handlers: stored fallback names are retained)."
  },
  "person-from-name": {
    family: "records", shared: "operation",
    reason: "An @Name with no person record gets one. Shared: record-create by the copy that typed it; the same new name typed on two copies gives two people, a declared merged-state limit."
  },
  "owner-from-name": {
    family: "records", shared: "undetermined",
    reason: "A tag's owner is set when an @Name is paired with it on a line and cleared when the last pairing goes, by comparing this copy's text before and after. No rule says whether an owner follows the text or is set by an operation."
  },
  "broll-key": {
    family: "records", shared: "operation",
    reason: "An unkeyed B-roll marker is given an id by rewriting its text: a command of its own, with text operations. A repeated key is settled by the projection (assumed rules 14 and 15)."
  },
  "registry-heal-on-draw": {
    family: "records", shared: "not applicable",
    reason: "The tags panel registers missing entries through the stamp door when it draws. A shared session has no stamp door and writes nothing on drawing or on receipt."
  },
  "anchor-repair": {
    family: "anchors", shared: "derivation",
    reason: "A comment's rowId and field follow its mark. Shared: derived in the shared assembly from the comment marks; the stored value is the last known place of a comment whose words are gone."
  },
  "stated-write": {
    family: "other", shared: "operation",
    reason: "The command's own write: its field name or its content is the command's argument."
  },
  "shared-execute": {
    family: "other", shared: "operation",
    reason: "The one write into shared state: the command's operation list, passed unchanged."
  },
  "paragraph-start": {
    family: "other", shared: "undetermined",
    reason: "Opening the Writer on a script whose paragraphs were never decided marks sentence paragraphs through the amend door. No rule says whether undecided paragraphs are derived or written by the first copy that opens the Writer."
  },
  "standalone-door": {
    family: "other", shared: "not applicable",
    reason: "adopt, absorb, replay, amend, stamp and noteEdit are members of the standalone session only; a shared session has none of them."
  },
  "document-id": {
    family: "other", shared: "not applicable",
    reason: "A shared instance's docId is set at hydration and never reassigned."
  },
  "file-entry": {
    family: "other", shared: "not applicable",
    reason: "Load and import repairs. A shared session must not run the file entry on a projection: it creates records from text and rewrites ids, a declared limit until the shared entry of package 14."
  },
  "local-merge": {
    family: "other", shared: "not applicable",
    reason: "Local three-way merge and its conflict comments are disabled in a shared session."
  },
  "rollback": {
    family: "other", shared: "not applicable",
    reason: "Puts back what a failed standalone transaction changed; the shared owner applies nothing it could roll back."
  },
  "no-document": {
    family: "other", shared: "not applicable",
    reason: "Not a write to the document: an export table, a preference, a focus memo or a comparison made on copies."
  }
} as const satisfies Record<string, Writer>;

type WriterName = keyof typeof WRITERS;
type Site = readonly [site: string, found: string, ...writers: WriterName[]];

const STEPS: readonly Site[] = [
  ["application/session/document-session.ts#absorbReload", "ports.entry ->", "standalone-door", "file-entry"],
  ["application/session/document-session.ts#adopt", "ports.undo.adopt", "standalone-door"],
  ["application/session/document-session.ts#enter", "ports.entry ->", "standalone-door", "file-entry"],
  ["application/session/document-session.ts#replayAs", "task.plan", "standalone-door", "undo-stamp", "paragraph-start"],
  ["application/session/document-session.ts#stamp", "plan.apply", "standalone-door", "save-stamp", "document-id", "registry-heal-on-draw", "person-colour"],
  ["application/session/document-session.ts#take", "ports.undo.absorbDisk", "standalone-door"],
  ["application/session/document-session.ts#transact", "ports.attribution.attribute | apply | sign.apply | ports.reconcile.anchors", "person-colour", "stated-write", "anchor-repair"],
  ["application/session/document-session.ts#withRecords", "records | plan.apply", "tag-from-text", "cue-retitle", "shot-from-line", "shot-name-from-line", "person-from-name", "owner-from-name"],
  ["application/session/shared-session.ts#execute", "ports.replica.execute", "shared-execute"],
  ["application/session/shared-session.ts#projectionStep", "ports.entry ->", "file-entry"]
];

const FIELDS: readonly Site[] = [
  ["adapters/collab/project.ts#assembleSharedDocument", "rev 1", "capture-read"],
  ["adapters/formats/export-projections.ts#commentEntries", "createdAt 2, resolvedBy 1", "no-document"],
  ["adapters/formats/project-file.ts#rowsFromMarkdownTable", "updatedAt 1, updatedBy 1", "file-entry"],
  ["application/commands/beat-length.ts#beatLengthCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/beat-status.ts#beatStatusCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/beat-status.ts#setBeatFilmedCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/cell-text.ts#cellTextCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/clipboard.ts#cutCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/clipboard.ts#pasteCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/comments.ts#addReplyCommand", "updatedAt 1", "comment-stamp"],
  ["application/commands/comments.ts#restoreConflictCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/comments.ts#setCommentAssigneeCommand", "updatedAt 1", "comment-stamp"],
  ["application/commands/comments.ts#toggleResolveCommand", "resolvedAt 2, resolvedBy 2, updatedAt 1", "comment-stamp"],
  ["application/commands/document-edit.ts#applyRewrites", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/flow.ts#flowCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/gallery.ts#galleryCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/import-rows.ts#importRowsCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/rows.ts#addBeatCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/save-stamps.ts#editStamp", "lastEditedAt 1, lastEditedBy 1, rev 1", "save-stamp"],
  ["application/commands/split-join.ts#joinBeatsCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/split-join.ts#splitBeatCommand", "updatedAt 2, updatedBy 2", "beat-stamp"],
  ["application/editing/undo/undo.ts#createUndo", "updatedAt 1, updatedBy 1", "undo-stamp"],
  ["application/recovery/draft-restore.ts#sameDocContent", "lastEditedAt 1, lastEditedBy 1, rev 1", "no-document"],
  ["application/save/file-saving.ts#writeCaptured", "lastEditedAt 1, lastEditedBy 1, rev 1", "save-stamp"],
  ["application/save/save-completion.ts#createSaveCompletion", "lastEditedAt 1, lastEditedBy 1, rev 1", "save-stamp"],
  ["application/save/session-effects.ts#createSessionEffects", "personColors 1", "person-colour"],
  ["application/session/document-session.ts#anchorPoint", "field 1, rowId 1", "rollback"],
  ["application/session/session-merge.ts#startSessionMerge", "updatedAt 1, updatedBy 1", "beat-stamp", "local-merge"],
  ["core/collab/projection/fields.ts#projectSharedBeatFields", "updatedAt 1, updatedBy 1", "beat-stamp-read"],
  ["core/collab/projection/text.ts#projectSharedCommentAnchors", "field 1, rowId 1", "anchor-repair"],
  ["core/document/media.ts#mediaComments", "createdAt 1, resolvedAt 1, resolvedBy 1, updatedAt 1", "file-entry"],
  ["core/merge/rows.ts#conflictComment", "createdAt 1, updatedAt 1", "local-merge"],
  ["core/merge/rows.ts#mergeComments", "resolvedAt 5, resolvedBy 5", "local-merge"],
  ["core/merge/rows.ts#mergeRows", "updatedAt 1, updatedBy 1", "local-merge"],
  ["core/migrate.ts#migrateRows", "createdAt 2, field 1, resolvedAt 2, resolvedBy 2, rev 1, rowId 2, updatedAt 2, updatedBy 1", "file-entry"],
  ["core/text/anchors.ts#syncCommentAnchors", "field 1, rowId 1", "anchor-repair"],
  ["features/clipboard/beat-clip.ts#insertBeats", "rowId 2", "record-with-text", "anchor-repair"],
  ["features/comments/comments.ts#postComment", "createdAt 1, resolvedAt 1, resolvedBy 1, updatedAt 1", "comment-stamp"],
  ["features/comments/comments.ts#postReply", "createdAt 1", "comment-stamp"],
  ["features/rows/render.ts#captureRenderFocus", "field 1", "no-document"]
];

const RECORDS: readonly Site[] = [
  ["adapters/collab/project.ts#assembleSharedDocument", "comments 1", "anchor-repair"],
  ["adapters/formats/csv.ts#scriptTable", "comments 2", "no-document"],
  ["adapters/formats/project-file.ts#markdownCellToHtml", "productionTags 1", "file-entry"],
  ["application/commands/cell-text.ts#cellTextCommand", "brollShots 1, productionTags 1", "record-with-text"],
  ["application/commands/cell-text.ts#newShots", "brollShots 1", "record-with-text"],
  ["application/commands/cell-text.ts#newTags", "productionTags 1", "record-with-text"],
  ["application/commands/clipboard.ts#pasteCommand", "brollShots 1", "record-with-text"],
  ["application/commands/comments.ts#addCommentCommand", "comments 1", "record-stated"],
  ["application/commands/comments.ts#deleteCommentCommand", "comments 1", "record-stated"],
  ["application/commands/comments.ts#restoreConflictCommand", "comments 2", "record-stated"],
  ["application/commands/flow.ts#flowCommand", "brollShots 1, comments 2, people 1, productionTags 1", "record-with-text", "record-stated"],
  ["application/commands/production-records.ts#gearQuickAddCommand", "productionTags 1", "record-stated"],
  ["application/preferences/preferences.ts#createPreferences", "comments 1", "no-document"],
  ["application/production/production-index.ts#createProductionIndex", "productionTags 1", "tag-from-text", "cue-retitle"],
  ["application/recovery/identity-replacement.ts#prepareIdentityReplacement", "comments 1", "local-merge"],
  ["application/session/document-session.ts#anchorPoint", "comments 1", "rollback"],
  ["core/merge/shape.ts#listShapedSide", "comments 1", "local-merge"],
  ["core/migrate.ts#migrateRows", "brollShots 3, comments 3, people 3, productionTags 4", "file-entry"],
  ["core/production/records.ts#addBrollRecord", "brollShots 1", "record-stated"],
  ["core/production/records.ts#addRegistryTag", "productionTags 1", "record-stated"],
  ["core/production/records.ts#removeBrollRecord", "brollShots 1", "record-stated"],
  ["core/production/records.ts#removePerson", "people 1", "record-stated"],
  ["core/production/records.ts#removeRegistryTag", "productionTags 1", "record-stated"],
  ["core/production/records.ts#renameRegistryTag", "productionTags 1", "record-stated"],
  ["core/production/tags.ts#planQuickAdd", "productionTags 1", "record-stated"],
  ["core/production/tags.ts#planRegistryHealing", "productionTags 1", "tag-from-text", "cue-retitle"],
  ["features/clipboard/beat-clip.ts#insertBeats", "brollShots 3, comments 4, people 2, productionTags 2", "record-with-text"]
];

const COMPUTED: readonly Site[] = [
  ["application/commands/broll-records.ts#setShotsCommand", "brollShots 1", "record-stated"],
  ["application/commands/cell-text.ts#cellTextCommand", "rows 1", "stated-write"],
  ["application/commands/clipboard.ts#cutCommand", "rows 1", "stated-write"],
  ["application/commands/clipboard.ts#pasteCommand", "rows 1", "stated-write"],
  ["application/commands/comments.ts#restoreConflictCommand", "rows 1", "stated-write"],
  ["application/commands/document-edit.ts#applyRewrites", "rows 1", "stated-write"],
  ["application/commands/gallery.ts#galleryCommand", "rows 1", "stated-write"],
  ["application/commands/split-join.ts#splitBeatCommand", "rows 2", "stated-write"],
  ["core/document/broll.ts#newBrollShot", "brollShots 1", "record-stated"]
];

const FROM_TEXT = ["tag-from-text", "cue-retitle", "shot-from-line", "shot-name-from-line", "person-from-name", "owner-from-name"] as const;

const ENGINES: readonly Site[] = [
  ["adapters/collab/buffer.ts#createSharedBufferedText", "Plan.shared (provided) 1", "stated-write"],
  ["adapters/production/broll-anchors.ts#anchorBrollInRows", "planBrollAnchors 1", "broll-key"],
  ["application/commands/broll-records.ts#addShotCommand", "addBrollRecord 1", "record-stated"],
  ["application/commands/production-records.ts#addPersonCommand", "addPerson 1", "record-stated"],
  ["application/commands/production-records.ts#chosenOwner", "addPerson 1", "record-stated"],
  ["application/commands/production-records.ts#registerTagCommand", "addRegistryTag 1", "record-stated"],
  ["application/commands/production-records.ts#tagCellsCommand", "addRegistryTag 1", "record-with-text"],
  ["application/commands/production-records.ts#tagEntry", "addRegistryTag 1", "record-stated"],
  ["application/production/broll-records.ts#createRecordsReconciler", "ProductionIndexOwner.recordsPlan 1, applyBrollRecords 1, applyOwnerSync 1, planBrollRecords 1, planOwnerSync 2", ...FROM_TEXT],
  ["application/production/broll-records.ts#recordPastedBroll", "addBrollRecord 1", "record-with-text"],
  ["application/production/production-index.ts#createProductionIndex", "ProductionIndexOwner.recordsPlan (provided) 1, planRegistryHealing 1", "tag-from-text", "cue-retitle"],
  ["application/save/session-effects.ts#createSessionEffects", "colorsWithMine 1", "person-colour"],
  ["application/session/document-session.ts#createDocumentSession", "AttributionPort.attribute 1, ReconcilePort.anchors 1, ReconcilePort.records 1", "person-colour", "anchor-repair", ...FROM_TEXT],
  ["application/session/shared-session.ts#createSharedSession", "Plan.shared 4, ReplicaPort.execute 1", "shared-execute"],
  ["bootstrap/wiring/broll.ts#mountBrollFeature", "anchorBrollInRows 1", "broll-key"],
  ["bootstrap/wiring/clipboard.ts#mountCopyPasteFeature", "recordPastedBroll 1", "record-with-text"],
  ["bootstrap/wiring/ports/imports.ts#importFormats", "anchorBrollInRows 1", "file-entry"],
  ["bootstrap/wiring/ports/production.ts#production", "ProductionIndexOwner.recordsPlan 1, ProductionIndexOwner.recordsPlan (provided) 1", "tag-from-text", "cue-retitle"],
  ["bootstrap/wiring/session-owner.ts#createSession", "ReconcilePort.anchors (provided) 1, ReconcilePort.records (provided) 1, syncCommentAnchors 1", "anchor-repair", ...FROM_TEXT],
  ["core/migrate.ts#migrateRows", "applyBrollRecords 1, planBrollRecords 1, syncCommentAnchors 1", "file-entry"],
  ["core/production/owners.ts#applyOwnerSync", "addPerson 1", "person-from-name"],
  ["core/production/records.ts#addBrollProp", "addRegistryTag 1", "record-stated"],
  ["features/clipboard/beat-clip.ts#insertBeats", "syncCommentAnchors 1", "anchor-repair"],
  ["features/tags/production-tags.ts#tagRecordsPlan", "ProductionIndexOwner.recordsPlan 1", "registry-heal-on-draw"]
];

const DOORS: Readonly<Record<"stamp" | "amend" | "noteEdit", readonly (readonly [file: string, ...writers: WriterName[]])[]>> = {
  stamp: [
    ["application/identity/document-identity.ts", "document-id"],
    ["bootstrap/wiring/file-saving.ts", "save-stamp", "document-id"],
    ["bootstrap/wiring/ports/document-identity.ts", "document-id"],
    ["bootstrap/wiring/session-owner.ts", "standalone-door", "person-colour"],
    ["features/tags/production-tags.ts", "registry-heal-on-draw"]
  ],
  amend: [
    ["bootstrap/wiring/session-owner.ts", "standalone-door"],
    ["bootstrap/wiring/writer.ts", "paragraph-start"]
  ],
  noteEdit: [
    ["bootstrap/wiring/desktop.ts", "standalone-door"],
    ["bootstrap/wiring/imports.ts", "standalone-door"],
    ["bootstrap/wiring/session-owner.ts", "standalone-door"],
    ["features/imports/imports.ts", "standalone-door"]
  ]
};

const CLASS_COUNTS: Readonly<Record<Shared, number>> = {
  "derivation": 4,
  "operation": 10,
  "not applicable": 8,
  "undetermined": 5
};

let inventory: WriterInventory | null = null;

function current(): WriterInventory {
  inventory ??= commitWriterInventory(RULES);
  return inventory;
}

function found(sites: readonly Site[]): Record<string, string> {
  return Object.fromEntries(sites.map(function ([site, what]) { return [site, what]; }));
}

function joined(steps: WriterInventory["steps"]): Record<string, string> {
  return Object.fromEntries(Object.entries(steps).map(function ([site, calls]) { return [site, calls.join(" | ")]; }));
}

test("the writer scan reads the app's modules and finds every named engine", () => {
  assert.ok(current().modules > 500);
  assert.deepEqual(current().missingEngines, []);
});

test("every call in a session owner that hands over or receives the document is a named commit step", () => {
  assert.deepEqual(joined(current().steps), found(STEPS));
});

test("every write of a who, when or placement field is a named writer", () => {
  assert.deepEqual(current().fields, found(FIELDS));
});

test("every write of a record collection is a named writer", () => {
  assert.deepEqual(current().records, found(RECORDS));
});

test("every write whose field name is known only at run time is a named writer", () => {
  assert.deepEqual(current().computed, found(COMPUTED));
});

test("every use of an engine that makes records, placement or attribution from text is a named writer", () => {
  assert.deepEqual(current().engines, found(ENGINES));
});

test("every caller of the stamp, amend and edit-note doors is a named writer", () => {
  const members = typedStandaloneInventory().members;
  for (const door of ["stamp", "amend", "noteEdit"] as const) {
    assert.deepEqual(DOORS[door].map(function ([file]) { return file; }), Object.keys(members[door] ?? {}).sort(), door);
  }
});

test("every site names writers from the table, and every writer in the table has a site", () => {
  const named = new Set<string>();
  for (const sites of [STEPS, FIELDS, RECORDS, COMPUTED, ENGINES]) {
    for (const [site, , ...writers] of sites) {
      assert.ok(writers.length > 0, site);
      for (const writer of writers) { assert.ok(Object.hasOwn(WRITERS, writer), site); named.add(writer); }
    }
  }
  for (const callers of Object.values(DOORS)) {
    for (const [file, ...writers] of callers) {
      assert.ok(writers.length > 0, file);
      for (const writer of writers) { assert.ok(Object.hasOwn(WRITERS, writer), file); named.add(writer); }
    }
  }
  assert.deepEqual([...named].sort(), Object.keys(WRITERS).sort());
});

test("the table's classes are counted", () => {
  const counts: Record<Shared, number> = { "derivation": 0, "operation": 0, "not applicable": 0, "undetermined": 0 };
  for (const writer of Object.values(WRITERS) as readonly Writer[]) {
    assert.ok(writer.reason.length > 40);
    counts[writer.shared]++;
  }
  assert.deepEqual(counts, CLASS_COUNTS);
});

const PROBE = "starters/writer-probe.ts";

const PROBE_IMPORTS = `
  import type { DocumentRow, ValidatedDocument } from "../core/document/validated.ts";
  import type { DocumentView } from "../application/session/document-session.ts";
  import type { ReconcilePort } from "../application/session/ports.ts";
  import { syncCommentAnchors as repair } from "../core/text/anchors.ts";
  import * as owners from "../core/production/owners.ts";
  declare const doc: ValidatedDocument;
  declare const row: DocumentRow;
  declare const bag: Record<string, unknown>;
`;

function probed(source: string, owners: readonly string[] = []): WriterInventory {
  return commitWriterInventory({ ...RULES, owners: owners }, { [PROBE]: PROBE_IMPORTS + source });
}

for (const [name, source, fields] of [
  ["an assignment", "function write() { row.updatedAt = ''; }", "updatedAt 1"],
  ["a literal element key", "function write() { bag['updatedBy'] = ''; }", "updatedBy 1"],
  ["a constant computed key", "function write() { const key = 'rev'; bag[key] = 1; }", "rev 1"],
  ["a union key", "function write(key: 'lastEditedAt' | 'lastEditedBy') { bag[key] = ''; }", "lastEditedAt 1, lastEditedBy 1"],
  ["an increment", "function write() { doc.rev++; }", "rev 1"],
  ["a compound assignment", "function write() { doc.rev += 1; }", "rev 1"],
  ["a removal", "function write() { delete bag.resolvedAt; }", "resolvedAt 1"],
  ["an object literal", "function write() { return { createdAt: '', title: '' }; }", "createdAt 1"],
  ["a shorthand property", "function write(updatedAt: string) { return { updatedAt }; }", "updatedAt 1"],
  ["a computed literal property", "function write() { const key = 'resolvedBy'; return { [key]: '' }; }", "resolvedBy 1"],
  ["an assignment through a cast", "function write() { (row as Record<string, unknown>).updatedAt = ''; }", "updatedAt 1"],
  ["an assigned-only field", "function write() { doc.personColors = {}; bag.rowId = ''; }", "personColors 1, rowId 1"]
] as const) {
  test("writer scan self-test, fields: " + name, () => {
    assert.deepEqual(probed(source).fields, { [PROBE + "#write"]: fields });
  });
}

test("writer scan self-test, fields: a table of field names, an assigned-only field in a literal and a read are no writes", () => {
  const found = probed(`
    const SHOWN = { updatedAt: true, updatedBy: true };
    function build() { return { personColors: {}, rowId: "", field: "" }; }
    function read() { return [row.updatedAt, doc.rev, SHOWN, build]; }
  `);
  assert.deepEqual(found.fields, {});
});

for (const [name, source, records] of [
  ["a replaced collection", "function write() { doc.comments = []; }", "comments 1"],
  ["a mutating call", "function write() { doc.brollShots.push({ id: '' }); doc.people.splice(0, 1); }", "brollShots 1, people 1"],
  ["a mutating call on a renamed collection", "function write() { const list = doc.productionTags; list.push(null); }", "productionTags 1"],
  ["a mutating call on a declared collection type", "function write(list: ValidatedDocument['comments']) { list.sort(); }", "comments 1"],
  ["an indexed write", "function write() { doc.people[0] = { id: '', name: '' }; }", "people 1"],
  ["a truncation", "function write() { doc.comments.length = 0; }", "comments 1"],
  ["an untyped holder with a collection's name", "function write(holder: { brollShots: unknown[] }) { holder.brollShots.push(1); }", "brollShots 1"]
] as const) {
  test("writer scan self-test, records: " + name, () => {
    assert.deepEqual(probed(source).records, { [PROBE + "#write"]: records });
  });
}

test("writer scan self-test, records: reading, copying and an unrelated list are no writes", () => {
  const found = probed(`
    function read(list: string[]) { list.push(""); return [doc.comments.slice(), doc.people.map(person => person.id), { comments: [] }]; }
  `);
  assert.deepEqual(found.records, {});
});

test("writer scan self-test, computed: a field name known only at run time counts on a beat, a record and the document, and nowhere else", () => {
  const found = probed(`
    function onBeat(key: string) { row[key] = 1; }
    function onRecord(key: string) { const shot = doc.brollShots[0]; if (shot) shot[key] = 1; }
    function onDocument(key: string) { doc[key] = 1; }
    function elsewhere(key: string) { bag[key] = 1; }
  `);
  assert.deepEqual(found.computed, { [PROBE + "#onBeat"]: "rows 1", [PROBE + "#onDocument"]: "document 1", [PROBE + "#onRecord"]: "brollShots 1" });
});

test("writer scan self-test, engines: a renamed import, a namespace member, a port member under Pick and a provided port member, also one of several accepted shapes, all resolve", () => {
  const found = probed(`
    function renamed() { repair(doc, () => []); }
    function namespaced() { return owners.planOwnerSync; }
    function ported(port: Pick<ReconcilePort, "anchors">) { port.anchors(doc); }
    function provided(): ReconcilePort { return { anchors: () => 0 }; }
    function offered(): ReconcilePort | { readonly refused: string } | null { return { anchors: () => 0 }; }
    function unrelated() { const syncCommentAnchors = () => 0; return { anchors: syncCommentAnchors() }; }
  `);
  assert.deepEqual(found.engines, {
    [PROBE + "#namespaced"]: "planOwnerSync 1",
    [PROBE + "#offered"]: "ReconcilePort.anchors (provided) 1",
    [PROBE + "#ported"]: "ReconcilePort.anchors 1",
    [PROBE + "#provided"]: "ReconcilePort.anchors (provided) 1",
    [PROBE + "#renamed"]: "syncCommentAnchors 1"
  });
});

test("writer scan self-test, steps: an owner's calls that take or return the document or reach an engine are steps, and a read-only view or a local helper is not", () => {
  const source = `
    declare const ports: { change: (live: ValidatedDocument) => void; entry: (raw: unknown) => ValidatedDocument; view: (seen: DocumentView) => void; reconcile: ReconcilePort };
    function local(live: ValidatedDocument) { return live; }
    function commit(apply: (live: ValidatedDocument | null) => void) {
      local(doc); ports.view(doc); ports.change(doc); apply(doc); ports.reconcile.anchors(doc);
      const made = function () { return ports.entry(null); };
      return made;
    }
  `;
  assert.deepEqual(probed(source, [PROBE]).steps, {
    [PROBE + "#commit"]: ["ports.change", "apply", "ports.reconcile.anchors"],
    [PROBE + "#made"]: ["ports.entry ->"]
  });
  assert.deepEqual(probed(source).steps, {});
});

test("writer scan self-test: an engine that no longer exists is reported", () => {
  const found = commitWriterInventory({ ...RULES, engines: [...RULES.engines, "core/text/anchors.ts#repairAnchors", "application/session/ports.ts#ReconcilePort.marks"] }, { [PROBE]: "export {};" });
  assert.deepEqual(found.missingEngines, ["core/text/anchors.ts#repairAnchors", "application/session/ports.ts#ReconcilePort.marks"]);
});
