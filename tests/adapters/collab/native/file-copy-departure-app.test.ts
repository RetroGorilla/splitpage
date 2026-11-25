import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { bootApp, closeApp, rewireRunningApp } from "../../../../src/test/_app-boot.mjs";
import type { createSharedFileCopies as CreateFileCopies } from "../../../../desktop/shared-file-copy.ts";
import type { DesktopFileService } from "../../../../desktop/file-service.ts";
import type { DesktopStoredState } from "../../../../desktop/desktop-state.ts";
import type { DesktopPort } from "../../../../src/adapters/desktop/desktop-port.ts";
import type { NativeReplicaInvoke } from "../../../../shared/native-replica.d.ts";
import type { RetainedSharedScript } from "../../../../src/bootstrap/wiring/retained-shared-script.ts";
import { desktopTestCipher, replicasAt } from "./desktop-local-store-fixture.ts";
import { seedSession } from "./local-store-fixture.ts";

const require = createRequire(import.meta.url);
const { createSharedFileCopies }: { createSharedFileCopies: typeof CreateFileCopies } = require("../../../../desktop/shared-file-copy.ts");
const { createFileRegistry, fileFingerprint, readFileEntry }: DesktopFileService = require("../../../../desktop/file-service.ts");
const docId = "d" + "a".repeat(32);

before(async () => {
  Reflect.set(globalThis, "SPLITPAGE_COLLAB_UI", true);
  localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
  await bootApp();
  window.Element.prototype.scrollBy = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  await finishStartup();
});

after(() => { Reflect.deleteProperty(globalThis, "SPLITPAGE_COLLAB_UI"); closeApp(); });

async function finishStartup() {
  const { localFilesOwner } = await import("../../../../src/bootstrap/wiring/local-files.ts");
  await localFilesOwner().tryResumeLastProject();
}

async function harness(directory: string, failure: "changed" | "unavailable" | "missing", choice: "retry" | "new" | "continue" | "cancel",
  departure: "leave" | "stop", secondCheck = false, noteFails = false) {
  const { useDesktopForTest, restoreDesktop } = await import("../../../../src/adapters/desktop/desktop-port.ts");
  const { makeFakeDesktopBackend } = await import("../../../../src/adapters/desktop/fake-desktop.ts");
  const { sharedEntry } = await import("../../../../src/bootstrap/wiring/shared-entry.ts");
  const { retainedSharingControls } = await import("../../../../src/bootstrap/wiring/retained-shared-script.ts");
  const { collaborationState } = await import("../../../../src/bootstrap/wiring/collaboration-owner.ts");
  const { documentReader } = await import("../../../../src/bootstrap/wiring/ports/document.ts");
  const { currentHome } = await import("../../../../src/bootstrap/wiring/location-owner.ts");
  const { unsavedChanges } = await import("../../../../src/bootstrap/wiring/save-owners.ts");
  const { intern } = await import("../../../../src/adapters/storage/02c-blobs.ts");
  const { imageRecordOf } = await import("../../../../src/core/document/media.ts");
  const identity = { deployment: "copy", script: "story" };
  const name = identity.deployment + "/" + identity.script;
  const original = join(directory, "Original.splitpage");
  const replacement = join(directory, "Replacement.splitpage");
  const originalBytes = Buffer.from(JSON.stringify({ docId, title: "Original", rows: [] }));
  const outside = Buffer.from(JSON.stringify({ docId, title: "External", rows: [] }));
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"), randomBytes(4)]);
  const picture = imageRecordOf(png);
  assert.ok(picture);
  const source = seedSession({ A: "Current shared narration" });
  if (failure === "missing") {
    const row = source.document().rows[0];
    assert.ok(row);
    assert.equal(source.commands.setField({ kind: "gallery", id: row.id }, { imageRef: picture }).kind, "written");
  }
  const token = randomBytes(32).toString("base64url");
  const entry: RetainedSharedScript = { ...identity, relayUrl: "ws://127.0.0.1:9",
    created: { state: source.encodeState(), membership: { token, role: "owner" }, complete: async () => true } };
  source.close();
  await writeFile(original, failure === "changed" && !secondCheck ? outside : originalBytes);
  const state: DesktopStoredState = { version: 2, windows: [], recents: [],
    sharedFileCopies: [{ ...identity, absPath: original, docId, fingerprint: fileFingerprint(originalBytes), missing: 0 }] };
  const files = createFileRegistry();
  const copies = createSharedFileCopies({ read: () => state, async write(mutate) { mutate(state); return true; } }, files, () => false);
  const native = replicasAt(directory, undefined, desktopTestCipher(randomBytes(32)));
  const made = native.window();
  let fault = failure === "unavailable";
  let choices = 0, deletes = 0, erased = 0;
  const modes: string[] = [];
  const invoke: NativeReplicaInvoke = async request => {
    if (request[0] === "note-shared") return noteFails ? { kind: "failed", reason: "io" } : { kind: "stored" };
    if (request[0] === "file-copy-status") return copies.status(name);
    if (request[0] === "file-copy-choice") {
      assert.equal(request[2], failure);
      assert.equal(request[3], departure);
      assert.equal(erased, 0);
      assert.ok(copies.lookup(name));
      assert.equal(deletes, secondCheck ? 1 : 0);
      assert.match(documentReader.current()?.rows[0]?.audioText ?? "", /Current shared narration/);
      choices++;
      if (choice === "retry" || choice === "new") {
        fault = false;
        if (failure === "missing") assert.ok(intern(png));
        if (choice === "retry" && failure === "changed") await writeFile(original, originalBytes);
      }
      return { kind: "file-copy-choice", choice };
    }
    if (request[0] === "file-copy-write") {
      modes.push(request[4]);
      if (fault) return { kind: "file-copy-problem", problem: "unavailable" };
      return copies.write(name, request[2], request[3], request[4], request[5], async () => replacement);
    }
    const result = await made.invoke(request);
    if (request[0] === "forget" && result.kind === "stored") {
      erased++;
      await copies.releaseOrphan(name);
    }
    return result;
  };
  const desktopPorts: Partial<DesktopPort> = {
    isDesktop: true,
    nativeReplica: invoke,
    shareScript: { create: async () => ({ kind: "failed" }), abandon: async () => true, complete: async () => true },
    async manageSharing(operation) {
      assert.equal(operation, "stop");
      assert.equal(erased, 0);
      deletes++;
      if (secondCheck) await writeFile(original, outside);
      return { kind: "membership", record: { token, role: "owner" } };
    },
    async readFile(id) { return readFileEntry(id, files.pathOf(id)); }
  };
  const desktop = { ...makeFakeDesktopBackend(), ...desktopPorts } as unknown as DesktopPort;
  useDesktopForTest(desktop);
  const enter = () => sharedEntry()?.enter(entry);
  const depart = () => {
    if (departure === "leave") return sharedEntry()?.leave();
    collaborationState().setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
    const controls = retainedSharingControls();
    assert.ok(controls);
    return controls.manage("stop");
  };
  return {
    enter, depart, original, replacement, outside, originalBytes, documentReader, currentHome, unsavedChanges, copies, name, modes,
    facts: () => ({ choices, deletes, erased }),
    async reopen() {
      await rewireRunningApp({});
      await finishStartup();
      useDesktopForTest(desktop);
      return sharedEntry()?.enter({ ...identity });
    },
    async reopenFile(path: string) {
      const { projectFileSource } = await import("../../../../src/bootstrap/wiring/local-files.ts");
      const file = new File([Uint8Array.from(await readFile(path))], basename(path));
      return projectFileSource().open({ kind: "file", file });
    },
    async close() { await rewireRunningApp({}); await finishStartup(); restoreDesktop(); }
  };
}

