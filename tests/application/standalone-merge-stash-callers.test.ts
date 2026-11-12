import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityPortCallers } from "./capability-caller-scan.ts";

const MERGE = {
  "application/session/document-merge.ts#createDocumentMerge": { "bootstrap/wiring/document-merge.ts": 1 },
  "application/session/document-merge.ts#DocumentMerge.states": { "bootstrap/wiring/document-merge.ts": 1 },
  "application/session/document-merge.ts#DocumentMerge.apply": { "bootstrap/wiring/document-merge.ts": 1 },
  "application/session/document-merge.ts#DocumentMerge.report": { "bootstrap/wiring/document-merge.ts": 1 },
  "application/session/document-merge.ts#DocumentMergePorts.states": {
    "application/session/document-merge.ts": 2, "bootstrap/wiring/session-merge.ts": 1
  },
  "application/session/document-merge.ts#MergeOutcomeView.banner": { "application/session/document-merge.ts": 1 },
  "application/session/document-merge.ts#MergeOutcomeView.absorbed": { "application/session/document-merge.ts": 2 },
  "application/session/document-merge.ts#MergeOutcomeView.autoSave": { "application/session/document-merge.ts": 1 },
  "application/session/apply-merge.ts#applyIncomingMerge": { "application/session/document-merge.ts": 1 },
  "application/session/apply-merge.ts#ApplyMergePorts.merge": { "application/session/apply-merge.ts": 1 },
  "application/session/apply-merge.ts#ApplyMergePorts.adopt": {
    "application/session/apply-merge.ts": 1, "bootstrap/wiring/session-merge.ts": 1
  },
  "application/session/apply-merge.ts#ApplyMergePorts.snapshot": {
    "application/session/apply-merge.ts": 2, "bootstrap/wiring/session-merge.ts": 1
  },
  "application/session/apply-merge.ts#ApplyMergePorts.armUndo": {
    "application/session/apply-merge.ts": 1, "bootstrap/wiring/session-merge.ts": 1
  },
  "application/session/apply-merge.ts#ApplyMergePorts.setBase": {
    "application/session/apply-merge.ts": 1, "bootstrap/wiring/session-merge.ts": 1
  },
  "application/session/apply-merge.ts#ApplyMergePorts.noteHistoryFrom": {
    "application/session/apply-merge.ts": 1, "bootstrap/wiring/session-merge.ts": 1
  },
  "application/session/apply-merge.ts#MergeView.report": { "application/session/apply-merge.ts": 1 },
  "application/session/apply-merge.ts#MergeView.absorbedDirty": { "application/session/apply-merge.ts": 1 },
  "application/session/merge-incoming.ts#mergeIncoming": { "application/session/document-merge.ts": 1 },
  "application/session/session-merge-ports.ts#SessionMergeOwner.sessionMergePorts": { "bootstrap/wiring/session-merge.ts": 12 },
  "application/session/session-merge-ports.ts#SessionMergeSession.noteMerged": { "application/session/session-merge.ts": 1 },
  "application/session/session-merge-ports.ts#SessionMergeSession.noteRecovery": { "application/session/session-merge.ts": 1 },
  "application/session/session-merge-ports.ts#SessionMergeSession.noteDiskUpdate": { "application/session/session-merge.ts": 1 },
  "bootstrap/wiring/document-merge.ts#startMerge": { "bootstrap/wiring.ts": 1 },
  "bootstrap/wiring/document-merge.ts#documentMerge": {},
  "bootstrap/wiring/document-merge.ts#mergeStates": {},
  "bootstrap/wiring/document-merge.ts#applyMerge": { "bootstrap/wiring/drafts.ts": 1 },
  "bootstrap/wiring/document-merge.ts#reportMerge": { "bootstrap/wiring/startup.ts": 1 },
  "bootstrap/wiring/document-merge.ts#installMergeBanner": { "bootstrap/wiring/editor.ts": 1 },
  "bootstrap/wiring/session-merge.ts#sessionMergePorts": { "bootstrap/wiring.ts": 1 },
  "bootstrap/wiring/session-merge.ts#restoreMergeSnapshot": { "bootstrap/wiring/editor.ts": 1 },
  "bootstrap/wiring/merge-review.ts#offerFileMerge": { "bootstrap/wiring/ports/local-files.ts": 1 },
  "features/merge/local-merge.ts#startLocalMerge": { "bootstrap/wiring/merge-review.ts": 1 },
  "features/merge/ports.ts#MergeReviewControl.offer": { "bootstrap/wiring/merge-review.ts": 1 },
  "features/merge/ports.ts#MergeReviewControl.open": { "bootstrap/wiring/views.ts": 1 },
  "features/merge/ports.ts#MergeReviewControl.confirm": { "bootstrap/wiring/views.ts": 1 },
  "features/merge/ports.ts#MergeReviewControl.cancel": { "bootstrap/wiring/views.ts": 1 },
  "features/merge/ports.ts#MergeReviewPorts.recovery.applyStashedWork": { "features/merge/local-merge.ts": 1 },
  "features/merge/banner.ts#mountMergeBanner": { "bootstrap/wiring/editor.ts": 3 },
  "features/merge/banner.ts#MergeBanner.show": { "bootstrap/wiring/editor.ts": 1 },
  "features/merge/banner.ts#MergeBanner.undoMerge": {},
  "features/merge/banner.ts#MergeBannerPorts.lastUndo": { "features/merge/banner.ts": 2 },
  "features/merge/banner.ts#MergeBannerPorts.restore": { "features/merge/banner.ts": 1 },
  "features/file-menu/mount.ts#ConflictsPorts.openMergeReview": { "features/file-menu/mount.ts": 1 },
  "features/file-menu/mount.ts#ConflictsPorts.confirmFileMerge": { "features/file-menu/mount.ts": 1 },
  "features/file-menu/mount.ts#ConflictsPorts.cancelMergeReview": { "features/file-menu/mount.ts": 3 },
  "features/file-menu/local-files-ports.ts#LocalFileMenuPorts.merge.offer": { "features/file-menu/local-files.ts": 1 }
};

