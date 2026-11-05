import { startWriter } from "../../features/writer/writer.ts";
import { writerActions as definitions } from "../../features/writer/actions.ts";
import type { WriterFeaturePorts } from "../../features/writer/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentLifetime, documentReader, refresh } from "./ports/document.ts";
import { edits, writerEditing, writerUndo } from "./ports/editing.ts";
import { text } from "./ports/text.ts";
import { writerPanels } from "./ports/panels.ts";
import { writerPreferences, writerView } from "./ports/preferences.ts";
import { notices } from "./ports/effects.ts";
import { actions } from "./ports/actions.ts";
import { screen } from "./ports/screen.ts";
import { splitRowFieldCore } from "./rows.ts";
import { hiddenShotStripHtml } from "../../features/rows/hide-shot.ts";
import { sceneHeaderHtml, sceneRowEntries } from "../../features/rows/scene-rows.ts";
import { formatDuration, rowSeconds } from "../../core/production/timing.ts";
import { sceneView } from "./editor-owners.ts";
import { shotHiding } from "./shot-hiding.ts";
import { currentRowsRender } from "./render.ts";
import { hideTagGhost, scheduleIdleRefresh } from "../../features/tags/production-tags.ts";
import { cellRuns, cellTextCommand } from "../../application/commands/cell-text.ts";
import { createFlowWriter } from "../../features/writer/flow-writer.ts";
import { caretAfterStep } from "../../features/undo/caret.ts";
import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { randomIds } from "../../adapters/identity/ids.ts";
import { gallerySize } from "../../core/document/gallery.ts";
import type { FlowDoc, FlowPorts, FlowRow } from "../../core/flow/flow.ts";
import { projection } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import { paintGuard } from "./editor-owners.ts";
import { undoOwner } from "./undo.ts";
import { initializeFlowParagraphs } from "../../application/commands/flow.ts";
import { liveSession } from "./session-owner.ts";

const MEDIA_CELL = Object.freeze({ media: true });
const flowCells = new Map<string, Run[]>();

// why: screen positions count pictures and video cards, so this reader keeps them; a paint asks once per beat
function flowCell(html: string | null | undefined): Run[] {
  const source = html ?? "";
  const hit = flowCells.get(source);
  if (hit) return hit;
  const made = text.fromHtml(source, MEDIA_CELL);
  if (flowCells.size > 20000) flowCells.clear();
  flowCells.set(source, made);
  return made;
}

function plainVisual(row: FlowRow): string {
  const words = projection(flowCell(row.visualText)).replace(/\s+/g, " ").trim();
  if (words) return words.length > 70 ? words.slice(0, 69) + "…" : words;
  return gallerySize(row) ? "Picture" : "";
}

const flowPorts: FlowPorts = {
  cells: flowCell,
  newId: () => randomIds.id("r"),
  hasVisual: row => !!projection(flowCell(row.visualText)) || !!gallerySize(row)
};

// why: a switch for this branch only, so the old writer's suites keep running until the new writer replaces it
function writerFlowOn(): boolean {
  try { return window.localStorage.getItem("splitpage-writer-flow") === "1"; } catch { return false; }
}

const writer = owned<ReturnType<typeof startWriter>>();
const connections = new Set<(control: ReturnType<typeof startWriter> | null) => void>();

export function connectWriter(controlChanged: (control: ReturnType<typeof startWriter> | null) => void): () => void {
  connections.add(controlChanged);
  controlChanged(writer.owner());
  return () => {
    if (!connections.delete(controlChanged)) return;
    controlChanged(null);
  };
}

