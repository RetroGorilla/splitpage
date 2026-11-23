import { HocuspocusProvider } from "@hocuspocus/provider";
import { Doc, encodeStateAsUpdate } from "yjs";

export async function readInvitationSnapshot(url: string, script: string, token: string, signal?: AbortSignal): Promise<Uint8Array> {
  const relay = new URL(url);
  relay.searchParams.set("wire", "1");
  relay.searchParams.set("schema", "1");
  const deadline = AbortSignal.timeout(10_000);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const failure = new Error("Could not load the shared script from the relay.");
  if (stop.aborted) throw failure;
  const document = new Doc();
  let provider: HocuspocusProvider | undefined;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let authenticated = false;
      const fail = () => reject(failure);
      abort = fail;
      stop.addEventListener("abort", fail, { once: true });
      provider = new HocuspocusProvider({
        url: relay.href, name: script, token, document, awareness: null,
        onAuthenticated() { authenticated = true; },
        onSynced({ state }) {
          if (authenticated && state) resolve();
        },
        onAuthenticationFailed: fail,
        onClose: fail
      });
    });
    return encodeStateAsUpdate(document);
  } finally {
    if (abort) stop.removeEventListener("abort", abort);
    try {
      provider?.destroy();
    } finally {
      document.destroy();
    }
  }
}
