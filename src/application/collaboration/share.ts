import type { ShareScriptControls, ShareScriptCreation } from "../../../shared/desktop-contract.d.ts";
import type { DocumentView } from "../session/document-session.ts";
import type { OperationContext, Operations } from "../session/operation.ts";
import { utf8Bytes } from "../../core/document/ids.ts";

type Created = Extract<ShareScriptCreation, { kind: "created" }>;
export type ShareAttemptResult =
  | { readonly kind: "shared"; readonly link: string }
  | { readonly kind: "cancelled" | "document-changed" | "not-configured" | "unreachable" | "failed" | "already-used" | "too-large" };

export interface ShareAttemptPorts {
  readonly operations: Operations;
  readonly generation: () => number;
  readonly current: () => DocumentView | null;
  readonly hold: () => () => void;
  readonly snapshot: (doc: DocumentView) => Uint8Array;
  readonly hash: (bytes: Uint8Array) => Promise<string>;
  readonly newId: () => string;
  readonly relay: ShareScriptControls;
  readonly link: (created: Created) => string;
  readonly enter: (created: Created, bytes: Uint8Array, current: () => boolean, release: () => void,
    complete: () => Promise<boolean>) => Promise<boolean>;
}

type Attempt = { source: string; id: string; hash: string; bytes: Uint8Array; address: string; passwordCheck: string | undefined };

export function createShareAttempt(ports: ShareAttemptPorts) {
  let previous: Attempt | undefined;
  let running = false;

  async function discard(attempt: Attempt): Promise<boolean> {
    if (!await ports.relay.abandon(attempt.id)) return false;
    if (previous === attempt) previous = undefined;
    return true;
  }

  async function share(address: string, signal: { readonly aborted: boolean }, switching: () => void,
    password?: string): Promise<ShareAttemptResult> {
    if (running) return { kind: "failed" };
    running = true;
    let release: (() => void) | undefined;
    try {
      release = ports.hold();
      const context: OperationContext = ports.operations.capture();
      const owns = () => !signal.aborted && ports.operations.stillOwns(context) && ports.generation() === context.generation;
      const invalid = () => ({ kind: signal.aborted ? "cancelled" as const : "document-changed" as const });
      const doc = ports.current();
      if (!doc || !owns()) return invalid();
      const source = JSON.stringify(doc);
      let attempt = previous;
      const checkPassword = (id: string) => password === undefined ? undefined : ports.hash(utf8Bytes(id + password));
      const passwordCheck = attempt && await checkPassword(attempt.id);
      // why: a fresh Yjs conversion introduces a new client id even when the standalone script is unchanged
      if (!attempt || attempt.source !== source || attempt.address !== address || attempt.passwordCheck !== passwordCheck) {
        const bytes = ports.snapshot(doc);
        if (bytes.byteLength > 15_000_000) return { kind: "too-large" };
        const hash = await ports.hash(bytes);
        if (!owns()) return invalid();
        if (attempt && !await discard(attempt)) return { kind: "failed" };
        const id = ports.newId();
        attempt = { source, id, bytes, hash, address, passwordCheck: await checkPassword(id) };
      }
      if (!owns()) return invalid();
      previous = attempt;
      const { id, bytes, hash } = attempt;
      const created = password === undefined
        ? await ports.relay.create(id, hash, bytes, address)
        : await ports.relay.create(id, hash, bytes, address, password);
      if (!owns()) {
        await discard(attempt);
        return invalid();
      }
      if (created.kind !== "created") {
        if (created.kind === "already-used") await discard(attempt);
        return created;
      }
      switching();
      const enter = await ports.enter(created, bytes, owns, release,
        () => signal.aborted ? Promise.resolve(false) : ports.relay.complete(id)).catch(() => false);
      if (!enter) {
        if (owns()) return { kind: "failed" };
        await discard(attempt);
        return invalid();
      }
      previous = undefined;
      return { kind: "shared", link: ports.link(created) };
    } catch {
      return { kind: "failed" };
    } finally {
      release?.();
      running = false;
    }
  }
  return { share };
}
