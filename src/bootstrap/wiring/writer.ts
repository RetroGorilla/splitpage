import { acceptGhostOnTab, dismissesTagGhost, plainTagKeydown } from "../../features/common/tag-completion-keys.ts";
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
import type { FlowDoc, FlowPorts, FlowRow, FlowRange, FlowOutcome } from "../../core/flow/flow.ts";
import { projection } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import { paintGuard, sceneView, undoGuard } from "./editor-owners.ts";
import { screenIsStale } from "../../features/rows/render.ts";
import { undoOwner } from "./undo.ts";
import { initializeFlowParagraphs } from "../../application/commands/flow.ts";
import { liveSession } from "./session-owner.ts";
import { maybeCueShortcut, maybeDirectionShortcut, typeAtDirectionEdge } from "../../features/rows/render.ts";
import { anchorBrollInLeftCell, maybeCaptureBroll } from "./broll.ts";
import { pictures } from "./ports/pictures.ts";
import { currentPlainTags } from "./plain-tags.ts";
import { currentWhoList } from "./who-list.ts";
import { mountFlowClipboardRoutes } from "../../features/clipboard/routes.ts";
import { copyFlowClipboard, pasteFlowClipboard } from "../../features/clipboard/flow-clip.ts";
import { randomHexBytes } from "../../adapters/identity/ids.ts";
import { migrateRows } from "../document-ports.ts";
import { WHOLE_DOCUMENT } from "../../application/session/change-set.ts";
import { domToPos, posToDom } from "../../features/common/cell-dom.ts";
import { appBindingAsked, setAppBindingActive } from "./app-binding-mode.ts";
import { addCommentCommand, addReplyCommand, unwrapCommentAnchorCommand } from "../../application/commands/comments.ts";

const bindingSwitch = appBindingAsked();
let experimentBinding: { sync: (id: string, runs: readonly Run[]) => void; undo: () => void } | null = null;
let experimentCommand: ((name: string, before: FlowRange | null) => FlowOutcome | undefined) | null = null;
const experimentCounts = { compositionMark: 0, dropEmptySince: 0, hold: 0 };
const experimentPaints: { phase: "start" | "end"; at: number }[] = [];

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

export function mountWriterRuntimeFeature() {
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
          undoOwner().flush();
          const initialized = liveSession().amend(initializeFlowParagraphs(flowPorts, edits.allowed, starts => { undoOwner().settleAfterApply(starts); }));
          if (initialized.kind === "failed") throw initialized.error;
          let dismissedGhost: typeof tagGhost = null;
          return createFlowWriter({
            paintObservation: phase => { if (bindingSwitch) experimentPaints.push({ phase, at: performance.now() }); },
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
            flow: flowPorts,
            decode: flowCell,
            storedHtml: text.storedHtmlFromDom,
            run: edits.run,
            syncBeatOverride: (id, runs) => {
              if (!bindingSwitch || !experimentBinding) return false;
              experimentBinding.sync(id, runs);
              return true;
            },
            commandOverride: (name, before) => bindingSwitch && experimentBinding ? experimentCommand?.(name, before) : undefined,
            moveBeat: swapBeatsCommand,
            shown: edit => paintGuard().whileShown(edit),
            editingBlocked: () => paintGuard().painting() || undoGuard().applying() || screenIsStale(),
            text: edits.text,
            undo: {
              step: dir => {
                if (bindingSwitch && experimentBinding) { experimentBinding.undo(); return; }
                undoStep(dir);
              },
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
              if (bindingSwitch && experimentBinding) return;
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
      experiment: bindingSwitch ? {
        install: (binding: typeof experimentBinding) => { experimentBinding = binding; setAppBindingActive(binding !== null); },
        command: (handler: typeof experimentCommand) => { experimentCommand = handler; },
        paintEvents: () => experimentPaints.map(event => ({ ...event })),
        clearPaintEvents: () => { experimentPaints.length = 0; },
        model: () => ({ document: documentReader.current(), epoch: liveSession().epoch(), generation: liveSession().generation(), undo: undoOwner().sizes(), heldSelection: writerEditing.selection().resolveFlow(), counts: { ...experimentCounts } }),
        offset: (el: HTMLElement, node: Node, offset: number) => domToPos(el, node, offset),
        point: (el: HTMLElement, offset: number) => posToDom(el, offset),
        hold: () => {
          experimentCounts.hold++;
          const release = undoOwner().hold();
          return () => { experimentCounts.hold--; release(); };
        },
        instrument: () => {
          const owner = undoOwner();
          const mark = owner.compositionMark;
          const drop = owner.dropEmptySince;
          Object.assign(owner, {
            compositionMark: (...args: Parameters<typeof mark>) => { experimentCounts.compositionMark++; return mark(...args); },
            dropEmptySince: (...args: Parameters<typeof drop>) => { experimentCounts.dropEmptySince++; return drop(...args); }
          });
        },
        markProbe: () => {
          const owner = undoOwner();
          const mark = owner.compositionMark("R1", "audioText");
          return owner.dropEmptySince(mark, false);
        },
        heldUndoProbe: () => {
          const release = undoOwner().hold();
          try { return undoOwner().undo(); } finally { release(); }
        },
        open: () => mounted.openWriter(),
        project: (rows: readonly { id: string; audioText: string }[]) => {
          const outcome = liveSession().stamp({ name: "app-binding-projection", plan: doc => ({
            changes: WHOLE_DOCUMENT,
            apply: live => {
              const projected = rows.map(row => ({ ...(doc.rows.find(old => old.id === row.id) ?? { visualText: "", imageRef: null, status: "todo" as const }), ...row }));
              live.rows.splice(0, live.rows.length, ...projected);
              live.paragraphsDecided = true;
            }
          }) });
          if (outcome.kind === "failed") throw outcome.error;
        },
        repaint: () => mounted.writerFlowControl()?.repaint(),
        isolation: () => {
          const attempts: Record<string, unknown> = {};
          for (const [name, get] of [["documentReader", () => documentReader.current()], ["liveSession.held", () => liveSession().held()]] as const) {
            try { const doc = get(); if (doc?.rows[0]) doc.rows[0].audioText = "forbidden"; attempts[name] = "wrote"; }
            catch (error) { attempts[name] = error instanceof Error ? error.name : String(error); }
          }
          attempts.stamp = liveSession().stamp({ name: "forbidden-stamp", plan: () => ({ changes: WHOLE_DOCUMENT, apply: doc => { doc.title = "forbidden"; } }) });
          attempts.addComment = edits.run(addCommentCommand({ id: "probe-comment", rowId: "R1", field: "audioText" }));
          attempts.addReply = edits.run(addReplyCommand("probe-comment", { id: "probe-reply" }, { nowIso: () => "2026-11-09T00:00:00.000Z" }));
          attempts.unwrap = edits.run(unwrapCommentAnchorCommand(() => [{ rowId: "R1", field: "audioText", html: "forbidden" }]));
          attempts.replay = liveSession().replay({ name: "forbidden-replay", plan: () => null });
          attempts.amend = liveSession().amend({ name: "forbidden-amend", plan: () => null });
          try { liveSession().adopt({}); attempts.adopt = "adopted"; }
          catch (error) { attempts.adopt = error instanceof Error ? error.message : String(error); }
          return attempts;
        }
      } : null,
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
