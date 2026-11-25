import type { NativeMembershipRecord, NativeReplicaInvoke, NativeReplicaReply } from "../../../../shared/native-replica.d.ts";
import { attachNativeLocalStore, nativeLocalStoreFailure } from "./local-store.ts";
import type { NativeLocalStore } from "./local-store.ts";

export function createDesktopNativeLocalStore(invoke: NativeReplicaInvoke,
  manage?: (operation: string, name: string, lease: string, address: string) => Promise<NativeReplicaReply>): NativeLocalStore {
  return {
    async open(name, options) {
      try {
        const opened = await invoke(["open", name]);
        if (opened.kind === "failed") return opened;
        if (opened.kind !== "opened") throw new Error("Missing native replica lease");
        const { lease } = opened;
        let staged: Promise<void> | undefined;
        const join = async (record: NativeMembershipRecord | string | null) => {
          const reply = await invoke(["join", name, lease, record]);
          if (reply.kind !== "stored") throw new Error("Could not save shared membership.");
        };
        const release = async () => {
          await staged;
          const reply = await invoke(["close", name, lease]);
          if (reply.kind !== "stored") throw new DOMException("Native replica lease was closed", "InvalidStateError");
        };
        const membership = async () => {
          const reply = await invoke(["membership", name, lease]);
          if (reply.kind !== "membership") throw new Error("Could not read shared membership.");
          return reply.record;
        };
        try {
          return await attachNativeLocalStore({
            async read(through) {
              const reply = await invoke(["read", name, lease, through ?? null]);
              if (reply.kind === "read") return reply.entries;
              throw new DOMException("Native replica read failed",
                reply.kind === "failed" && reply.reason === "closed" ? "InvalidStateError" : "UnknownError");
            },
            async write(entry) {
              const reply = await invoke(entry.journal
                ? ["write", name, lease, entry.generation, entry.checkpoint, entry.bytes, entry.journal]
                : ["write", name, lease, entry.generation, entry.checkpoint, entry.bytes]);
              if (reply.kind === "stored") return;
              if (reply.kind === "failed" && reply.reason === "quota") throw new DOMException("Native replica is out of space", "QuotaExceededError");
              if (reply.kind === "failed" && reply.reason === "closed") throw new DOMException("Native replica lease was closed", "InvalidStateError");
              throw new Error("Native replica write failed");
            },
            async readJournal() {
              const reply = await invoke(["read-journal", name, lease]);
              if (reply.kind === "journal") return reply.bytes;
              throw new DOMException("Native replica journal read failed",
                reply.kind === "failed" && reply.reason === "closed" ? "InvalidStateError" : "UnknownError");
            },
            async writeJournal(bytes) {
              const reply = await invoke(["write-journal", name, lease, bytes]);
              if (reply.kind === "stored") return;
              if (reply.kind === "failed" && reply.reason === "quota") throw new DOMException("Native replica is out of space", "QuotaExceededError");
              if (reply.kind === "failed" && reply.reason === "closed") throw new DOMException("Native replica lease was closed", "InvalidStateError");
              throw new Error("Native replica journal write failed");
            },
            async forget() {
              await staged;
              const reply = await invoke(["forget", name, lease]);
              if (reply.kind !== "stored") throw new Error("Could not remove the local copy.");
            },
            membership: {
              record: membership,
              ...(manage && { async manage(operation: string, address: string) {
                const reply = await manage(operation, name, lease, address);
                if (reply.kind !== "membership" || !reply.record) throw new Error("Could not update sharing.");
                return reply.record;
              } }),
              async token() { return (await membership())?.token ?? null; },
              join,
              async stageInvitation(token, previous, signal) {
                signal.throwIfAborted();
                let commit = () => {};
                staged = new Promise<void>(resolve => { commit = resolve; });
                const rollback = async () => {
                  try { await join(previous); }
                  finally { commit(); }
                };
                try {
                  await join(token);
                  signal.throwIfAborted();
                } catch (error) {
                  await rollback();
                  throw error;
                }
                return { commit, rollback };
              }
            },
            release,
            persistent: () => Promise.resolve(true)
          }, options);
        } catch (error) {
          await release().catch(() => {});
          return nativeLocalStoreFailure(error);
        }
      } catch (error) { return nativeLocalStoreFailure(error); }
    },
    async delete(name) {
      try {
        const reply = await invoke(["delete", name]);
        if (reply.kind === "stored" || reply.kind === "failed") return reply;
        throw new Error("Unexpected native replica delete result");
      } catch (error) { return nativeLocalStoreFailure(error); }
    }
  };
}
