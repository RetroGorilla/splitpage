import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { withSliceBrowser } from "../slice/protocol.ts";
import { localBrowserPage, localBrowserDocument, crashLocalRenderer, reloadLocalPage } from "./browser.ts";
import type { LocalBrowserPage } from "./browser.ts";
import { checkLocalBytes, checkLocalHydrationRefusal, checkLocalReceipts, localFixture } from "../../test/local/oracles.ts";
import type { LocalBrowserSnapshot, LocalHydrationObservation } from "../../test/local/oracles.ts";
import { localReplicaKey } from "./store.ts";
import { serializeLocalEvidence, writeLocalHistories } from "./report.ts";

export interface LocalExperimentEvidence {
  version: Record<string, unknown>;
  node: string;
  unresolved: { question: string; observation: string; required: string }[];
  cases: { name: string; status: "PASS" | "FAIL"; observation: unknown; error?: string }[];
}

async function invoke<T = LocalBrowserSnapshot>(page: LocalBrowserPage, method: string, ...args: unknown[]): Promise<T> {
  return page.protocol.evaluate(`localExperiment[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
}

const fixture = localFixture();
const scope = (instance: string) => ({ deployment: "deployment-A", instance });

await withSliceBrowser(async (control, version) => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../../test/local/page.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
  const script = bundle.outputFiles?.[0]?.text;
  assert.ok(script);
  const startupBundle = await build({ entryPoints: [fileURLToPath(new URL("../../../../src/bootstrap/startup.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", globalName: "LocalStartupUnderTest", target: "es2023" });
  const startupScript = startupBundle.outputFiles?.[0]?.text;
  assert.ok(startupScript);
  const evidence: LocalExperimentEvidence = { version, node: process.version, cases: [], unresolved: [
    { question: "STORE 3", observation: "Only headless Edge on Windows was run. Quota failure is not storage eviction.", required: "Retention and persist() runs on the other supported browsers, with and without a grant." },
    { question: "STORE 4", observation: "Offline storage hydration works with a shell supplied by CDP. No HTTP host was started.", required: "Actual service-worker install/offline cold start and skipWaiting takeover on each supported browser." },
    { question: "STORE 5", observation: "Browser-only lane; Electron was not launched, as instructed.", required: "safeStorage.isEncryptionAvailable() in the main process on target Windows, macOS and Linux." },
    { question: "STORE 7 integration", observation: "The unmodified beginStartup entry is run with controlled ports and delayed load. Actual last-file handles, desktop IPC and draft backends are not wired by this prototype.", required: "Repeat the observed startup ordering with real shared-session wiring; no delayed-load app hook was added." }
  ] };
  const pages = new Set<LocalBrowserPage>();
  const fresh = async (origin?: string): Promise<LocalBrowserPage> => { const page = await localBrowserPage(control, startupScript + "\n" + script, origin); pages.add(page); return page; };
  const drop = async (page: LocalBrowserPage): Promise<void> => { await page.dispose(); pages.delete(page); };
  const run = async (name: string, body: () => Promise<unknown>): Promise<void> => {
    await test(name, async () => {
      try {
        const observation = await body();
        evidence.cases.push({ name, status: "PASS", observation });
      } catch (error) {
        evidence.cases.push({ name, status: "FAIL", observation: null, error: String(error) });
        throw error;
      }
    });
    process.stdout.write(`${name}: ${evidence.cases.at(-1)?.status}\n`);
  };
  const apply = async (page: LocalBrowserPage, sequence: number): Promise<void> => { await invoke(page, "apply", fixture.updates[sequence - 1], sequence); };
  const commit = async (page: LocalBrowserPage): Promise<LocalBrowserSnapshot> => { await invoke(page, "save"); return invoke(page, "settled"); };
  const hydrationAttempt = async (instance: string, earlyEditing: boolean): Promise<{ attempt: LocalHydrationObservation; hydrated: LocalBrowserSnapshot; edited: LocalBrowserSnapshot }> => {
    const a = await fresh(); const b = await fresh();
    await invoke(a, "open", scope(instance), "minimal"); await apply(a, 1); await commit(a); await invoke(a, "close");
    await invoke(b, "blockHydration", scope(instance));
    await invoke(a, "expectHydrationEntry");
    const opening = invoke(a, "open", scope(instance), "minimal", false, earlyEditing);
    let attempt: LocalHydrationObservation;
    try {
      const entered = await invoke<string>(a, "hydrationEntered");
      assert.equal(entered, localReplicaKey(scope(instance)));
      const during = await invoke(a, "snapshot");
      assert.equal(during.status, "Hydrating");
      let editRefused = false;
      try { await apply(a, 2); }
      catch (error) { assert.match(String(error), /Read-only/); editRefused = true; }
      attempt = { entered, during, editRefused };
      if (earlyEditing) assert.throws(() => checkLocalHydrationRefusal(attempt), /Editing allowed before hydration completed/);
      else checkLocalHydrationRefusal(attempt);
    } finally { await invoke(b, "unblockHydration"); }
    const hydrated = await opening;
    assert.equal(hydrated.writable, true);
    await apply(a, 2);
    const edited = await invoke(a, "snapshot");
    checkLocalBytes(edited.editor, 2); assert.equal(edited.sequence, 2);
    await drop(a); await drop(b);
    return { attempt, hydrated, edited };
  };
  try {
    await run("defect: writer without the Web Lock is rejected by the checker", async () => {
      const a = await fresh(); const b = await fresh();
      await invoke(a, "open", scope("defect-lock"), "minimal");
      await apply(a, 1); await commit(a);
      const refused = await invoke(b, "open", scope("defect-lock"), "minimal");
      assert.equal(refused.writable, false);
      await assert.rejects(() => apply(b, 1), /Read-only/);
      const browserLocks = await b.protocol.evaluate<{ held: { name: string }[] }>("navigator.locks.query()");
      assert.ok(browserLocks.held.some(lock => lock.name === `splitpage:${localReplicaKey(scope("defect-lock"))}`));
      await invoke(b, "unsafeWrite", fixture.updates[1], 2);
      await invoke(a, "close");
      const recovered = await invoke(b, "open", scope("defect-lock"), "minimal");
      const checker = () => { checkLocalBytes(recovered.editor, 1); };
      assert.throws(checker, /characters/);
      await drop(a); await drop(b);
      return { refused, browserLocks, recovered, defect: "Write without lock" };
    });
    await run("defect: saved before commit loses a harness-recorded receipt on crash", async () => {
      const a = await fresh(); await invoke(a, "open", scope("defect-saved"), "minimal");
      await apply(a, 1); await commit(a);
      await invoke(a, "gate", true); await apply(a, 2); await invoke(a, "save", true);
      const claim = await invoke(a, "held");
      assert.equal(claim.probe?.completed, 0); assert.deepEqual(claim.saved, [1, 2]);
      assert.equal(claim.status, "Saved on this device");
      const receipts = [1, 2];
      await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("defect-saved"), "minimal", true);
      assert.throws(() => checkLocalReceipts(receipts, recovered), /Saved 2, recovered only 1/);
      await drop(a); await drop(b);
      return { receipts, recovered, rejection: "Saved 2, recovered only 1" };
    });
    await run("defect: editing on lock acquisition before hydration is rejected", async () => {
      const result = await hydrationAttempt("defect-hydrate", true);
      assert.equal(result.attempt.during.writable, true); assert.equal(result.attempt.editRefused, false);
      assert.throws(() => checkLocalHydrationRefusal(result.attempt), /Editing allowed before hydration completed/);
      return result;
    });
    await run("T24: two tabs, renderer crash, lock handoff and hydrated saved identities", async () => {
      const a = await fresh(); const b = await fresh();
      assert.equal((await invoke(a, "open", scope("T24"), "minimal")).writable, true);
      const receipts: number[] = [];
      for (const sequence of [1, 2, 3, 4]) {
        await apply(a, sequence); const claim = await commit(a);
        assert.equal(claim.status, "Saved on this device");
        receipts.push(sequence);
      }
      const refused = await invoke(b, "open", scope("T24"), "minimal");
      assert.equal(refused.writable, false); assert.match(refused.explanation, /another tab/);
      await assert.rejects(() => apply(b, 1), /Read-only/);
      await crashLocalRenderer(a);
      const recovered = await invoke(b, "open", scope("T24"), "minimal", true);
      assert.equal(recovered.writable, true); checkLocalReceipts(receipts, recovered);
      await drop(a); await drop(b);
      return { receipts, refused, recovered };
    });
    await run("minimal: transaction gate prevents saved; synchronous capture excludes later edits and assets", async () => {
      const a = await fresh(); await invoke(a, "open", scope("capture"), "minimal"); await apply(a, 1);
      await invoke(a, "asset", "image-A", [1, 2, 3]); await invoke(a, "gate", true); await invoke(a, "save");
      await apply(a, 2); await invoke(a, "mutateAsset", "image-A");
      const held = await invoke(a, "held");
      assert.equal(held.status, "Saving on this device"); assert.deepEqual(held.saved, []); assert.equal(held.probe?.completed, 0);
      await invoke(a, "release"); const completed = await invoke(a, "settled");
      assert.deepEqual(completed.saved, [1]); assert.equal(completed.status, "Saving on this device");
      assert.deepEqual(completed.probe?.durability, ["strict"]);
      await invoke(a, "close"); const recovered = await invoke(a, "open", scope("capture"), "minimal");
      checkLocalBytes(recovered.editor, 1); checkLocalBytes(recovered.network, 1);
      assert.deepEqual(recovered.manifest, ["image-A"]); assert.deepEqual(await invoke(a, "readAsset", "image-A"), [1, 2, 3]);
      await drop(a);
      return { held, completed, recovered };
    });
    await run("T24 hydration: holding a storage transaction prevents writable startup and editing", async () => {
      const result = await hydrationAttempt("hydrate", false);
      checkLocalHydrationRefusal(result.attempt);
      checkLocalReceipts([1], result.hydrated);
      return result;
    });
    await run("minimal: real page reload releases its lock and hydrates confirmed binary state", async () => {
      const a = await fresh(); await invoke(a, "open", scope("reload"), "minimal"); await apply(a, 1); await commit(a);
      await apply(a, 2); const claim = await commit(a);
      assert.equal(claim.status, "Saved on this device");
      await reloadLocalPage(a);
      const recovered = await invoke(a, "open", scope("reload"), "minimal", true);
      checkLocalReceipts([1, 2], recovered); assert.equal(recovered.writable, true);
      await drop(a); return { receipts: [1, 2], recovered };
    });
    await run("M3 capture: distinct network and editor documents survive together", async () => {
      const a = await fresh(); await invoke(a, "open", scope("M3-distinct"), "minimal");
      await apply(a, 2); await invoke(a, "applyNetwork", fixture.updates[2]); await commit(a);
      await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("M3-distinct"), "minimal", true);
      checkLocalBytes(recovered.editor, 2); checkLocalBytes(recovered.network, 3);
      await drop(a); await drop(b); return recovered;
    });
    await run("minimal: aborted transaction preserves memory and previous committed replica", async () => {
      const a = await fresh(); await invoke(a, "open", scope("abort"), "minimal"); await apply(a, 1); await commit(a);
      await invoke(a, "gate", false, true); await apply(a, 2); const failed = await commit(a);
      assert.equal(failed.status, "Could not save on this device"); assert.deepEqual(failed.saved, [1]); checkLocalBytes(failed.editor, 2);
      await invoke(a, "close"); const recovered = await invoke(a, "open", scope("abort"), "minimal");
      checkLocalReceipts([1], recovered); assert.equal(recovered.sequence, 1); await drop(a);
      return { failed, recovered };
    });
    await run("minimal: missing required blob aborts the whole replica transaction", async () => {
      const a = await fresh(); await invoke(a, "open", scope("missing-blob"), "minimal"); await apply(a, 1); await commit(a);
      await apply(a, 2); await invoke(a, "missingAsset", "missing"); const failed = await commit(a);
      assert.equal(failed.status, "Could not save on this device"); assert.deepEqual(failed.saved, [1]);
      await invoke(a, "close"); const recovered = await invoke(a, "open", scope("missing-blob"), "minimal");
      checkLocalReceipts([1], recovered); assert.deepEqual(recovered.manifest, []); await drop(a);
      return { failed, recovered };
    });
    await run("minimal: CDP quota exhaustion fails without advancing saved coverage", async () => {
      const outcomes: unknown[] = [];
      for (const requestPersistence of [false, true]) {
        const origin = `https://minimal-quota-${String(requestPersistence)}.test`;
        const a = await fresh(origin);
        const persistence = await invoke(a, "persist", requestPersistence);
        await a.protocol.call("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1024 * 1024 });
        await invoke(a, "open", scope("quota"), "minimal"); await apply(a, 1); await commit(a);
        const quota = await a.protocol.call("Storage.getUsageAndQuota", { origin });
        assert.equal(quota.overrideActive, true); assert.equal(quota.quota, 1024 * 1024);
        try {
          await apply(a, 2); await invoke(a, "largeAsset", 16 * 1024 * 1024); const failed = await commit(a);
          assert.equal(failed.status, "Could not save on this device"); assert.deepEqual(failed.saved, [1]);
          assert.match(failed.errors.join(" "), /QuotaExceeded/); checkLocalBytes(failed.editor, 2);
          await invoke(a, "close"); const recovered = await invoke(a, "open", scope("quota"), "minimal");
          checkLocalReceipts([1], recovered); assert.equal(recovered.sequence, 1);
          outcomes.push({ requestPersistence, persistence, quota, failed, recovered });
        } finally { await a.protocol.call("Storage.overrideQuotaForOrigin", { origin }); await drop(a); }
      }
      return outcomes;
    });
    await run("minimal: versionchange closes storage, releases ownership and refuses an old schema", async () => {
      const a = await fresh(); const b = await fresh(); await invoke(a, "open", scope("version"), "minimal"); await apply(a, 1); await commit(a);
      assert.equal(await invoke(b, "upgrade", `local-replica:${localReplicaKey(scope("version"))}`), 2);
      const invalidated = await invoke(a, "snapshot");
      assert.equal(invalidated.writable, false); assert.equal(invalidated.status, "Could not save on this device");
      await assert.rejects(() => apply(a, 2), /Read-only/);
      await assert.rejects(() => invoke(b, "open", scope("version"), "minimal", true), /VersionError/);
      await drop(a); await drop(b); return invalidated;
    });
    await run("minimal: crash mid-write preserves the previous complete generation", async () => {
      const a = await fresh(); await invoke(a, "open", scope("mid-write"), "minimal"); await apply(a, 1); const committed = await commit(a);
      assert.equal(committed.status, "Saved on this device");
      await invoke(a, "gate", true); await apply(a, 2); await invoke(a, "save");
      const held = await invoke(a, "held"); assert.equal(held.status, "Saving on this device"); await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("mid-write"), "minimal", true);
      checkLocalReceipts([1], recovered); assert.equal(recovered.sequence, 1);
      await drop(a); await drop(b); return { held, recovered };
    });
    await run("M3 control: separate transactions leave network and editor inconsistent after crash", async () => {
      const a = await fresh(); await invoke(a, "open", scope("M3-split"), "minimal"); await apply(a, 1); await commit(a);
      await apply(a, 2); await invoke(a, "splitWrite", "network"); await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("M3-split"), "minimal", true);
      checkLocalBytes(recovered.editor, 1); checkLocalBytes(recovered.network, 2); assert.throws(() => checkLocalReceipts([1], recovered));
      await drop(a); await drop(b);
      return { recovered, rejection: "Network has generation 2; editor and metadata have generation 1" };
    });
    await run("M3 atomic: crash after network put succeeds rolls back documents and image manifest together", async () => {
      const a = await fresh(); await invoke(a, "open", scope("M3-atomic"), "minimal");
      await apply(a, 1); await invoke(a, "asset", "image-old", [1]); await commit(a);
      await apply(a, 2); await invoke(a, "asset", "image-new", [2]); await invoke(a, "gate", true); await invoke(a, "beginAtomicGap");
      const gap = await invoke(a, "atomicGap"); assert.equal(gap.probe?.completed, 0); await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("M3-atomic"), "minimal", true);
      checkLocalReceipts([1], recovered); assert.equal(recovered.sequence, 1); assert.deepEqual(recovered.manifest, ["image-old"]);
      assert.equal(await invoke(b, "readAsset", "image-new"), null);
      await apply(b, 2); await invoke(b, "asset", "image-new", [2]); await commit(b);
      await invoke(b, "close"); const complete = await invoke(b, "open", scope("M3-atomic"), "minimal");
      checkLocalReceipts([1, 2], complete); assert.deepEqual(complete.manifest, ["image-old", "image-new"]);
      await drop(a); await drop(b); return { phase: "network put request succeeded, before editor and manifest writes", gap, recovered, complete };
    });
    await run("library: request-success promise resolves while transaction is held uncommitted", async () => {
      const a = await fresh(); await invoke(a, "open", scope("library-request"), "library"); await invoke(a, "libraryFence"); await invoke(a, "gate", true);
      const returned = await invoke(a, "librarySet"); assert.equal(returned.probe?.completed, 0); assert.equal(returned.probe?.opened, 1);
      await crashLocalRenderer(a);
      const b = await fresh(); await invoke(b, "open", scope("library-request"), "library", true);
      assert.equal(await invoke(b, "libraryGet"), undefined);
      await drop(a); await drop(b); return returned;
    });
    await run("library: initial whenSynced resolves before its transaction commits", async () => {
      const a = await fresh();
      const loaded = await invoke(a, "libraryInitial", scope("library-initial"), fixture.updates[0]);
      assert.equal(loaded.synced, true); assert.equal(loaded.probe?.completed, 0); checkLocalBytes(loaded.editor, 1);
      await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("library-initial"), "library");
      assert.throws(() => checkLocalBytes(recovered.editor, 1));
      await drop(a); await drop(b); return { loaded, recovered };
    });
    await run("library: successful writes and compaction recover identities after a causal read fence", async () => {
      const a = await fresh(); await invoke(a, "open", scope("library-replay"), "library");
      for (const sequence of [1, 2, 3, 4]) await apply(a, sequence);
      const before = await invoke<number>(a, "libraryFence"); await invoke(a, "compact"); const after = await invoke<number>(a, "libraryFence");
      assert.ok(after < before); await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("library-replay"), "library", true); checkLocalBytes(recovered.editor, 4);
      await drop(a); await drop(b); return { before, after, recovered };
    });
    await run("library: abort gives no write receipt and synced remains true while work is lost", async () => {
      const a = await fresh(); await invoke(a, "open", scope("library-abort"), "library"); await apply(a, 1); await invoke(a, "libraryFence");
      await invoke(a, "gate", false, true); await apply(a, 2); await invoke(a, "libraryFence");
      const failed = await invoke(a, "snapshot"); assert.equal(failed.synced, true); assert.equal(failed.probe?.aborted, 1); checkLocalBytes(failed.editor, 2);
      await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("library-abort"), "library", true); checkLocalBytes(recovered.editor, 1);
      await drop(a); await drop(b); return { failed, recovered };
    });
    await run("library: CDP quota failure leaves synced true without durable new state", async () => {
      const origin = "https://library-quota.test";
      const a = await fresh(origin);
      await a.protocol.call("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1024 * 1024 });
      await invoke(a, "open", scope("library-quota"), "library"); await apply(a, 1); await invoke(a, "libraryFence");
      const quota = await a.protocol.call("Storage.getUsageAndQuota", { origin });
      assert.equal(quota.overrideActive, true); assert.equal(quota.quota, 1024 * 1024);
      try {
        await invoke(a, "gate", false); await invoke(a, "libraryLargeUpdate"); await invoke(a, "libraryFence");
        const failed = await invoke(a, "metadata"); assert.equal(failed.synced, true); assert.equal(failed.largeSize, 16 * 1024 * 1024); await crashLocalRenderer(a);
        assert.equal(failed.probe?.aborted, 1);
        assert.deepEqual(failed.probe.errors, ["QuotaExceededError"]);
        const b = await fresh(origin); const recovered = await invoke(b, "open", scope("library-quota"), "library", true); checkLocalBytes(recovered.editor, 1); assert.equal(recovered.largeSize, 0);
        await drop(b); return { quota, failed: { synced: failed.synced, errors: failed.errors }, recovered };
      } finally { await a.protocol.call("Storage.overrideQuotaForOrigin", { origin }); await drop(a); }
    });
    await run("library: versionchange closes connection but synced still permits misleading save inference", async () => {
      const a = await fresh(); const b = await fresh(); await invoke(a, "open", scope("library-version"), "library"); await apply(a, 1); await invoke(a, "libraryFence");
      assert.equal(await invoke(b, "upgrade", `library:${localReplicaKey(scope("library-version"))}`), 2);
      await assert.rejects(() => apply(a, 2), /InvalidStateError/);
      const failed = await invoke(a, "snapshot"); assert.equal(failed.synced, true);
      await drop(a); await drop(b); return failed;
    });
    await run("library: crash with held update rolls back it despite synced being true", async () => {
      const a = await fresh(); await invoke(a, "open", scope("library-crash"), "library"); await apply(a, 1); await invoke(a, "libraryFence");
      await invoke(a, "gate", true); await apply(a, 2); const held = await invoke(a, "held");
      assert.equal(held.synced, true); assert.equal(held.probe?.completed, 0); await crashLocalRenderer(a);
      const b = await fresh(); const recovered = await invoke(b, "open", scope("library-crash"), "library", true); checkLocalBytes(recovered.editor, 1);
      await drop(a); await drop(b); return { held, recovered };
    });
    await run("STORE 3: Edge persistent-storage request and quota observations", async () => {
      const a = await fresh(); const before = await invoke(a, "persist", false); const requested = await invoke(a, "persist", true); await drop(a);
      return { before, requested, scope: "Headless Edge temporary profile only; no eviction simulation or other-browser evidence" };
    });
    await run("STORE 4: retained replica hydrates in an offline fresh tab with harness-supplied shell", async () => {
      const a = await fresh(); await invoke(a, "open", scope("offline"), "minimal"); await apply(a, 1); await commit(a); await drop(a);
      const b = await fresh(); await b.protocol.call("Network.enable");
      await b.protocol.call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      const recovered = await invoke(b, "open", scope("offline"), "minimal"); checkLocalReceipts([1], recovered); await drop(b);
      return { recovered, limit: "Shell supplied through CDP; does not prove service-worker cold start or skipWaiting takeover" };
    });
    await run("STORE 6: the real app captures a shared-docId fixture into history and app-data export", async () => {
      const replica = await fresh("https://local-app-boundary.test");
      await invoke(replica, "open", scope("export-excluded"), "minimal"); await apply(replica, 1);
      await invoke(replica, "asset", "replica-only-asset", [99, 98, 97]); await commit(replica); await invoke(replica, "credential");
      await invoke(replica, "close");
      const retained = await invoke(replica, "open", scope("export-excluded"), "minimal");
      checkLocalReceipts([1], retained); assert.deepEqual(retained.manifest, ["replica-only-asset"]);
      await drop(replica);
      const html = await readFile(new URL("../../../../index.html", import.meta.url), "utf8");
      const a = await localBrowserDocument(control, html, "https://local-app-boundary.test",
        "new Promise((resolve,reject) => { const ready=() => window.__historyTest && window.__splitpageFormats && window.__appDataTest ? resolve(true) : reject(new Error('Build the app with node build.mjs --test')); if(document.readyState === 'complete') ready(); else addEventListener('load',ready,{once:true}); })");
      pages.add(a);
      const result = await a.protocol.evaluate<{ opened: string; captured: number; exported: string[]; titles: string[]; replicaExcluded: boolean; credentialsExcluded: boolean }>(`(async () => {
        const F=window.__splitpageFormats,H=window.__historyTest,A=window.__appDataTest;
        await H.resetForTest(); await H.forceBackend('idb');
        const id='d'+'7'.repeat(32);
        F.state().docId=id; F.state().title='Shared instance fixture';
        await F.openFile(new File([F.buildSplitpage()],'shared-fixture.splitpage'));
        const opened=F.docId();
        await F.openFile(new File(['Replacement text'],'replacement.txt'));
        await H.idle();
        const raw=await H.listRaw(id); const exported=await A.build();
        const text=JSON.stringify(exported);
        return {opened,captured:raw.length,exported:exported.history.docs.map(d=>d.docId),titles:exported.history.docs.map(d=>d.title),replicaExcluded:!text.includes('replica-only-asset'),credentialsExcluded:!text.includes('credential-only-sentinel')};
      })()`);
      assert.equal(result.opened, `d${"7".repeat(32)}`); assert.equal(result.captured, 1); assert.ok(result.exported.includes(result.opened));
      assert.equal(result.replicaExcluded, true); assert.equal(result.credentialsExcluded, true);
      await drop(a);
      return { ...result, limit: "Existing standalone entry with the intended shared docId; no shared session exists. Its history capture must be excluded during integration." };
    });
    await run("STORE 7: unmodified startup with delayed load orders resume, early open-file and draft callbacks", async () => {
      const a = await fresh();
      const browser = await invoke<{ events: string[]; final: string }>(a, "probeLocalStartup", false);
      const desktop = await invoke<{ events: string[]; final: string }>(a, "probeLocalStartup", true);
      assert.deepEqual(browser, { events: ["hydrate-start", "hydrate-release", "open:replica:boot: the version this page loaded, nothing to merge", "firstDraw", "resumeLastProject", "open:last-project:fixture resumed project", "syncIdentity", "history-migration"], final: "last-project" });
      assert.deepEqual(desktop, { events: ["hydrate-start", "desktop-mount", "draft-take", "open:file:fixture open-file delivery", "hydrate-release", "open:replica:boot: the version this page loaded, nothing to merge", "firstDraw", "syncIdentity", "history-migration", "applyTakenDraft", "open:draft:fixture draft application"], final: "draft" });
      await drop(a);
      return { browser, desktop, limit: "Real beginStartup scheduling, controlled boundary callbacks; no Electron, real file handle or draft store." };
    });
  } finally {
    for (const page of pages) { try { await page.dispose(); } catch {} }
    await writeFile(new URL("../../local-evidence.json", import.meta.url), serializeLocalEvidence(evidence));
    if (evidence.cases.every(result => result.status === "PASS")) writeLocalHistories(evidence);
  }
});