for (const departure of ["leave", "stop"] as const) {
  for (const failure of ["changed", "unavailable", "missing"] as const) {
    for (const choice of ["retry", "new", "continue", "cancel"] as const) {
      test(`${departure} handles ${failure} through the ${choice} choice`, { timeout: 20_000 }, async () => {
        const directory = await mkdtemp(join(tmpdir(), "splitpage-file-departure-"));
        const h = await harness(directory, failure, choice, departure);
        try {
          assert.deepEqual(await h.enter(), { ok: true });
          await h.depart();
          assert.deepEqual(h.facts(), { choices: 1, deletes: departure === "stop" && choice !== "cancel" ? 1 : 0, erased: choice === "cancel" ? 0 : 1 });
          if (choice === "cancel") {
            assert.ok(h.copies.lookup(h.name));
            assert.deepEqual(await h.reopen(), { ok: true });
            assert.match(h.documentReader.current()?.rows[0]?.audioText ?? "", /Current shared narration/);
          } else {
            assert.equal(h.copies.lookup(h.name), undefined);
            assert.match(h.documentReader.current()?.rows[0]?.audioText ?? "", /Current shared narration/);
            if (choice === "continue") {
              assert.equal(h.currentHome().kind, "none");
              assert.equal(h.unsavedChanges(), true);
            } else {
              const path = choice === "new" ? h.replacement : h.original;
              const current = h.documentReader.current();
              assert.ok(current);
              assert.equal(current.docId === docId, choice === "retry");
              const home = h.currentHome();
              assert.equal(home.kind, "file");
              assert.equal(home.name, choice === "new" ? "Replacement.splitpage" : "Original.splitpage");
              const parsed = JSON.parse(await readFile(path, "utf8")) as { docId: string; rows: { audioText: string }[] };
              assert.equal(parsed.docId, current.docId);
              assert.match(parsed.rows[0]?.audioText ?? "", /Current shared narration/);
              assert.equal(h.modes.at(-1), departure === "stop" ? "check" : choice === "new" ? "new" : "check");
              assert.equal(await h.reopenFile(path), true);
              assert.equal(h.documentReader.current()?.docId, parsed.docId);
              assert.match(h.documentReader.current()?.rows[0]?.audioText ?? "", /Current shared narration/);
            }
          }
          if (choice !== "retry") assert.deepEqual(await readFile(h.original), failure === "changed" ? h.outside : h.originalBytes);
        } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
      });
    }
  }
}

test("Stop sharing checks again after relay deletion and retains the replica if cancelled", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "splitpage-file-stop-second-"));
  const h = await harness(directory, "changed", "cancel", "stop", true);
  try {
    assert.deepEqual(await h.enter(), { ok: true });
    await h.depart();
    assert.deepEqual(h.modes, ["check", "check"]);
    assert.deepEqual(h.facts(), { choices: 1, deletes: 1, erased: 0 });
    assert.deepEqual(await readFile(h.original), h.outside);
    assert.deepEqual(await h.reopen(), { ok: true });
    assert.match(h.documentReader.current()?.rows[0]?.audioText ?? "", /Current shared narration/);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Leave still checks the copy when recording the shared catalogue failed", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "splitpage-file-note-failed-"));
  const h = await harness(directory, "changed", "cancel", "leave", false, true);
  try {
    assert.deepEqual(await h.enter(), { ok: true });
    await h.depart();
    assert.deepEqual(h.facts(), { choices: 1, deletes: 0, erased: 0 });
    assert.deepEqual(await readFile(h.original), h.outside);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});
