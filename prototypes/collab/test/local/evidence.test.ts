import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Y from "yjs";
import { localHistoryArtifacts, readLocalEvidence } from "../../src/local/report.ts";
import { localReplicaKey } from "../../src/local/store.ts";
import { checkLocalBytes, checkLocalHydrationRefusal, checkLocalReceipts } from "./oracles.ts";
import type { LocalBrowserSnapshot, LocalHydrationObservation } from "./oracles.ts";

const evidence = readLocalEvidence();

function observation(prefix: string): unknown {
  const result = evidence.cases.find(result => result.name.startsWith(prefix));
  assert.ok(result, prefix);
  return result.observation;
}

test("local evidence records the browser version, 26 passing cases and the remaining STORE limits", () => {
  assert.match(String(evidence.version.product), /^Edg\/\d/);
  assert.equal(evidence.node, "v24.22.1");
  assert.equal(evidence.cases.length, 26);
  assert.equal(new Set(evidence.cases.map(result => result.name)).size, 26);
  for (const result of evidence.cases) assert.equal(result.status, "PASS", result.error);
  assert.deepEqual(evidence.unresolved.map(item => item.question), ["STORE 3", "STORE 4", "STORE 5", "STORE 7 integration"]);
  assert.ok(evidence.cases[0]?.name.startsWith("defect: writer without"));
  assert.ok(evidence.cases[1]?.name.startsWith("defect: saved before"));
  assert.ok(evidence.cases[2]?.name.startsWith("defect: editing on lock"));
});

test("T24's harness-owned receipt ledger survives a renderer crash with a real identity oracle", () => {
  const result = observation("T24: two tabs") as { receipts: number[]; refused: LocalBrowserSnapshot; recovered: LocalBrowserSnapshot };
  assert.deepEqual(result.receipts, [1, 2, 3, 4]);
  assert.equal(result.refused.writable, false); assert.match(result.refused.explanation, /another tab/);
  assert.equal(result.recovered.writable, true); checkLocalReceipts(result.receipts, result.recovered);
  const defective = observation("defect: saved before") as { receipts: number[]; recovered: LocalBrowserSnapshot };
  assert.deepEqual(defective.receipts, [1, 2]);
  assert.throws(() => checkLocalReceipts(defective.receipts, defective.recovered), /Saved 2, recovered only 1/);
});

test("the local checker rejects copied character identities even if the characters match", () => {
  const copy = new Y.Doc();
  copy.clientID = 999;
  const text = copy.getText("flow");
  text.insertEmbed(0, { b: "R1" }); text.insert(1, "a");
  const beat = new Y.Map(); copy.getMap("beats").set("R1", beat);
  beat.set("removals", new Y.Map()); beat.set("joins", new Y.Map());
  assert.throws(() => checkLocalBytes([...Y.encodeStateAsUpdate(copy)], 1), /identity/);
  copy.destroy();
});

test("the unlocked defect is rejected against the preexisting committed identities", () => {
  const result = observation("defect: writer without") as { recovered: LocalBrowserSnapshot; browserLocks: { held: unknown[] } };
  assert.equal(result.browserLocks.held.length, 1);
  checkLocalBytes(result.recovered.editor, 2);
  assert.throws(() => checkLocalBytes(result.recovered.editor, 1), /characters/);
});

test("synchronous capture includes bytes, sequence and the copied asset manifest before later edits", () => {
  const result = observation("minimal: transaction gate") as { held: LocalBrowserSnapshot; completed: LocalBrowserSnapshot; recovered: LocalBrowserSnapshot };
  assert.equal(result.held.probe?.completed, 0); assert.deepEqual(result.held.saved, []);
  assert.deepEqual(result.completed.saved, [1]); assert.equal(result.completed.status, "Saving on this device");
  assert.deepEqual(result.completed.probe?.durability, ["strict"]);
  checkLocalReceipts([1], result.recovered); assert.equal(result.recovered.sequence, 1);
  assert.deepEqual(result.recovered.manifest, ["image-A"]);
});

