import { acceptGhostOnTab, dismissesTagGhost, plainTagKeydown } from "../../features/common/tag-completion-keys.ts";
import { startWriter } from "../../features/writer/writer.ts";
import { writerActions as definitions } from "../../features/writer/actions.ts";
import type { WriterFeaturePorts } from "../../features/writer/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentLifetime, documentReader, refresh } from "./ports/document.ts";
import { edits, wholeFieldText, writerEditing, writerUndo } from "./ports/editing.ts";
import { text } from "./ports/text.ts";
import { writerPanels } from "./ports/panels.ts";
import { writerPreferences, writerView } from "./ports/preferences.ts";
import { notices } from "./ports/effects.ts";
import { actions } from "./ports/actions.ts";
import { screen } from "./ports/screen.ts";
import { shotHiding } from "./shot-hiding.ts";
import { releaseScriptPlace } from "./side-panels.ts";
import { currentRowsRender } from "./render.ts";
import { acceptTagGhost, hideTagGhost, maybeAutoTagShortcut, scheduleIdleRefresh, tagGhost, updateTagGhost } from "../../features/tags/production-tags.ts";
import { cellRuns, cellTextCommand } from "../../application/commands/cell-text.ts";
import { deleteBeatCommand, swapBeatsCommand } from "../../application/commands/rows.ts";
import { createFlowWriter } from "../../features/writer/flow-writer.ts";
import { caretAfterStep } from "../../features/undo/caret.ts";
import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { randomIds } from "../../adapters/identity/ids.ts";
import { gallerySize } from "../../core/document/gallery.ts";
import type { FlowDoc, FlowPorts, FlowRow } from "../../core/flow/flow.ts";
import { projection } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import { paintGuard, sceneView, undoGuard } from "./editor-owners.ts";
import { screenIsStale } from "../../features/rows/render.ts";
import { breakUndoGroup, undoOwner } from "./undo.ts";
import { initializeFlowParagraphs } from "../../application/commands/flow.ts";
import { standaloneSession } from "./session-owner.ts";
import { writerFlowCommands } from "./ports/writer-flow.ts";
import { writerVisualBuffer } from "./ports/writer-visual-buffer.ts";
import type { CommonDocumentSession } from "../../application/session/document-session.ts";
import type { PaintedTextSource } from "../../application/editing/ports.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import type { SharedDocumentHandle } from "../../adapters/collab/types.ts";
import { maybeCueShortcut, maybeDirectionShortcut, typeAtDirectionEdge } from "../../features/rows/render.ts";
import { anchorBrollInLeftCell, maybeCaptureBroll } from "./broll.ts";
import { pictures } from "./ports/pictures.ts";
import { currentPlainTags } from "./plain-tags.ts";
import { currentWhoList } from "./who-list.ts";
import { mountFlowClipboardRoutes } from "../../features/clipboard/routes.ts";
import { copyFlowClipboard, pasteFlowClipboard } from "../../features/clipboard/flow-clip.ts";
import { randomHexBytes } from "../../adapters/identity/ids.ts";
import { migrateRows } from "../document-ports.ts";

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

export interface SharedWriterSource {
  readonly text: { readonly paintedText: PaintedTextSource; readonly bufferedText: BufferedFieldPorts };
  readonly author: { readonly next: () => { readonly id: string; readonly by: string } | null };
  readonly writer: () => string;
  readonly handle: () => SharedDocumentHandle | null;
  readonly lifetime: Pick<CommonDocumentSession, "epoch">;
}

