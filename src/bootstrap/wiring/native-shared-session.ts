import { writerControls } from "./writer.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeNarrationSeams } from "../../adapters/collab/native/reader.ts";
import type { ReplicaOrigin, ReplicaPort } from "../../application/session/shared-session.ts";
import { WHOLE_PROJECTION } from "../../application/session/shared-session.ts";
import { enterSharedDocument } from "../../core/migrate.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { scriptCellOf, sanitizeHtml } from "../richtext.ts";
import { paintRowTimes } from "../../features/rows/render.ts";
import { keepNativeFieldPaint, mountNativeSharedInput } from "./native-shared-input.ts";
import { captureNativeSwitchSelection } from "./native-narration-surfaces.ts";
import { createNativeEditorRecords } from "./native-shared-records.ts";
import { createNativeEditorFind } from "./native-shared-find.ts";
import { mountNativeRecordEvents } from "./native-shared-record-events.ts";
import { createNativeEditorStructure } from "./native-shared-structure.ts";
import { nativeUndoRoute } from "./native-shared-undo.ts";
import { notices } from "./ports/effects.ts";
import { currentRowsRender } from "./render.ts";
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
  const native = openNativeSession(stored ? { kind: "stored-script", state: stored } : {
    kind: "document", document: source, conversion: { cells: scriptCellOf, creation: source.docId, at, by: actor }
  }, options);
  try {
    if (stored && !native.isStoredScript()) throw new Error("The stored state does not hold a well-formed native script");
  } catch (error) { native.close(); throw error; }
  return bindNativeEditor(ports, native, failedClose, actor);
}

export function bindNativeEditor(ports: SharedSwitchPorts, native: ReturnType<typeof openNativeSession>, failedClose: () => boolean, actor = ports.editor()) {
  const options = { actor, sanitize: sanitizeHtml };
  const publication = nativePublication();
  const editAttribution = () => ({ at: new Date(ports.now()).toISOString(), by: actor });
  let input: ReturnType<typeof mountNativeSharedInput> | null = null, terminal: Uint8Array | null = null;
  let commandSession: Parameters<SharedEditorBackend["bind"]>[0] | null = null;
  let stopRecords: (() => void) | null = null;
  const records = createNativeEditorRecords(native, () => commandSession, actor, ports.now, ports.report,
    () => input?.finish(undefined, false, true) ?? null);
  let initial: ValidatedDocument | null = null;
  let published = native.revision();
  let paintedSeams: ReadonlyMap<string, NativeNarrationSeams> = new Map();
  const readPaint = () => native.document(seams => { paintedSeams = seams; });
  function publish(buffered?: Parameters<typeof keepNativeFieldPaint>[0]): void {
    const revision = native.revision();
    if (published === revision) return;
    const snapshot = readPaint();
    if (buffered) keepNativeFieldPaint(buffered, snapshot.rows.find(row => row.id === buffered.beat));
    input?.clearMovePaint();
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
    replica: publication.replica, unsupportedCommands: UNSUPPORTED,
    nativeRecords: records,
    nativeFind: createNativeEditorFind({ native, session: () => commandSession, input: () => input, editAttribution, publish, report: ports.report }),
    hasWriterPreview: beat => input?.hasWriterPreview(beat) ?? false,
    bindWriterPaint: root => input?.bindWriterPaint(root),
    structure: createNativeEditorStructure({ native, session: () => commandSession, input: () => input, publish, report: ports.report }),
    undo: admission => nativeUndoRoute({ native, admission, input: () => input, publish: () => { publish(); } }),
    bind: session => {
      commandSession = session;
      if (!stopRecords) {
        const stopEvents = mountNativeRecordEvents(records);
        const stopTimes = session.subscribe(change => {
          if (currentRowsRender() && change.changes.cells.some(({ field }) => field === "lengthSeconds")) paintRowTimes();
        });
        stopRecords = () => { try { stopEvents(); } finally { stopTimes(); } };
      }
      input ??= mountNativeSharedInput({
        native, session, editAttribution, now: ports.now, report: ports.report,
        publish, paintIsCurrent: () => published === native.revision(),
        paintedJoinSeams: beat => paintedSeams.get(beat) ?? null
      });
    },
    unbind: () => {
      commandSession = null;
      const unmountRecords = stopRecords, unmountInput = input;
      stopRecords = null;
      input = null;
      try { unmountRecords?.(); } finally { unmountInput?.dispose(); }
    },
    settle: explicitLeave => explicitLeave ? input?.settleLeave() ?? null : input?.finish() ?? null,
    captureSelection: entering => native.isClosingOrClosed() ? null
      : captureNativeSwitchSelection(native, entering, () => !native.isClosingOrClosed() && published === native.revision()),
    abandon: () => { input?.abandonComposition(); },
    drop: () => { writerControls()?.writerFlowControl()?.discardVisual?.(); },
    start: () => {
      initial = enterSharedDocument(readPaint());
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
