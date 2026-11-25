import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as disk from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import type { createNativeReplicaIpc as CreateReplicaIpc } from "../../../../desktop/native-replica-ipc.ts";
import type { NativeReplicaFileSystem } from "../../../../desktop/native-replica-files.ts";
import { readNativeMembership } from "../../../../shared/native-membership.ts";
import type { NativeReplicaInvoke } from "../../../../shared/native-replica.d.ts";
import { createDesktopNativeLocalStore } from "../../../../src/adapters/collab/native/desktop-local-store.ts";

const require = createRequire(import.meta.url);
const { createNativeReplicaIpc }: { createNativeReplicaIpc: typeof CreateReplicaIpc } = require("../../../../desktop/native-replica-ipc.ts");

class Renderer extends EventEmitter {
  isDestroyed(): boolean { return false; }
}

export function desktopTestCipher(key: Buffer) {
  return {
    encrypt(token: string) {
      const iv = randomBytes(12);
      const encryption = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, encryption.update(token, "utf8"), encryption.final(), encryption.getAuthTag()]);
    },
    decrypt(bytes: Buffer) {
      const decryption = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decryption.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decryption.update(bytes.subarray(12, -16)), decryption.final()]).toString("utf8");
    }
  };
}

export function replicasAt(userData: string, fs?: NativeReplicaFileSystem, cipher?: Parameters<typeof createNativeReplicaIpc>[3]) {
  const handle = createNativeReplicaIpc(userData, readNativeMembership, fs, cipher);
  return {
    window() {
      const sender = new Renderer();
      const invoke: NativeReplicaInvoke = async request => structuredClone(await handle(sender, structuredClone(request)));
      return { invoke, sender, store: createDesktopNativeLocalStore(invoke) };
    },
    handle
  };
}

type DiskAction = (perform: () => Promise<void>, partial?: () => Promise<void>) => Promise<void>;

export function replicaFileFaults(durableAppends = true) {
  let armed: { phase: string; action: DiskAction } | undefined;
  const phases: string[] = [];
  async function step(phase: string, perform: () => Promise<void>, partial?: () => Promise<void>): Promise<void> {
    phases.push(phase);
    if (armed?.phase !== phase) return perform();
    const { action } = armed;
    armed = undefined;
    await action(perform, partial);
  }
  const fileSystem: NativeReplicaFileSystem = {
    ...disk,
    async open(...args) {
      const handle = await disk.open(...args);
      const [name, flags] = args;
      const target = typeof name === "string" ? basename(name) : "";
      const phase = flags === "a+" ? "append" : target;
      const sync = handle.sync.bind(handle), writeFile = handle.writeFile.bind(handle);
      handle.sync = () => step(`${phase}:sync`, phase === "append" && !durableAppends ? async () => {} : sync);
      handle.writeFile = (data, options) => step(`${phase}:write`, () => writeFile(data, options), async () => {
        assert.ok(data instanceof Uint8Array);
        await writeFile(data.subarray(0, Math.floor(data.byteLength / 2)), options);
      });
      return handle;
    },
    rename: (from, to) => step(`${basename(String(from))}:rename`, () => disk.rename(from, to)),
    syncDirectory: dir => step(`${basename(dir)}:dir-sync`, async () => {
      if (process.platform === "win32") return;
      const handle = await disk.open(dir, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    })
  };
  function intercept(phase: string, action: DiskAction): void {
    assert.equal(armed, undefined);
    armed = { phase, action };
  }
  return { fileSystem, phases, intercept };
}

export async function desktopFixture(t: TestContext, durableAppends = true) {
  const directory = await disk.mkdtemp(join(tmpdir(), "splitpage-native-replica-"));
  t.after(() => disk.rm(directory, { recursive: true, force: true }));
  const { fileSystem, phases, intercept } = replicaFileFaults(durableAppends);
  const main = replicasAt(directory, fileSystem);
  const first = main.window(), second = main.window();
  return {
    directory, main, first, second, phases, intercept,
    store: first.store, other: second.store,
    restart: (observe = false) => replicasAt(directory, observe ? fileSystem : undefined).window(),
    failAppend(reason?: "quota") {
      intercept("append:sync", async () => {
        throw Object.assign(new Error("injected append failure"), { code: reason === "quota" ? "ENOSPC" : "EIO" });
      });
    }
  };
}