export function mountWriterRuntimeFeature(shared?: SharedWriterSource) {
  const commands = shared ? writerFlowCommands(flowPorts, { author: shared.author, writer: shared.writer, handle: shared.handle }) : null;
  return writer.replace(() => {
    const render = currentRowsRender();
    if (!render) throw new Error("Writer needs the row renderer to be mounted");
    const ports: WriterFeaturePorts = {
      flow: {
        splitReady: () => !screenIsStale(),
        prepareSplit: rowId => {
          releaseScriptPlace();
          const doc = documentReader.current();
          if (rowId && doc) {
            sceneView().reveal(doc, rowId);
            shotHiding().reveal(rowId);
          }
        },
        create: (root, selectionMoved, undoStep) => {
          // why: rule 78: opening the Writer in a shared session writes no paragraphs
          if (!shared) {
            undoOwner().flush();
            const initialized = standaloneSession().amend(initializeFlowParagraphs(flowPorts, edits.allowed, starts => { undoOwner().settleAfterApply(starts); }));
            if (initialized.kind === "failed") throw initialized.error;
          }
          let dismissedGhost: typeof tagGhost = null;
          return createFlowWriter({
            ...(shared && commands ? { paintedText: shared.text.paintedText, bufferedText: shared.text.bufferedText, commands: commands.commands,
              visualBuffer: writerVisualBuffer(shared.text, { document: () => documentReader.current(), lifetime: shared.lifetime, decode: flowCell,
                storedHtml: text.storedHtmlFromDom, shown: edit => paintGuard().whileShown(edit) }) } : {}),
            openFind: () => { actions.invoke("find", "shortcut"); },
            closeFind: () => { actions.invoke("find", "button", "close"); },
            pictures,
            visualBeforeWrite: cell => currentPlainTags()?.beforeWrite(cell) ?? null,
            visualInput: (event, cell) => {
              maybeAutoTagShortcut(event, cell);
              maybeCaptureBroll(event, cell);
              currentPlainTags()?.maybeOpen(event, cell);
              currentPlainTags()?.refresh();
              currentWhoList()?.maybeOpen(event, cell);
              updateTagGhost(cell);
            },
            visualLeave: cell => {
              currentWhoList()?.cancel();
              if (currentPlainTags()?.isOpen(cell)) currentPlainTags()?.close();
              cell.innerHTML = text.sanitizeHtml(cell.innerHTML);
              writerEditing.cells().sync(cell);
              anchorBrollInLeftCell(cell);
              hideTagGhost();
            },
            visualKeydown: (event, cell) => {
              if (event.isComposing || event.keyCode === 229) return true;
              if (currentWhoList()?.keydown(event, cell)) return true;
              const plain = currentPlainTags();
              if (event.key === "Escape" && tagGhost?.cellEl === cell) {
                event.preventDefault(); event.stopPropagation(); hideTagGhost(); return true;
              }
              if (acceptGhostOnTab(event, tagGhost?.cellEl === cell, acceptTagGhost)) return true;
              if (plain?.isOpen(cell) && plainTagKeydown(event, plain, () => {})) return true;
              if (event.key === "Escape" && plain?.finishEditing()) { event.preventDefault(); event.stopPropagation(); return true; }
              if (acceptGhostOnTab(event, tagGhost?.cellEl === cell, acceptTagGhost)) return true;
              return false;
            },
            clipboard: {
              mount: handlers => mountFlowClipboardRoutes(root, handlers),
              copy: (range, data, cut) => {
                const doc = documentReader.current();
                if (doc && copyFlowClipboard(doc, range, data, flowPorts, cut ? randomHexBytes(16) : null, migrateRows)) {
                  notices.show("Some pictures didn't fit on the clipboard: they paste only where their files are available.", "warn");
                }
              },
              paste: (range, data) => {
                const doc = documentReader.current();
                return doc ? pasteFlowClipboard(doc, range, data, flowPorts, text.inertBody, migrateRows) : null;
              }
            },
            lifetime: documentLifetime,
            heldSelection: writerEditing.selection(),
            root,
            doc: () => documentReader.current() as unknown as FlowDoc,
            flow: commands ? commands.flow : flowPorts,
            decode: flowCell,
            storedHtml: text.storedHtmlFromDom,
            run: edits.run,
            wholeFieldText,
            moveBeat: swapBeatsCommand,
            shown: edit => paintGuard().whileShown(edit),
            editingBlocked: () => paintGuard().painting() || undoGuard().applying() || screenIsStale(),
            text: edits.text,
            undo: {
              step: undoStep,
              flush: () => { if (!shared) undoOwner().flush(); },
              breakCoalescing: breakUndoGroup,
              last: () => shared ? null : undoOwner().last(),
              nextRedo: () => shared ? null : undoOwner().nextRedo()
            },
            caretAfterStep: step => caretAfterStep(html => flowCell(html as string | null | undefined), step),
            notice: (message, tone) => { notices.show(message, tone); },
            changed: () => { ["production", "broll", "writerStats"].forEach(job => { scheduleIdleRefresh(job); }); },
            selectionMoved,
            plainVisual,
            beatInput: (event, beat) => {
              maybeAutoTagShortcut(event, beat);
              maybeDirectionShortcut(event, beat);
              maybeCueShortcut(event, beat);
            },
            typeAtBeatEdge: (beat, words) => !!typeAtDirectionEdge(beat, words),
            beatKeydown: (event, beat) => {
              if (event.key === "Escape" && tagGhost?.cellEl === beat) {
                dismissedGhost = tagGhost;
                event.preventDefault();
                event.stopPropagation();
                hideTagGhost();
                return true;
              }
              if (acceptGhostOnTab(event, tagGhost?.cellEl === beat, acceptTagGhost)) return true;
              if (dismissesTagGhost(event.key)) hideTagGhost();
              return false;
            },
            beatSelection: beat => {
              if (!beat) { dismissedGhost = null; hideTagGhost(); return; }
              updateTagGhost(beat);
              if (tagGhost && dismissedGhost &&
                  tagGhost.cellEl.getAttribute("data-id") === dismissedGhost.cellEl.getAttribute("data-id") &&
                  tagGhost.openAt === dismissedGhost.openAt && tagGhost.offset === dismissedGhost.offset &&
                  tagGhost.phrase === dismissedGhost.phrase) hideTagGhost();
              else dismissedGhost = null;
            },
            leaveBeat: beat => {
              if (paintGuard().painting() || undoGuard().applying() || screenIsStale()) return;
              const clean = text.sanitizeHtml(beat.innerHTML);
              if (clean !== text.storedHtmlFromDom(beat.innerHTML)) beat.innerHTML = clean;
              writerEditing.cells().sync(beat);
              anchorBrollInLeftCell(beat);
            },
            newCommentId: () => randomIds.id("c"),
            openComment: at => { actions.invoke("comment-on-selection", "button", at); }
          });
        }
      },
      document: documentReader, edits, text, editing: writerEditing, undo: writerUndo,
      panels: writerPanels, preferences: writerPreferences, view: writerView, notices, actions,
      formatting: {
        selection: render.handleToolbarCmd,
        confirmLink: render.confirmLink,
        cancelLink: render.cancelLink
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
      outsideEdit: (rowId: string, words: string) => edits.run(cellTextCommand(rowId, "audioText", cellRuns(flowCell(words)), edits.text)),
      outsideVisual: (rowId: string, words: string) => edits.run(cellTextCommand(rowId, "visualText", cellRuns(flowCell(words)), edits.text)),
      openVisual: (rowId: string, highlight?: { from: number; to: number }) => { mounted.writerFlowControl()?.openVisual(rowId, highlight); },
      outsideRemove: (rowId: string) => edits.run(deleteBeatCommand(rowId))
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