test("holding hydration prevents writable startup and a real reload preserves saved identities", () => {
  const result = observation("T24 hydration:") as { attempt: LocalHydrationObservation; hydrated: LocalBrowserSnapshot; edited: LocalBrowserSnapshot };
  assert.equal(result.attempt.entered, localReplicaKey({ deployment: "deployment-A", instance: "hydrate" }));
  assert.equal(result.attempt.during.status, "Hydrating"); checkLocalHydrationRefusal(result.attempt);
  assert.equal(result.hydrated.writable, true); checkLocalReceipts([1], result.hydrated);
  checkLocalBytes(result.edited.editor, 2);
  const defective = observation("defect: editing on lock") as { attempt: LocalHydrationObservation };
  assert.equal(defective.attempt.entered, localReplicaKey({ deployment: "deployment-A", instance: "defect-hydrate" }));
  assert.equal(defective.attempt.editRefused, false); assert.equal(defective.attempt.during.writable, true);
  assert.throws(() => checkLocalHydrationRefusal(defective.attempt), /Editing allowed before hydration completed/);
  const reload = observation("minimal: real page reload") as { receipts: number[]; recovered: LocalBrowserSnapshot };
  assert.deepEqual(reload.receipts, [1, 2]); checkLocalReceipts(reload.receipts, reload.recovered);
});

for (const prefix of ["minimal: aborted transaction", "minimal: missing required blob"]) {
  test(`${prefix} leaves only the previous generation saved`, () => {
    const result = observation(prefix) as { failed: LocalBrowserSnapshot; recovered: LocalBrowserSnapshot };
    assert.equal(result.failed.status, "Could not save on this device"); assert.deepEqual(result.failed.saved, [1]);
    checkLocalBytes(result.failed.editor, 2); checkLocalReceipts([1], result.recovered); assert.equal(result.recovered.sequence, 1);
  });
}

test("quota failures are real browser aborts with and without requesting persistent storage", () => {
  const outcomes = observation("minimal: CDP quota") as { requestPersistence: boolean; quota: { quota: number; overrideActive: boolean }; failed: LocalBrowserSnapshot; recovered: LocalBrowserSnapshot }[];
  assert.deepEqual(outcomes.map(item => item.requestPersistence), [false, true]);
  for (const result of outcomes) {
    assert.equal(result.quota.overrideActive, true); assert.equal(result.quota.quota, 1024 * 1024);
    assert.equal(result.failed.status, "Could not save on this device"); assert.match(result.failed.errors.join(" "), /QuotaExceeded/);
    checkLocalBytes(result.failed.editor, 2); checkLocalReceipts([1], result.recovered); assert.equal(result.recovered.sequence, 1);
  }
});

test("versionchange invalidates the writable session and a mid-write crash preserves saved coverage", () => {
  const version = observation("minimal: versionchange") as LocalBrowserSnapshot;
  assert.equal(version.writable, false); assert.equal(version.status, "Could not save on this device");
  const crash = observation("minimal: crash mid-write") as { held: LocalBrowserSnapshot; recovered: LocalBrowserSnapshot };
  assert.equal(crash.held.status, "Saving on this device"); checkLocalReceipts([1], crash.recovered); assert.equal(crash.recovered.sequence, 1);
});

test("M3 keeps distinct documents, exposes the split-write control, and rolls back one atomic transaction", () => {
  const distinct = observation("M3 capture:") as LocalBrowserSnapshot;
  checkLocalBytes(distinct.editor, 2); checkLocalBytes(distinct.network, 3);
  const split = observation("M3 control:") as { recovered: LocalBrowserSnapshot };
  checkLocalBytes(split.recovered.editor, 1); checkLocalBytes(split.recovered.network, 2);
  assert.throws(() => checkLocalReceipts([1], split.recovered));
  const atomic = observation("M3 atomic:") as { gap: LocalBrowserSnapshot; recovered: LocalBrowserSnapshot; complete: LocalBrowserSnapshot };
  assert.equal(atomic.gap.probe?.completed, 0); checkLocalReceipts([1], atomic.recovered);
  assert.deepEqual(atomic.recovered.manifest, ["image-old"]);
  checkLocalReceipts([1, 2], atomic.complete); assert.deepEqual(atomic.complete.manifest, ["image-old", "image-new"]);
});