const STASH = {
  "application/recovery/conflict-stash.ts#createConflictStash": { "bootstrap/wiring/recovery-owners.ts": 1 },
  "application/recovery/conflict-stash.ts#ConflictStash.save": { "application/recovery/stashed-work.ts": 1 },
  "application/recovery/conflict-stash.ts#ConflictStash.read": { "application/recovery/stashed-work.ts": 1 },
  "application/recovery/conflict-stash.ts#ConflictStash.clear": { "application/recovery/stashed-work.ts": 1 },
  "application/recovery/conflict-stash.ts#ConflictStash.accept": { "application/recovery/stashed-work.ts": 1 },
  "application/recovery/conflict-stash.ts#ConflictStash.dropReloadGuard": { "application/recovery/stashed-work.ts": 1 },
  "application/recovery/stashed-work.ts#createLocalWorkStash": { "bootstrap/wiring/recovery-owners.ts": 1 },
  "application/recovery/stashed-work.ts#createStashedWork": { "bootstrap/wiring/recovery-owners.ts": 1 },
  "application/recovery/stashed-work.ts#StashMerge": {
    "application/recovery/stashed-work.ts": 1, "bootstrap/wiring/recovery-owners.ts": 1
  },
  "application/recovery/stashed-work.ts#ApplyStashedWork": {
    "application/recovery/drafts.ts": 1, "bootstrap/wiring/recovery-owners.ts": 1, "features/merge/local-merge.ts": 1
  },
  "application/recovery/stashed-work.ts#StashedWorkPorts.merge": { "application/recovery/stashed-work.ts": 1 },
  "application/recovery/stashed-work.ts#StashedWorkPorts.stash": { "application/recovery/stashed-work.ts": 4 },
  "application/recovery/stashed-work.ts#LocalWorkPorts.stash": { "application/recovery/stashed-work.ts": 1 },
  "bootstrap/wiring/recovery-owners.ts#startRecovery": { "bootstrap/wiring.ts": 1 },
  "bootstrap/wiring/recovery-owners.ts#conflictStash": {},
  "bootstrap/wiring/recovery-owners.ts#applyStashedWork": {
    "bootstrap/wiring/drafts.ts": 1, "bootstrap/wiring/merge-review.ts": 1, "bootstrap/wiring/startup.ts": 1
  },
  "bootstrap/wiring/recovery-owners.ts#stashLocalWork": { "bootstrap/wiring/ports/project-files.ts": 1 },
  "application/recovery/drafts-ports.ts#DraftRecovery.applyStashedWork": { "application/recovery/drafts.ts": 1 },
  "application/save/project-files.ts#ProjectFilesPorts.recovery.stash": { "application/save/project-files.ts": 1 },
  "bootstrap/startup/initial-document.ts#InitialDocumentPorts.applyStash": { "bootstrap/startup/initial-document.ts": 1 },
  "bootstrap/startup/initial-document.ts#InitialDocumentPorts.reportRecovery": { "bootstrap/startup/initial-document.ts": 1 }
};

