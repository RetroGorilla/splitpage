import { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { ReplicaOrigin, ReplicaPort } from "../../application/session/shared-session.ts";
import { WHOLE_PROJECTION } from "../../application/session/shared-session.ts";
import { enterSharedDocument } from "../../core/migrate.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { scriptCellOf, sanitizeHtml } from "../richtext.ts";
import { mountNativeSharedInput } from "./native-shared-input.ts";
import { notices } from "./ports/effects.ts";
import type { SharedEditorBackend, SharedSwitchPorts } from "./shared-session.ts";

const UNSUPPORTED = "native-command-unavailable";

export function nativePublication() {
  let document: unknown, revision = 0;
  let observe: ((origin: ReplicaOrigin) => void) | null = null;
  const replica: ReplicaPort = {
    revision: () => revision,
    project: () => document,
    changes: () => WHOLE_PROJECTION,
    recovery: () => [],
    execute: () => ({ ok: false, reason: UNSUPPORTED }),
    observe: listener => { observe = listener; return () => { observe = null; }; }
  };
  return {
    replica,
    publish: (snapshot: unknown, origin: "hydration" | "remote") => {
      document = snapshot;
      revision++;
      observe?.(origin);
    }
  };
}

export function openNativeEditor(ports: SharedSwitchPorts, source: ValidatedDocument, failedClose: () => boolean, stored?: Uint8Array) {
  const actor = ports.editor(), at = new Date(ports.now()).toISOString();
  const options = { actor, sanitize: sanitizeHtml };
  const native = openNativeSession(stored ? { kind: "state", state: stored } : {
    kind: "document", document: source, conversion: { cells: scriptCellOf, creation: source.docId, at, by: actor }
  }, options);
  try {
    if (stored && !native.isStoredScript()) throw new Error("The stored state does not hold a well-formed native script");
  } catch (error) { native.close(); throw error; }
  const publication = nativePublication();
  let stopInput: (() => void) | null = null, terminal: Uint8Array | null = null;
  let initial: ValidatedDocument | null = null;
  const stop = native.subscribe(event => {
    try {
      if (event.kind === "changed") publication.publish(native.document(), "remote");
      else if (event.reason === "failed") {
        terminal = event.state;
        if (failedClose()) {
          notices.show(stopInput
            ? "The shared session stopped. Leaving again will retry keeping your writing."
            : "The shared session stopped. Your writing was kept in a standalone copy.", "warn");
        }
      }
    } catch (error) { ports.report(error); }
  });
  const landing = (): ValidatedDocument => {
    if (!terminal) return enterSharedDocument(native.document());
    const recovered = openNativeSession({ kind: "state", state: terminal }, options);
    try { return enterSharedDocument(recovered.document()); } finally { recovered.close(); }
  };
  const unavailable = () => ({ ok: false, reason: UNSUPPORTED, skipped: true } as const);
  const backend: SharedEditorBackend = {
    replica: publication.replica, parts: null, unsupportedCommands: UNSUPPORTED,
    undo: () => ({ actions: { undo: unavailable, redo: unavailable }, breakGroup: () => {}, replayed: () => null }),
    bind: session => { stopInput ??= mountNativeSharedInput({ native, session, stamp: () => ({ at: new Date(ports.now()).toISOString(), by: actor }), report: ports.report }); },
    unbind: () => { stopInput?.(); stopInput = null; },
    settle: () => null,
    start: () => {
      initial = enterSharedDocument(native.document());
      publication.publish(initial, "hydration");
    },
    failedEntry: () => {
      if (!terminal) return null;
      const recovered = landing();
      return JSON.stringify(initial) === JSON.stringify(recovered) ? null : recovered;
    },
    stopIngress: native.holdIngress,
    landing,
    live: () => {},
    dispose: attempt => { attempt(stop); attempt(native.close); }
  };
  return { backend, native };
}