test("library initial sync and custom request promises both resolve before transaction completion", () => {
  const request = observation("library: request-success") as LocalBrowserSnapshot;
  assert.equal(request.probe?.completed, 0);
  const initial = observation("library: initial whenSynced") as { loaded: LocalBrowserSnapshot; recovered: LocalBrowserSnapshot };
  assert.equal(initial.loaded.synced, true); assert.equal(initial.loaded.probe?.completed, 0);
  assert.throws(() => checkLocalBytes(initial.recovered.editor, 1));
});

for (const prefix of ["library: abort gives", "library: crash with held"]) {
  test(`${prefix} leaves synced true while the uncommitted identity disappears`, () => {
    const result = observation(prefix) as { failed?: LocalBrowserSnapshot; held?: LocalBrowserSnapshot; recovered: LocalBrowserSnapshot };
    assert.equal((result.failed ?? result.held)?.synced, true);
    checkLocalBytes(result.recovered.editor, 1); assert.throws(() => checkLocalBytes(result.recovered.editor, 2));
  });
}

test("library quota failure and versionchange leave synced true; compaction recovers deletes", () => {
  const quota = observation("library: CDP quota") as { failed: { synced: boolean }; recovered: LocalBrowserSnapshot };
  assert.equal(quota.failed.synced, true); assert.equal(quota.recovered.largeSize, 0); checkLocalBytes(quota.recovered.editor, 1);
  const version = observation("library: versionchange") as LocalBrowserSnapshot; assert.equal(version.synced, true);
  const compacted = observation("library: successful writes") as { before: number; after: number; recovered: LocalBrowserSnapshot };
  assert.ok(compacted.after < compacted.before); checkLocalBytes(compacted.recovered.editor, 4);
});

test("actual app history captures the intended shared docId but excludes replica and credential stores", () => {
  const result = observation("STORE 6:") as { opened: string; captured: number; exported: string[]; replicaExcluded: boolean; credentialsExcluded: boolean };
  assert.equal(result.opened, `d${"7".repeat(32)}`); assert.equal(result.captured, 1); assert.ok(result.exported.includes(result.opened));
  assert.equal(result.replicaExcluded, true); assert.equal(result.credentialsExcluded, true);
});

test("startup evidence records resume after hydration and a desktop file before hydrate followed by a draft", () => {
  const result = observation("STORE 7:") as { browser: { events: string[]; final: string }; desktop: { events: string[]; final: string } };
  assert.equal(result.browser.final, "last-project"); assert.equal(result.desktop.final, "draft");
  assert.ok(result.browser.events.indexOf("resumeLastProject") > result.browser.events.indexOf("hydrate-release"));
  assert.ok(result.desktop.events.indexOf("open:file:fixture open-file delivery") < result.desktop.events.indexOf("hydrate-release"));
  assert.ok(result.desktop.events.indexOf("applyTakenDraft") > result.desktop.events.indexOf("firstDraw"));
});

test("deployment and instance keys remain distinct even when their delimiters coincide", () => {
  assert.notEqual(localReplicaKey({ deployment: "a:b", instance: "c" }), localReplicaKey({ deployment: "a", instance: "b:c" }));
});

test("minimized local failure histories reproduce the retained browser evidence", () => {
  const artifacts = localHistoryArtifacts(evidence);
  assert.equal(artifacts.size, 6);
  for (const [name, body] of artifacts) assert.equal(readFileSync(new URL(`../../histories/${name}`, import.meta.url), "utf8"), body);
});