const RELOAD = {
  "bootstrap/wiring/session-owner.ts#noteReload": { "bootstrap/wiring/ports/local-files.ts": 2 },
  "application/session/document-session.ts#StandaloneDocumentSession.absorbReload": { "bootstrap/wiring/session-owner.ts": 2 },
  "application/transitions/local-files-ports.ts#LocalFilesOwner.reloadProjectFromDisk": { "bootstrap/wiring/views.ts": 1 },
  "application/transitions/local-files-ports.ts#LocalFilesOwner.reloadFileFromDisk": { "bootstrap/wiring/views.ts": 1 },
  "application/transitions/local-files-ports.ts#LocalFilesOwnerPorts.session.noteReload": { "application/transitions/local-files.ts": 2 },
  "features/file-menu/mount.ts#ConflictsPorts.reloadProjectFromDisk": { "features/file-menu/mount.ts": 1 },
  "features/file-menu/mount.ts#ConflictsPorts.reloadFileFromDisk": { "features/file-menu/mount.ts": 1 }
};

let inventory: ReturnType<typeof capabilityPortCallers> | null = null;

function current() {
  inventory ??= capabilityPortCallers([...Object.keys(MERGE), ...Object.keys(STASH), ...Object.keys(RELOAD)], undefined, { references: true });
  return inventory;
}

for (const [family, expected] of [["merge", MERGE], ["stash", STASH], ["reload", RELOAD]] as const) {
  test(family + " callers stay at the audited capability boundaries regardless of receiver spelling", () => {
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, current()[key]])), expected);
  });
}

const APPLY = "application/session/document-merge.ts#DocumentMerge.apply";
const STASH_SAVE = "application/recovery/conflict-stash.ts#ConflictStash.save";
const RELOAD_PROJECT = "application/transitions/local-files-ports.ts#LocalFilesOwner.reloadProjectFromDisk";
const STASH_CALLBACK = "application/recovery/stashed-work.ts#ApplyStashedWork";
const WIRED_APPLY = "bootstrap/wiring/recovery-owners.ts#applyStashedWork";
const WIRED_RESTORE = "bootstrap/wiring/session-merge.ts#restoreMergeSnapshot";
const PROBE = "starters/recovery-capability-probe.ts";
const IMPORTS = `
  import type { DocumentMerge } from "../application/session/document-merge.ts";
  import type { ConflictStash } from "../application/recovery/conflict-stash.ts";
  import type { ApplyStashedWork } from "../application/recovery/stashed-work.ts";
  import type { LocalFilesOwner } from "../application/transitions/local-files-ports.ts";
  import type { CapabilityPort } from "../application/session/ports.ts";
  import { applyStashedWork } from "../bootstrap/wiring/recovery-owners.ts";
  import { restoreMergeSnapshot } from "../bootstrap/wiring/session-merge.ts";
`;

