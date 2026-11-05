import { cellRuns, cellTextCommand } from "../../application/commands/cell-text.ts";
import { flowCommand } from "../../application/commands/flow.ts";
import type { UndoDirection } from "../../application/editing/undo/undo.ts";
import type { Command, CommandOutcome, DocumentSession } from "../../application/session/document-session.ts";
import type { CellTextPorts } from "../../application/session/ports.ts";
import { beatPos, caretAt, isCollapsed, logicalText, orderedRange, withinOneBeat } from "../../core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowRange, FlowRow, FlowSelectionPair } from "../../core/flow/flow.ts";
import { addComment } from "../../core/text/edits.ts";
import type { MarkName, Run } from "../../core/text/runs.ts";
import { createSurface } from "./flow-surface.ts";

export interface FlowUndoPorts {
  readonly step: (dir: UndoDirection) => void;
  readonly flush: () => void;
  readonly breakCoalescing: () => void;
  readonly last: () => { readonly selection?: FlowSelectionPair } | null | undefined;
  readonly nextRedo: () => { readonly selection?: FlowSelectionPair } | null | undefined;
}

export interface FlowWriterPorts {
  readonly lifetime: Pick<DocumentSession, "epoch">;
  readonly root: HTMLElement;
  readonly doc: () => FlowDoc;
  readonly flow: FlowPorts;
  readonly decode: (html: string) => Run[];
  readonly storedHtml: (html: string) => string;
  readonly run: (command: Command) => CommandOutcome;
  readonly shown: <T>(edit: () => T) => T;
  readonly text: CellTextPorts;
  readonly undo: FlowUndoPorts;
  readonly caretAfterStep: (step: { readonly before?: unknown; readonly after?: unknown }) => number;
  readonly notice: (text: string, tone: "ok" | "warn") => void;
  readonly changed: () => void;
  readonly selectionMoved: () => void;
  readonly plainVisual: (row: FlowRow) => string;
  readonly beatInput: (event: InputEvent, beat: HTMLElement) => void;
  readonly typeAtBeatEdge: (beat: HTMLElement, text: string) => boolean;
  readonly beatKeydown: (event: KeyboardEvent, beat: HTMLElement) => boolean;
  readonly beatSelection: (beat: HTMLElement | null) => void;
  readonly leaveBeat: (beat: HTMLElement) => void;
  readonly newCommentId: () => string;
  readonly openComment: (at: { readonly id: string; readonly rowId: string; readonly field: string; readonly quotedText: string }) => void;
}

export interface FlowWriter {
  readonly isCurrent: () => boolean;
  readonly finish: () => FlowRange | null;
  readonly repaint: () => void;
  readonly caret: (rowId: string, offset: number | "end") => void;
  readonly format: (command: string) => void;
  readonly marks: () => Record<string, boolean>;
  readonly beforeReplay: (dir: UndoDirection) => void;
  readonly afterReplay: (steps: readonly unknown[]) => void;
  readonly comment: () => void;
  readonly jumpComment: (id: string, rowId?: string | null, field?: string | null) => void;
  readonly selection: () => FlowRange | null;
  readonly place: (range: FlowRange) => void;
  readonly check: () => string[];
  readonly dispose: () => void;
}

const MARK_OF: Readonly<Record<string, MarkName>> = { bold: "b", italic: "i", underline: "u", highlight: "hl", direction: "dir" };
const SHOWN_TAGS: Readonly<Record<string, string>> = { bold: "strong", italic: "em", underline: "u", highlight: "mark", direction: ".stage-dir" };
const SETTINGS = { enter: "double", tick: "delete", gapTyping: "here", markdown: true } as const;