export function mountWriterRuntimeFeature() {
  return writer.replace(() => {
    const render = currentRowsRender();
    if (!render) throw new Error("Writer needs the row renderer to be mounted");
    const ports: WriterFeaturePorts = {
      flow: {
        enabled: writerFlowOn,
        refreshSplit: rowId => {
          const doc = documentReader.current();
          if (rowId && doc) {
            sceneView().reveal(doc, rowId);
            shotHiding().reveal(rowId);
          }
          currentRowsRender()?.render();
        },
        create: (root, selectionMoved, undoStep) => {
          undoOwner().flush();
          const initialized = liveSession().amend(initializeFlowParagraphs(flowPorts, edits.allowed, () => { undoOwner().settleAfterApply(); }));
          if (initialized.kind === "failed") throw initialized.error;
          return createFlowWriter({
            lifetime: documentLifetime,
            root,
            doc: () => documentReader.current() as unknown as FlowDoc,
            flow: flowPorts,
            decode: flowCell,
            storedHtml: text.storedHtmlFromDom,
            run: edits.run,
            shown: edit => paintGuard().whileShown(edit),
            text: edits.text,
            undo: {
              step: undoStep,
              flush: () => { undoOwner().flush(); },
              breakCoalescing: () => { undoOwner().breakCoalescing(); },
              last: () => undoOwner().last(),
              nextRedo: () => undoOwner().nextRedo()
            },
            caretAfterStep: step => caretAfterStep(html => flowCell(html as string | null | undefined), step),
            notice: (message, tone) => { notices.show(message, tone); },
            changed: () => { ["production", "broll", "writerStats"].forEach(job => { scheduleIdleRefresh(job); }); },
            selectionMoved,
            plainVisual,
            newCommentId: () => randomIds.id("c"),
            openComment: at => { actions.invoke("comment-on-selection", "button", at); }
          });
        }
      },
      document: documentReader, edits, text, editing: writerEditing, undo: writerUndo,
      rows: { splitField: splitRowFieldCore },
      hiding: { renderGroups: (rows, renderRow) => {
        const doc = documentReader.current();
        if (!doc) return "";
        const numbering = documentReader.numbering();
        const totals = new Map(numbering.scenes.map(group => [group.id ?? "",
          formatDuration(doc.rows.slice(group.start, group.end).reduce((sum, row) => sum + rowSeconds(row, doc, text.productionReaders), 0))]));
        return sceneRowEntries({ rows, sections: doc.sections }, shotHiding(), sceneView(), numbering).map(item =>
          "scene" in item ? sceneHeaderHtml(item, !edits.allowed(), totals.get(item.scene.id) ?? "") :
            "strip" in item ? hiddenShotStripHtml(item.strip) : renderRow(item.row, item.index)).join("");
      } },
      panels: writerPanels, preferences: writerPreferences, view: writerView, notices, actions,
      formatting: {
        state: render.cellFormatState,
        direction: render.toggleCellDirection,
        toggle: render.toggleCellFormat
      },
      dismissTagGhost: hideTagGhost, scheduleStats: scheduleIdleRefresh,
      cancelStats: () => { refresh.cancel(["writerStats"]); }
    };
    const mounted = startWriter(ports);
    let withdrawHook: (() => void) | null = null;
    exposeTestHook("__writerFlowTest", () => ({
      on: () => !!mounted.writerFlowControl(),
      selection: () => mounted.writerFlowControl()?.selection() ?? null,
      place: (range: never) => { mounted.writerFlowControl()?.place(range); },
      check: () => mounted.writerFlowControl()?.check() ?? ["the flow writer isn't open"],
      fullRender: () => { currentRowsRender()?.render(); },
      outsideEdit: (rowId: string, words: string) => edits.run(cellTextCommand(rowId, "audioText", cellRuns(flowCell(words)), edits.text))
    }), (withdraw) => { withdrawHook = withdraw; });
    const control = { ...mounted, dispose: () => {
      withdrawHook?.();
      if (writer.owner() === control) writer.stop();
      else mounted.dispose();
    } };
    return control;
  }, (control) => [() => {
    for (const connected of connections) connected(control);
    return () => { for (const connected of connections) connected(null); };
  }]);
}

export const stopWriterRuntimeFeature = writer.stop;
export const writerControls = writer.owner;

export function writerActions() {
  return definitions(writer.owner, { screen });
}