for (const [name, target, source, count] of [
  ["merge under a renamed receiver", APPLY, "function probe(s: DocumentMerge) { s.apply(null); }", 1],
  ["stash under a renamed receiver", STASH_SAVE, "function probe(s: ConflictStash) { s.save({}); }", 1],
  ["reload under a renamed receiver", RELOAD_PROJECT, "function probe(s: LocalFilesOwner) { s.reloadProjectFromDisk(); }", 1],
  ["an ignored merge answer", APPLY, "function probe(s: DocumentMerge, can: CapabilityPort) { can.merge(); s.apply(null); }", 1],
  ["an ignored stash answer", STASH_SAVE, "function probe(s: ConflictStash, can: CapabilityPort) { can.stash(); s.save({}); }", 1],
  ["an ignored reload answer", RELOAD_PROJECT, "function probe(s: LocalFilesOwner, can: CapabilityPort) { can.reload(); s.reloadProjectFromDisk(); }", 1],
  ["a computed merge key", APPLY, 'function probe(s: DocumentMerge) { const key = "apply"; s[key](null); }', 1],
  ["a union stash key", STASH_SAVE, 'function probe(s: ConflictStash, key: "save" | "clear") { void s[key]; }', 1],
  ["an unbounded reload key", RELOAD_PROJECT, "function probe(s: LocalFilesOwner, key: string) { void s[key]; }", 1],
  ["a merge parameter binding", APPLY, "function probe({ apply: next }: DocumentMerge) { next(null); }", 2],
  ["a stash nested binding", STASH_SAVE, "function probe(p: { stash: ConflictStash }) { const { stash: { save: next } } = p; next({}); }", 2],
  ["a reload assignment binding", RELOAD_PROJECT, "function probe(s: LocalFilesOwner) { let next; ({ reloadProjectFromDisk: next } = s); }", 1],
  ["a transported callback", STASH_CALLBACK, 'type Alias = ApplyStashedWork<{ docId: string }, unknown>; function probe(next: Alias) { next({ docId: "x" }, null); }', 1],
  ["a transported callback property", STASH_CALLBACK, 'type Alias = ApplyStashedWork<{ docId: string }, unknown>; function probe(p: { next: Alias }) { p.next({ docId: "x" }, null); }', 1],
  ["a transported callback binding", STASH_CALLBACK, 'type Alias = ApplyStashedWork<{ docId: string }, unknown>; function probe(p: { next: Alias }) { const { next } = p; next({ docId: "x" }, null); }', 2],
  ["a callback call method", STASH_CALLBACK, 'type Alias = ApplyStashedWork<{ docId: string }, unknown>; function probe(next: Alias) { next.call(null, { docId: "x" }, null); }', 1],
  ["a wired function called directly", WIRED_APPLY, "applyStashedWork(null!, null);", 1],
  ["a wired function handed on as a port", WIRED_APPLY, "export const ports = { recovery: { apply: applyStashedWork } };", 1],
  ["a wired function handed on under its own name", WIRED_APPLY, "export const ports = { applyStashedWork };", 1],
  ["a wired function kept in a variable", WIRED_APPLY, "const later = applyStashedWork; void later;", 1],
  ["a wired function passed as an argument", WIRED_APPLY, "[null].map(applyStashedWork as never);", 1],
  ["a wired arrow constant handed on as a port", WIRED_RESTORE, "export const ports = { restore: restoreMergeSnapshot };", 1],
  ["a wired arrow constant called directly", WIRED_RESTORE, 'void restoreMergeSnapshot("s1");', 1]
] as const) {
  test("local recovery caller scan self-test: " + name, () => {
    assert.deepEqual(capabilityPortCallers([target], { path: PROBE, source: IMPORTS + source }, { references: true }), {
      [target]: { [PROBE]: count }
    });
  });
}

test("local recovery caller scan self-test: importing a wired function without using it is not a caller", () => {
  assert.deepEqual(capabilityPortCallers([WIRED_APPLY, WIRED_RESTORE], { path: PROBE, source: IMPORTS }, { references: true }), {
    [WIRED_APPLY]: {}, [WIRED_RESTORE]: {}
  });
});

test("local recovery caller scan self-test: namespace aliases preserve the called declaration", () => {
  const target = "application/session/apply-merge.ts#applyIncomingMerge";
  assert.deepEqual(capabilityPortCallers([target], { path: PROBE, source: `
    import * as bridge from "../application/session/apply-merge.ts";
    const key = "applyIncomingMerge";
    bridge[key](null!, null!);
  ` }, { references: true }), { [target]: { [PROBE]: 1 } });
});