interface RowStep {
  readonly op?: string;
  readonly rowId?: string;
  readonly key?: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export function createFlowWriter(ports: FlowWriterPorts): FlowWriter {
  const root = ports.root;
  const epoch = ports.lifetime.epoch();
  const isCurrent = () => ports.lifetime.epoch() === epoch;
  let replaying: FlowSelectionPair | null = null;
  let replayDir: UndoDirection = "undo";

  function took(outcome: CommandOutcome): boolean {
    if (outcome.kind === "failed") throw outcome.error;
    if (outcome.kind === "rejected") ports.notice(outcome.reason, "warn");
    return outcome.kind === "applied" || outcome.kind === "committed";
  }

  // why: the surface paints its own edits, and the rows behind the writer are redrawn when it closes
  function syncBeat(rowId: string, runs: readonly Run[]): void {
    if (!isCurrent()) return;
    ports.shown(() => { took(ports.run(cellTextCommand(rowId, "audioText", cellRuns(runs), ports.text))); });
  }

  function commit(name: string, operation: (doc: FlowDoc) => FlowOutcome, before: FlowRange | null): FlowOutcome {
    if (!isCurrent()) return null;
    ports.undo.breakCoalescing();
    let result: FlowOutcome = null;
    const outcome = ports.shown(() => ports.run(flowCommand(name, doc => {
      result = operation(doc);
      return result;
    }, ports.text, before)));
    const applied = took(outcome);
    return applied || outcome.kind === "noop" ? result : null;
  }

  const surface = createSurface({
    root,
    doc: ports.doc,
    flow: ports.flow,
    decode: ports.decode,
    storedHtml: ports.storedHtml,
    syncBeat,
    commit,
    undo: dir => { if (isCurrent()) ports.undo.step(dir); },
    breakCoalescing: ports.undo.breakCoalescing,
    notice: text => { ports.notice(text, "ok"); },
    changed: ports.changed,
    selectionMoved: ports.selectionMoved,
    settings: () => SETTINGS,
    openFind: () => { ports.notice("Find isn't in this build of the writer yet.", "warn"); },
    plainVisual: ports.plainVisual,
    beatInput: (event, beat) => { if (isCurrent()) ports.beatInput(event, beat); },
    typeAtBeatEdge: (beat, words) => isCurrent() && ports.typeAtBeatEdge(beat, words),
    beatKeydown: (event, beat) => isCurrent() && ports.beatKeydown(event, beat),
    beatSelection: beat => { if (isCurrent()) ports.beatSelection(beat); },
    leaveBeat: beat => { if (isCurrent()) ports.leaveBeat(beat); }
  });

  function rowOf(rowId: string): FlowRow | undefined {
    return ports.doc().rows.find(row => row.id === rowId);
  }

  function caret(rowId: string, offset: number | "end"): void {
    const row = rowOf(rowId);
    if (!row) return;
    const at = offset === "end" ? ports.decode(row.audioText ?? "").reduce((sum, run) => sum + (run.atom ? 1 : run.text.length), 0) : offset;
    surface.place(caretAt(beatPos(rowId, at)), true);
  }

  function format(command: string): void {
    const mark = MARK_OF[command];
    if (mark) surface.format(mark);
  }

  function marks(): Record<string, boolean> {
    const range = surface.selection();
    const state: Record<string, boolean> = {};
    const pending = surface.pendingMarks() as Readonly<Record<string, unknown>> | null;
    const focus = window.getSelection()?.focusNode ?? null;
    const at = focus && focus.nodeType === 3 ? focus.parentElement : focus as Element | null;
    Object.keys(MARK_OF).forEach(command => {
      const mark = MARK_OF[command] as string;
      if (pending) { state[command] = !!pending[mark]; return; }
      state[command] = !!(range && at && root.contains(at) && at.closest(SHOWN_TAGS[command] as string));
    });
    return state;
  }

  function beforeReplay(dir: UndoDirection): void {
    const entry = dir === "undo" ? ports.undo.last() : ports.undo.nextRedo();
    replaying = entry?.selection ?? null;
    replayDir = dir;
  }

  function afterReplay(steps: readonly unknown[]): void {
    surface.repaint();
    const recorded = replaying;
    replaying = null;
    if (recorded) {
      surface.place(replayDir === "undo" ? recorded.before ?? recorded.after : recorded.after, true);
    } else {
      const step = (steps as readonly RowStep[]).find(item => item.op === "rowField" && item.key === "audioText");
      if (step && step.rowId) surface.place(caretAt(beatPos(step.rowId, ports.caretAfterStep(step))), true);
    }
    ports.changed();
  }

  function comment(): void {
    if (!isCurrent()) return;
    const range = surface.selection();
    if (!range || isCollapsed(range) || !withinOneBeat(range) || range.head.kind !== "beat") {
      ports.notice("Select some text inside one beat, then add a comment.", "warn");
      return;
    }
    const doc = ports.doc();
    const { from, to } = orderedRange(doc, range);
    const row = rowOf(range.head.rowId);
    if (!row || from.kind !== "beat" || to.kind !== "beat") return;
    const id = ports.newCommentId();
    const quotedText = logicalText(doc, range, ports.flow);
    const next = addComment(ports.decode(row.audioText ?? ""), from.offset, to.offset, id);
    ports.undo.breakCoalescing();
    syncBeat(row.id, next);
    surface.repaint();
    ports.openComment({ id, rowId: row.id, field: "audioText", quotedText });
  }

  function jumpComment(id: string, rowId?: string | null, field?: string | null): void {
    if (!isCurrent()) return;
    if (field === "visualText" && rowId && rowOf(rowId)) { caret(rowId, 0); return; }
    for (const row of ports.doc().rows) {
      let offset = 0;
      for (const run of ports.flow.cells(row.audioText)) {
        if (run.marks.cmt?.includes(id)) {
          caret(row.id, offset);
          const anchor = root.querySelector<HTMLElement>('.wr-beat[data-id="' + CSS.escape(row.id) + '"] .cmt-anchor[data-cmt="' + CSS.escape(id) + '"]');
          if (anchor) {
            anchor.classList.remove("flash");
            void anchor.offsetWidth;
            anchor.classList.add("flash");
          }
          return;
        }
        offset += run.atom ? 1 : run.text.length;
      }
    }
    ports.notice("That text is no longer in the script.", "warn");
  }

  // why: a comment box takes the keyboard while it is open, so the caret goes back to where it was when it closes
  const dialog = root.ownerDocument.getElementById("comment-modal");
  const observer = new MutationObserver(() => {
    if (dialog && dialog.hidden && root.isConnected && isCurrent()) surface.focusBack();
  });
  if (dialog) observer.observe(dialog, { attributes: true, attributeFilter: ["hidden"] });

  return {
    isCurrent,
    finish: () => isCurrent() ? surface.finish() : null,
    repaint: () => { if (isCurrent()) surface.repaint(); },
    caret,
    format,
    marks,
    beforeReplay,
    afterReplay,
    comment,
    jumpComment,
    selection: surface.selection,
    place: range => { surface.place(range); },
    check: surface.domCheck,
    dispose: () => {
      observer.disconnect();
      surface.dispose();
    }
  };
}
