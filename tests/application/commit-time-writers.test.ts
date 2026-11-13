import { test } from "node:test";
import assert from "node:assert/strict";
import { commitWriterInventory } from "./commit-writer-scan.ts";
import type { WriterInventory, WriterScanRules } from "./commit-writer-scan.ts";
import { typedStandaloneInventory } from "./session-caller-scan.ts";

const RULES: WriterScanRules = {
  owners: ["application/session/document-session.ts", "application/session/shared-session.ts"],
  fields: ["updatedAt", "updatedBy", "createdAt", "resolvedAt", "resolvedBy", "rev", "lastEditedAt", "lastEditedBy", "paragraphStart", "paragraphsDecided", "anchorId"],
  assigned: ["personColors", "rowId", "field"],
  typed: { document: ["docId"], productionTags: ["name", "owner"], brollShots: ["name", "desc", "owner"] },
  collections: ["productionTags", "brollShots", "people", "comments", "comments.replies"],
  projections: ["core/collab/projection/", "adapters/collab/project.ts", "adapters/collab/projection-reader.ts"],
  engines: [
    "adapters/collab/stamp.ts#readSharedResolution",
    "adapters/collab/stamp.ts#readSharedStamp",
    "adapters/collab/stamp.ts#sharedBeatStamp",
    "adapters/collab/stamp.ts#sharedResolutionOperation",
    "adapters/collab/stamp.ts#sharedStampOperation",
    "adapters/production/broll-anchors.ts#anchorBrollInGivenRows",
    "adapters/production/broll-anchors.ts#anchorBrollInRows",
    "application/production/broll-records.ts#recordPastedBroll",
    "application/session/document-session.ts#AttributionPort.attribute",
    "application/session/document-session.ts#Plan.shared",
    "application/session/ports.ts#ReconcilePort.anchors",
    "application/session/ports.ts#ReconcilePort.records",
    "application/session/shared-session.ts#ReplicaPort.execute",
    "core/collab/text-records.ts#sharedTagsIntroducedByText",
    "core/document/person-colors.ts#colorsWithMine",
    "core/production/broll.ts#applyBrollRecords",
    "core/production/broll.ts#planBrollAnchors",
    "core/production/broll.ts#planBrollAnchorsInState",
    "core/production/broll.ts#planBrollRecords",
    "core/production/broll.ts#planBrollRecordsInState",
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
    reason: "A command that changes a beat writes who and when (updatedAt, updatedBy). Shared: one scalar `stamp` {at, by} for that beat in the command's list, or the fields of the operation that creates the beat; once per typing group (decided 2026-11-09), built for Writer typing as one stamp per buffered commit. A stamp replaces the stamps its copy has seen."
  },
  "beat-stamp-read": {
    family: "attribution", shared: "derivation",
    reason: "The projection turns the stored `stamp` into updatedAt and updatedBy; of stamps written without seeing each other it shows the later time, then the later name."
  },
  "undo-stamp": {
    family: "attribution", shared: "not applicable",
    reason: "Standalone undo and redo stamp a beat they change through a field step other than paragraphStart, never a beat they put back. Shared: undo leaves the stamp as it is; the executor leaves stamp scalars out of the undo record (assumed rule 35)."
  },
  "comment-stamp": {
    family: "attribution", shared: "operation",
    reason: "Who and when on a comment or reply (createdAt, updatedAt, the resolution) are fields of the comment command's own record operations; createdAt is written once with the record. A resolve or reopen is a stamp {at, by, resolution} that replaces the ones its copy has seen (assumed rule 49); neither it nor updatedAt enters the undo record (assumed rule 35)."
  },
  "comment-stamp-read": {
    family: "attribution", shared: "derivation",
    reason: "The projection shows a comment's stored resolution as resolved, resolvedAt and resolvedBy; of resolutions written without seeing each other it shows the later time, then the later name."
  },
  "save-stamp": {
    family: "attribution", shared: "not applicable",
    reason: "rev, lastEditedBy and lastEditedAt after a confirmed save. Decided 2026-11-09: written only on export; file saving is disabled in a shared session."
  },
  "capture-read": {
    family: "attribution", shared: "derivation",
    reason: "The projection shows the rev, lastEditedBy, lastEditedAt and personColors hydration retained (rev 0 when absent); nothing writes them during a session."
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
    reason: "A tag found in text with no registry entry gets one. Shared: record-create by the copy whose command introduced the tag (built for Writer typing); a tag without an entry projects untagged and is never registered on receipt."
  },
  "cue-retitle": {
    family: "records", shared: "undetermined",
    reason: "A sound cue's registry entry is renamed when its cue text is edited, found by comparing this copy's text before and after. No rule says whether a cue entry follows its text or is renamed by an operation."
  },
  "shot-from-line": {
    family: "records", shared: "operation",
    reason: "A B-roll line with no shot gets one, seeded from its beat. Shared: record-create by the copy that typed or pasted the line, with the id of its key, built by sharedBrollIntroducedByText for a key the edited cell did not hold (callers in package 14)."
  },
  "shot-name-from-line": {
    family: "records", shared: "derivation",
    reason: "A shot's name and description follow its B-roll line. Shared: derived from the line while its key is in the text; the stored name is the fallback once the line is gone (record handlers: stored fallback names are retained)."
  },
  "person-from-name": {
    family: "records", shared: "operation",
    reason: "An @Name new to the script with no person record gets one. Shared: record-create by the copy that typed it, built by sharedPeopleIntroducedByText (callers in package 14); the same new name typed on two copies gives two people, a declared merged-state limit."
  },
  "owner-from-name": {
    family: "records", shared: "undetermined",
    reason: "A tag's owner is set when an @Name is paired with it on a line and cleared when the last pairing goes, by comparing this copy's text before and after. No rule says whether an owner follows the text or is set by an operation."
  },
  "broll-key": {
    family: "records", shared: "operation",
    reason: "An unkeyed B-roll marker is given an id by rewriting its text: a command of its own, with text operations. sharedBrollIntroducedByText keys the edited cell as the anchor plan does; its caller sends the keyed cell (package 14). A repeated key is settled by the projection (assumed rules 14 and 15)."
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
  "recovery-write": {
    family: "other", shared: "operation",
    reason: "A write nobody commanded: when the document refuses buffered typing, the buffer keeps the field as one list of its own (a beat created and removed in the same list) whose plan declares `undo: false`, so the session records no undo entry (assumed rule 29)."
  },
  "stored-read": {
    family: "other", shared: "derivation",
    reason: "The projection shows stored fields and records as they are: docId, paragraphsDecided, paragraphStart, gallery and joined fields, sections and the record collections with their replies."
  },
  "paragraph-start": {
    family: "other", shared: "undetermined",
    reason: "Opening the Writer on a script whose paragraphs were never decided marks sentence paragraphs through the amend door. No rule says whether undecided paragraphs are derived or written by the first copy that opens the Writer."
  },
  "standalone-door": {
    family: "other", shared: "not applicable",
    reason: "adopt, absorb, replay, amend, stamp and noteEdit are members of the standalone session only, as is the undo history that replays recorded steps; a shared session has none of them."
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
  ["adapters/formats/project-file.ts#buildSplitpageCopy", "docId 1", "no-document"],
  ["adapters/formats/project-file.ts#rowsFromMarkdownTable", "updatedAt 1, updatedBy 1", "file-entry"],
  ["adapters/page/standalone-html.ts#standaloneHtmlFor", "docId 1", "no-document"],
  ["application/commands/beat-length.ts#beatLengthCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/beat-status.ts#beatStatusCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/beat-status.ts#setBeatFilmedCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/broll-records.ts#setShotsCommand", "owner 1", "record-stated"],
  ["application/commands/cell-text.ts#cellTextCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/clipboard.ts#cutCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/clipboard.ts#pasteCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/comments.ts#addReplyCommand", "updatedAt 1", "comment-stamp"],
  ["application/commands/comments.ts#restoreConflictCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/comments.ts#setCommentAssigneeCommand", "updatedAt 1", "comment-stamp"],
  ["application/commands/comments.ts#toggleResolveCommand", "resolvedAt 4, resolvedBy 4, updatedAt 1", "comment-stamp"],
  ["application/commands/document-edit.ts#applyRewrites", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/flow.ts#flowCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/flow.ts#initializeFlowParagraphs", "paragraphStart 1, paragraphsDecided 1", "paragraph-start"],
  ["application/commands/gallery.ts#galleryCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/import-rows.ts#importRowsCommand", "paragraphStart 1, updatedAt 1, updatedBy 1", "beat-stamp", "stated-write"],
  ["application/commands/paragraphs.ts#applyParagraphFlags", "paragraphStart 2", "stated-write"],
  ["application/commands/production-records.ts#updateTagsCommand", "owner 1", "record-stated"],
  ["application/commands/rows.ts#addBeatCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/save-stamps.ts#documentIdStamp", "docId 1", "document-id"],
  ["application/commands/save-stamps.ts#editStamp", "lastEditedAt 1, lastEditedBy 1, rev 1", "save-stamp"],
  ["application/commands/scenes.ts#removeSceneCommand", "paragraphStart 1", "stated-write"],
  ["application/commands/split-join.ts#joinBeatsCommand", "updatedAt 1, updatedBy 1", "beat-stamp"],
  ["application/commands/split-join.ts#splitBeatCommand", "updatedAt 2, updatedBy 2", "beat-stamp"],
  ["application/editing/undo/history.ts#createUndoHistory", "paragraphStart 1", "standalone-door"],
  ["application/editing/undo/history.ts#ownersReplayed", "owner 1", "standalone-door"],
  ["application/editing/undo/history.ts#resolveDocFields", "name 1", "standalone-door"],
  ["application/editing/undo/undo.ts#createUndo", "updatedAt 1, updatedBy 1", "undo-stamp"],
  ["application/production/production-index.ts#createProductionIndex", "name 1", "cue-retitle"],
  ["application/recovery/draft-restore.ts#sameDocContent", "docId 1, lastEditedAt 1, lastEditedBy 1, rev 1", "no-document"],
  ["application/recovery/drafts.ts#startDrafts", "docId 1", "document-id"],
  ["application/recovery/identity-replacement.ts#prepareIdentityReplacement", "anchorId 1", "local-merge"],
  ["application/save/file-saving.ts#writeCaptured", "lastEditedAt 1, lastEditedBy 1, rev 1", "save-stamp"],
  ["application/save/save-completion.ts#createSaveCompletion", "lastEditedAt 1, lastEditedBy 1, rev 1", "save-stamp"],
  ["application/save/session-effects.ts#createSessionEffects", "personColors 1", "person-colour"],
  ["application/session/document-session.ts#anchorPoint", "field 1, rowId 1", "rollback"],
  ["application/session/session-merge.ts#startSessionMerge", "updatedAt 1, updatedBy 1", "beat-stamp", "local-merge"],
  ["application/transitions/transitions.ts#createTransitions", "docId 2", "document-id"],
  ["core/collab/projection/fields.ts#projectSharedBeatFields", "updatedAt 1, updatedBy 1", "beat-stamp-read"],
  ["core/collab/projection/text.ts#projectSharedCommentAnchors", "field 1, rowId 1", "anchor-repair"],
  ["core/document/broll.ts#newBrollShot", "desc 1, name 1, owner 1", "record-stated", "shot-from-line"],
  ["core/document/media.ts#mediaComments", "anchorId 1, createdAt 1, resolvedAt 1, resolvedBy 1, updatedAt 1", "file-entry"],
  ["core/flow/flow.ts#withoutFlag", "paragraphStart 1", "stated-write"],
  ["core/merge/lists.ts#mergeBrollShots", "owner 1", "local-merge"],
  ["core/merge/rows.ts#conflictComment", "anchorId 1, createdAt 1, updatedAt 1", "local-merge"],
  ["core/merge/rows.ts#mergeComments", "resolvedAt 5, resolvedBy 5", "local-merge"],
  ["core/merge/rows.ts#mergeRows", "paragraphStart 2, updatedAt 1, updatedBy 1", "local-merge"],
  ["core/migrate.ts#migrateDocument", "docId 3", "file-entry"],
  ["core/migrate.ts#migrateRows", "anchorId 2, createdAt 2, field 1, paragraphStart 1, resolvedAt 2, resolvedBy 2, rev 1, rowId 2, updatedAt 2, updatedBy 1", "file-entry"],
  ["core/production/broll.ts#applyBrollRecords", "desc 1, name 1", "shot-name-from-line"],
  ["core/production/owners.ts#applyOwnerSync", "owner 2", "owner-from-name"],
  ["core/production/records.ts#removePerson", "owner 2", "record-stated"],
  ["core/production/records.ts#renameRegistryTag", "name 1, owner 1", "record-stated"],
  ["core/text/anchors.ts#syncCommentAnchors", "field 1, rowId 1", "anchor-repair"],
  ["features/clipboard/beat-clip.ts#buildBeatPayload", "paragraphStart 1", "no-document"],
  ["features/clipboard/beat-clip.ts#insertBeats", "anchorId 1, name 1, owner 3, rowId 3", "record-with-text", "anchor-repair"],
  ["features/comments/comments.ts#postComment", "anchorId 1, createdAt 1, field 1, resolvedAt 1, resolvedBy 1, rowId 1, updatedAt 1", "comment-stamp", "record-stated"],
  ["features/comments/comments.ts#postReply", "createdAt 1", "comment-stamp"],
  ["features/merge/local-merge.ts#offerFileMerge", "docId 1", "local-merge"],
  ["features/rows/render.ts#captureRenderFocus", "field 1", "no-document"]
];

const RECORDS: readonly Site[] = [
  ["adapters/collab/project.ts#assembleSharedDocument", "comments 1", "anchor-repair"],
  ["adapters/collab/project.ts#assembleSharedDocumentFields", "brollShots 1, comments 1, people 1, productionTags 1", "stored-read"],
  ["adapters/formats/csv.ts#scriptTable", "comments 2", "no-document"],
  ["adapters/formats/project-file.ts#markdownCellToHtml", "productionTags 1", "file-entry"],
  ["application/commands/cell-text.ts#cellTextCommand", "brollShots 1, productionTags 1", "record-with-text"],
  ["application/commands/cell-text.ts#newShots", "brollShots 1", "record-with-text"],
  ["application/commands/cell-text.ts#newTags", "productionTags 1", "record-with-text"],
  ["application/commands/clipboard.ts#pasteCommand", "brollShots 1", "record-with-text"],
  ["application/commands/comments.ts#addCommentCommand", "comments 1", "record-stated"],
  ["application/commands/comments.ts#addReplyCommand", "replies 2", "record-stated"],
  ["application/commands/comments.ts#deleteCommentCommand", "comments 1", "record-stated"],
  ["application/commands/comments.ts#restoreConflictCommand", "comments 2", "record-stated"],
  ["application/commands/flow.ts#flowCommand", "brollShots 1, comments 2, people 1, productionTags 1", "record-with-text", "record-stated"],
  ["application/commands/production-records.ts#gearQuickAddCommand", "productionTags 1", "record-stated"],
  ["application/preferences/preferences.ts#createPreferences", "comments 1", "no-document"],
  ["application/production/production-index.ts#createProductionIndex", "productionTags 1", "tag-from-text", "cue-retitle"],
  ["application/recovery/identity-replacement.ts#prepareIdentityReplacement", "comments 1", "local-merge"],
  ["application/session/document-session.ts#anchorPoint", "comments 1", "rollback"],
  ["core/collab/projection/fields.ts#projectSharedCommentFields", "replies 1", "stored-read"],
  ["core/merge/rows.ts#mergeComments", "replies 1", "local-merge"],
  ["core/merge/shape.ts#listShapedSide", "comments 1", "local-merge"],
  ["core/migrate.ts#migrateRows", "brollShots 3, comments 3, people 3, productionTags 4, replies 2", "file-entry"],
  ["core/production/records.ts#addBrollRecord", "brollShots 1", "record-stated"],
  ["core/production/records.ts#addRegistryTag", "productionTags 1", "record-stated"],
  ["core/production/records.ts#removeBrollRecord", "brollShots 1", "record-stated"],
  ["core/production/records.ts#removePerson", "people 1", "record-stated"],
  ["core/production/records.ts#removeRegistryTag", "productionTags 1", "record-stated"],
  ["core/production/records.ts#renameRegistryTag", "productionTags 1", "record-stated"],
  ["core/production/tags.ts#planQuickAdd", "productionTags 1", "record-stated"],
  ["core/production/tags.ts#planRegistryHealing", "productionTags 1", "tag-from-text", "cue-retitle"],
  ["features/clipboard/beat-clip.ts#insertBeats", "brollShots 3, comments 4, people 2, productionTags 2, replies 1", "record-with-text"]
];

const COMPUTED: readonly Site[] = [
  ["adapters/collab/project.ts#assembleSharedDocument", "open 3", "stored-read"],
  ["adapters/collab/project.ts#assembleSharedDocumentFields", "open 3", "capture-read", "stored-read"],
  ["application/commands/broll-records.ts#setShotsCommand", "brollShots 1", "record-stated"],
  ["application/commands/cell-text.ts#cellTextCommand", "rows 1", "stated-write"],
  ["application/commands/clipboard.ts#cutCommand", "rows 1", "stated-write"],
  ["application/commands/clipboard.ts#pasteCommand", "rows 1", "stated-write"],
  ["application/commands/comments.ts#restoreConflictCommand", "rows 1", "stated-write"],
  ["application/commands/document-edit.ts#applyRewrites", "rows 1", "stated-write"],
  ["application/commands/document-edit.ts#rewrittenCopies", "open 1", "no-document"],
  ["application/commands/gallery.ts#galleryCommand", "rows 1", "stated-write"],
  ["application/commands/split-join.ts#splitBeatCommand", "rows 2", "stated-write"],
  ["application/editing/undo/history.ts#repointLists", "open 1", "standalone-door"],
  ["application/editing/undo/history.ts#writePlanned", "open 2", "standalone-door"],
  ["core/collab/projection/fields.ts#projectSharedBeatFields", "open 1", "stored-read"],
  ["core/collab/projection/fields.ts#projectSharedCommentFields", "open 1", "comment-stamp-read", "stored-read"],
  ["core/collab/projection/fields.ts#projectSharedGalleryFields", "open 2", "stored-read"],
  ["core/collab/projection/fields.ts#projectSharedGallerySlots", "open 2", "stored-read"],
  ["core/collab/projection/gallery.ts#projectSharedGroupGallery", "open 4", "stored-read"],
  ["core/collab/projection/joins.ts#projectSharedJoinedFields", "open 1", "stored-read"],
  ["core/collab/projection/joins.ts#projectSharedSections", "open 1", "stored-read"],
  ["core/document/broll.ts#newBrollShot", "brollShots 1", "record-stated"],
  ["core/text/steps.ts#applyStep", "open 2", "standalone-door"],
  ["features/clipboard/beat-clip.ts#insertBeats", "open 1", "record-with-text"]
];

const FROM_TEXT = ["tag-from-text", "cue-retitle", "shot-from-line", "shot-name-from-line", "person-from-name", "owner-from-name"] as const;

const ENGINES: readonly Site[] = [
  ["adapters/collab/buffer.ts#createSharedBufferedText", "Plan.shared (provided) 2, sharedBeatStamp 1, sharedTagsIntroducedByText 1", "stated-write", "recovery-write", "tag-from-text",
    "beat-stamp"],
  ["adapters/collab/projection-reader.ts#readProjectionFields", "readSharedStamp 1", "beat-stamp-read"],
  ["adapters/collab/record-codec.ts#readRecordFields", "readSharedResolution 1", "comment-stamp-read"],
  ["adapters/collab/record-executor.ts#prepareSet", "sharedResolutionOperation 1", "comment-stamp"],
  ["adapters/collab/scalar-executor.ts#prepareScalar", "sharedStampOperation 1", "beat-stamp"],
  ["adapters/collab/scalar-reader.ts#readSharedScalars", "readSharedStamp 1", "beat-stamp-read"],
  ["adapters/collab/undo-executor.ts#executeCommand", "sharedStampOperation 1", "undo-stamp"],
  ["adapters/production/broll-anchors.ts#anchorBrollInGivenRows", "planBrollAnchorsInState 1", "broll-key"],
  ["adapters/production/broll-anchors.ts#anchorBrollInRows", "anchorBrollInGivenRows 1", "broll-key"],
  ["application/commands/broll-records.ts#addShotCommand", "addBrollRecord 1", "record-stated"],
  ["application/commands/comments.ts#addCommentCommand", "Plan.shared (provided) 2", "record-stated", "comment-stamp"],
  ["application/commands/comments.ts#addReplyCommand", "Plan.shared (provided) 2", "record-stated", "comment-stamp"],
  ["application/commands/comments.ts#setCommentAssigneeCommand", "Plan.shared (provided) 2", "stated-write", "comment-stamp"],
  ["application/commands/comments.ts#toggleResolveCommand", "Plan.shared (provided) 2", "comment-stamp"],
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
  ["application/session/shared-session.ts#createSharedSession", "Plan.shared 5, ReplicaPort.execute 1", "shared-execute", "recovery-write"],
  ["bootstrap/wiring/broll.ts#mountBrollFeature", "anchorBrollInGivenRows 1", "broll-key"],
  ["bootstrap/wiring/clipboard.ts#mountCopyPasteFeature", "recordPastedBroll 1", "record-with-text"],
  ["bootstrap/wiring/ports/imports.ts#importFormats", "anchorBrollInRows 1", "file-entry"],
  ["bootstrap/wiring/ports/production.ts#production", "ProductionIndexOwner.recordsPlan 1, ProductionIndexOwner.recordsPlan (provided) 1", "tag-from-text", "cue-retitle"],
  ["bootstrap/wiring/session-owner.ts#createSession", "ReconcilePort.anchors (provided) 1, ReconcilePort.records (provided) 1, syncCommentAnchors 1", "anchor-repair", ...FROM_TEXT],
  ["core/collab/text-records.ts#sharedBrollIntroducedByText", "planBrollAnchorsInState 1, planBrollRecordsInState 1", "broll-key", "shot-from-line"],
  ["core/collab/text-records.ts#sharedPeopleIntroducedByText", "addPerson 1, planOwnerSync 1", "person-from-name"],
  ["core/migrate.ts#migrateRows", "applyBrollRecords 1, planBrollRecords 1, syncCommentAnchors 1", "file-entry"],
  ["core/production/broll.ts#planBrollAnchors", "planBrollAnchorsInState 1", "broll-key"],
  ["core/production/broll.ts#planBrollRecords", "planBrollRecordsInState 1", "shot-from-line", "shot-name-from-line"],
  ["core/production/owners.ts#applyOwnerSync", "addPerson 1", "person-from-name"],
  ["core/production/records.ts#addBrollProp", "addRegistryTag 1", "record-stated"],
  ["features/clipboard/beat-clip.ts#insertBeats", "syncCommentAnchors 1", "anchor-repair"],
  ["features/tags/production-tags.ts#tagRecordsPlan", "ProductionIndexOwner.recordsPlan 1", "registry-heal-on-draw"],
  ["features/writer/flow-writer.ts#createFlowWriter", "Plan.shared (provided) 1", "stated-write"]
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
  "derivation": 6,
  "operation": 11,
  "not applicable": 9,
  "undetermined": 4
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

const HELPER = "starters/writer-helper.ts";

const PROBE_IMPORTS = `
  import type { DocumentReply, DocumentRow, ValidatedDocument } from "../core/document/validated.ts";
  import type { DocumentView, Plan } from "../application/session/document-session.ts";
  import type { ReconcilePort } from "../application/session/ports.ts";
  import type { ReplicaPort } from "../application/session/shared-session.ts";
  import { syncCommentAnchors as repair } from "../core/text/anchors.ts";
  import * as owners from "../core/production/owners.ts";
  import { append, put } from "./writer-helper.ts";
  declare const doc: ValidatedDocument;
  declare const row: DocumentRow;
  declare const bag: Record<string, unknown>;
`;

const HELPER_SOURCE = `
  export function put<T, K extends keyof T>(target: T, key: K, value: T[K]): void { target[key] = value; }
  export function append<T>(list: T[], item: T): void { list.push(item); }
`;

function probed(source: string, owners: readonly string[] = [], projections: readonly string[] = RULES.projections): WriterInventory {
  return commitWriterInventory({ ...RULES, owners: owners, projections: projections }, { [PROBE]: PROBE_IMPORTS + source, [HELPER]: HELPER_SOURCE });
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
  ["an assigned-only field", "function write() { doc.personColors = {}; bag.rowId = ''; }", "personColors 1, rowId 1"],
  ["a merged source that carries a field", "function write(source: { updatedAt: string; title: string }) { Object.assign(row, source); }", "updatedAt 1"],
  ["a spread source that carries a field", "function write(source: { updatedBy: string }): DocumentRow { return { ...row, ...source }; }", "updatedBy 1"],
  ["an assigned-only field merged in a literal", "function write(field: string) { Object.assign(bag, { field }); Object.assign(doc, { personColors: {} }); }", "field 1, personColors 1"],
  ["an assigned-only field in a literal of a watched type", "function write(): DocumentRow { return { ...row, rowId: '' }; }", "rowId 1"],
  ["a run-time key into a watched field through a cast, and its removal", "function write(name: string) { (doc['personColors'] as Record<string, string>)[name] = ''; delete (doc['personColors'] as Record<string, string>)[name]; }", "personColors 2"],
  ["a generic setter in another module, at the call site", "function write() { put(row, 'updatedAt', ''); }", "updatedAt 1"],
  ["a field named for one record kind, on that kind", "function write(tag: ValidatedDocument['productionTags'][number]) { tag.owner = ''; doc.docId = ''; row.owner = ''; bag.name = ''; }", "docId 1, owner 1"]
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
  ["an untyped holder with a collection's name", "function write(holder: { brollShots: unknown[] }) { holder.brollShots.push(1); }", "brollShots 1"],
  ["a nested collection", "function write() { doc.comments[0]?.replies?.push({ id: '' }); }", "replies 1"],
  ["a generic appender in another module, at the call site", "function write() { append(doc.comments, { id: '' }); }", "comments 1"]
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

test("writer scan self-test, computed: a run-time key behind a cast counts on a type a watched one is assignable to and on a reply", () => {
  const found = probed(`
    function onPartial(part: Partial<DocumentRow>, key: string) { (part as Record<string, unknown>)[key] = 1; }
    function onReply(reply: DocumentReply, key: string) { (reply as unknown as Record<string, unknown>)[key] = 1; }
  `);
  assert.deepEqual(found.computed, { [PROBE + "#onPartial"]: "open 1", [PROBE + "#onReply"]: "replies 1" });
});

test("writer scan self-test, computed: in a projection module an open bag and a merge from one count, and elsewhere they do not", () => {
  const source = `
    function keyed(key: string) { bag[key] = 1; }
    function merged(meta: Record<string, unknown>) { Object.assign(bag, meta); return { ...meta }; }
  `;
  assert.deepEqual(probed(source, [], [PROBE]).computed, { [PROBE + "#keyed"]: "open 1", [PROBE + "#merged"]: "open 2" });
  assert.deepEqual(probed(source).computed, {});
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

test("writer scan self-test, engines: a provider by spread or class and a reader by destructuring or element access all resolve", () => {
  const found = probed(`
    function spread(plan: Plan, extra: { shared: Plan["shared"] }): Plan { return { ...plan, ...extra }; }
    function unpacked(plan: Plan) { const { shared } = plan; return shared; }
    function indexed(plan: Plan) { return plan["shared"]; }
    class Replica implements Pick<ReplicaPort, "execute"> { execute() { return null as never; } }
    function taken(port: ReplicaPort) { const { execute } = port; return execute; }
  `);
  assert.deepEqual(found.engines, {
    [PROBE + "#Replica"]: "ReplicaPort.execute (provided) 1",
    [PROBE + "#indexed"]: "Plan.shared 1",
    [PROBE + "#spread"]: "Plan.shared (provided) 2",
    [PROBE + "#taken"]: "ReplicaPort.execute 1",
    [PROBE + "#unpacked"]: "Plan.shared 1"
  });
});

test("writer scan self-test: the forms the document lists as unseen find nothing", () => {
  const found = probed(`
    function reflected() { Reflect.set(row, "updatedAt", ""); }
    function destructured(src: { a: string }) { ({ a: row["updatedAt"] } = src); }
    function borrowed() { Array.prototype.push.call(doc.comments, null); }
  `);
  assert.deepEqual([found.fields, found.records, found.computed], [{}, {}, {}]);
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
