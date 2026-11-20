import type { NativeReplicaInvoke } from "../../../../shared/native-replica-ipc.d.ts";
import { attachNativeLocalStore, nativeLocalStoreFailure } from "./local-store.ts";
import type { NativeLocalStore } from "./local-store.ts";

export function createDesktopNativeLocalStore(invoke: NativeReplicaInvoke): NativeLocalStore {
  return {
    async open(name, options) {
      try {
        const opened = await invoke(["open", name]);
        if (opened.kind === "failed") return opened;
        if (opened.kind !== "opened") throw new Error("Missing native replica lease");
        const { lease } = opened;
        const release = async () => {
          const reply = await invoke(["close", name, lease]);
          if (reply.kind !== "stored") throw new DOMException("Native replica lease was closed", "InvalidStateError");
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
              const reply = await invoke(["write", name, lease, entry.generation, entry.checkpoint, entry.bytes]);
              if (reply.kind === "stored") return;
              if (reply.kind === "failed" && reply.reason === "quota") throw new DOMException("Native replica is out of space", "QuotaExceededError");
              if (reply.kind === "failed" && reply.reason === "closed") throw new DOMException("Native replica lease was closed", "InvalidStateError");
              throw new Error("Native replica write failed");
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
