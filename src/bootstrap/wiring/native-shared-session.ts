import { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { ReplicaOrigin, ReplicaPort } from "../../application/session/shared-session.ts";
import { WHOLE_PROJECTION } from "../../application/session/shared-session.ts";
import { enterSharedDocument } from "../../core/migrate.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { scriptCellOf, sanitizeHtml } from "../richtext.ts";
import { keepNativeFieldPaint, mountNativeSharedInput } from "./native-shared-input.ts";
import { nativeUndoRoute } from "./native-shared-undo.ts";
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
  let input: ReturnType<typeof mountNativeSharedInput> | null = null, terminal: Uint8Array | null = null;
  let initial: ValidatedDocument | null = null;
  let published = native.revision();
  function publish(buffered?: Parameters<typeof keepNativeFieldPaint>[0]): void {
    const revision = native.revision();
    if (published === revision) return;
    const snapshot = native.document();
    if (buffered) keepNativeFieldPaint(buffered, snapshot.rows.find(row => row.id === buffered.beat));
    published = revision;
    publication.publish(snapshot, "remote");
  }
  const stop = native.subscribe(event => {
    try {
      if (event.kind === "size") return;
      if (event.kind === "changed") {
        if (!input?.buffered()) publish();
      } else {
        terminal = event.state;
        if (event.reason !== "failed") {
          if (input?.buffered()) input.stop();
          return;
        }
        if (input?.buffered()) {
          let bytes: Uint8Array | null = null;
          try {
            const recovered = openNativeSession({ kind: "state", state: terminal }, options);
            try { bytes = input.recover(recovered); } finally { recovered.close(); }
          } catch (error) {
            ports.report(error);
          }
          if (!bytes) {
            input.stop();
            notices.show("The shared session stopped. Unsent writing is still in the editor.", "warn");
            return;
          }
          terminal = bytes;
        }
        if (failedClose()) {
          notices.show(input
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
  const backend: SharedEditorBackend = {
    replica: publication.replica, parts: null, unsupportedCommands: UNSUPPORTED,
    undo: admission => nativeUndoRoute({ native, admission, input: () => input, publish: () => { publish(); } }),
    bind: session => {
      input ??= mountNativeSharedInput({
        native, session, editAttribution: () => ({ at: new Date(ports.now()).toISOString(), by: actor }), now: ports.now, report: ports.report, publish
      });
    },
    unbind: () => { input?.dispose(); input = null; },
    settle: () => input?.finish() ?? null,
    start: () => {
      initial = enterSharedDocument(native.document());
      published = native.revision();
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
