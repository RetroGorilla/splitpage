import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { sharedHarness } from "../../application/session/shared-session-support.ts";
import { adapterReplica } from "../../application/session/legacy-shared-session-support.ts";
import type { SharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { sharedBufferPorts } from "../../collab/editor-ports/shared-buffer.ts";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../src/application/editing/painted-beats.ts";
import { TITLE_FIELD_KEY, unsettledTitle } from "../../../src/application/editing/buffered-field-key.ts";
import { TITLE_MAX } from "../../../src/core/document/file-title.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import { bindBufferedInput } from "../../../src/features/common/buffered-input.ts";
import type { DocumentView } from "../../../src/application/session/document-session.ts";
import { fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { edgeInput } from "../edge-input.ts";
import { sharedUndoOwner } from "../../collab/editor-ports/shared-undo.ts";
import { sharedBufferedInputHistory } from "../buffered-input-history.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";

export type TitlePage = ReturnType<typeof sharedTitle>;

export function sharedTitle(title = "Draft", fields: Record<string, unknown> = { titleOrigin: "user" },
  options: { readonly undo?: (h: Stage1ExecutorHarness) => SharedUndo } = {}) {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }], { ...fields, title });
  let reversals = 0;
  if (!options.undo) registerSharedUndoOperationHandlers(h.a);
  const owner = options.undo?.(h) ?? sharedUndoOwner(h.a, () => ({ id: "undo" + ++reversals, by: "Alice" }), () => 0, error => { throw error; });
  const a = sharedHarness(adapterReplica(h.a, owner)), { effects, reports, recovered } = fakeWriterBufferEffects();
  let serial = 0, depth = 0, repaints = 0, pageTitles = 0;
  const shared = sharedBufferPorts(h.a, a.session, { ...effects, readers: bufferReaders, stamps: bufferStamps("Alice"),
    author: () => ({ id: "native:" + ++serial, by: "Alice" }) });
  const listeners: (() => void)[] = [], checks: (() => void)[] = [];
  const current = () => { const doc = a.session.read(view => view) as DocumentView | null; return doc ? doc.title || "" : null; };
  document.body.innerHTML = '<input id="doc-title"><div id="writer"><input id="writer-title"></div><button id="away">away</button>';
  const byId = (id: string): HTMLInputElement => { const found = document.getElementById(id); assert.ok(found instanceof window.HTMLInputElement); return found; };
  const main = byId("doc-title"), writer = byId("writer-title");
  function paint(): void {
    for (const check of checks.slice()) check();
    if (document.activeElement !== main) main.value = current() ?? "";
    for (const listener of listeners.slice()) listener();
  }
  const watch = <T>(list: T[], item: T) => { list.push(item); return () => { const at = list.indexOf(item); if (at >= 0) list.splice(at, 1); }; };
  const painted = createPaintedBeats(shared.paintedText), paintedTitle = () => painted.stored(TITLE_FIELD_KEY);
  const routes = bindBufferedInput({
    inputs: [main, writer], key: TITLE_FIELD_KEY, stored: paintedTitle, changed: () => { pageTitles++; }, pasteLimit: TITLE_MAX,
    unsettled: text => unsettledTitle(text, paintedTitle() ?? ""),
    position: offset => beatPos(TITLE_FIELD_KEY, offset), owns: pos => pos.kind === "beat" && pos.rowId === TITLE_FIELD_KEY
  }, {
    history: sharedBufferedInputHistory(h.a, a.session, owner),
    field: surface => createBufferedField(shared.bufferedText, surface),
    painted,
    report: shared.bufferedText.report,
    shown: edit => { depth++; try { return edit(); } finally { depth--; } },
    repaint: () => { repaints++; paint(); },
    onPainted: listener => watch(listeners, listener),
    beforePaint: check => watch(checks, check)
  });
  const stored = () => readSharedPaintedText(h.a, sharedBufferedTarget(h.a, TITLE_FIELD_KEY))?.text;
  return { h, a, main, writer, routes, reports, recovered, stored, paint, owner, viewTitle: current,
    edge: edgeInput(() => main), writerEdge: edgeInput(() => writer),
    target: () => sharedBufferedTarget(h.a, TITLE_FIELD_KEY),
    repaints: () => repaints, pageTitles: () => pageTitles, shownDepth: () => depth,
    close: () => { routes.dispose(); a.session.dispose(); h.destroy(); document.body.innerHTML = ""; } };
}
