import { cellRuns, cellTextCommand } from "../../application/commands/cell-text.ts";
import { flowCommand } from "../../application/commands/flow.ts";
import type { UndoDirection } from "../../application/editing/undo/undo.ts";
import type { EditorSelection } from "../../application/editing/selection.ts";
import type { Command, CommandOutcome, DocumentSession } from "../../application/session/document-session.ts";
import type { CellTextPorts } from "../../application/session/ports.ts";
import { beatPos, caretAt, comparePos, isCollapsed, logicalText, orderedRange, withinOneBeat } from "../../core/flow/flow.ts";
import { setVisualForRange } from "../../core/flow/visual.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowRange, FlowRow, FlowSelectionPair } from "../../core/flow/flow.ts";
import { addComment, breakLine, deleteRange, insertCell } from "../../core/text/edits.ts";
import type { MarkName, Run } from "../../core/text/runs.ts";
import { createSurface } from "./flow-surface.ts";
import type { SurfacePorts } from "./flow-surface.ts";
import { flowMatchStart, replaceFlowMatches, searchFlow, visualMatchHighlight } from "./flow-find.ts";
import type { WriterFindAccess } from "../common/writer-find.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import { rowSlots } from "../../core/document/gallery.ts";
import { escapeHtml, safeImageSrc } from "../../core/document/text-policy.ts";
import { toHtml } from "../../core/text/html.ts";
import { cellLength } from "../../core/text/runs.ts";
import { cellSelection, setCellSelection } from "../common/cell-selection.ts";
import { createFlowVisualBox } from "./flow-visual-box.ts";
import { ensureTrailingCaretSpot } from "../common/dom.ts";

export interface FlowUndoPorts {
  readonly step: (dir: UndoDirection) => void;
  readonly flush: () => void;
  readonly breakCoalescing: () => void;
  readonly last: () => { readonly selection?: FlowSelectionPair } | null | undefined;
  readonly nextRedo: () => { readonly selection?: FlowSelectionPair } | null | undefined;
}

export interface FlowWriterPorts {
  readonly openFind?: () => void;
  readonly closeFind?: () => void;
  readonly pictures?: Pick<PictureStore, "imgHtml">;
  readonly visualInput?: (event: InputEvent, cell: HTMLElement) => void;
  readonly visualLeave?: (cell: HTMLElement) => void;
  readonly visualKeydown?: (event: KeyboardEvent, cell: HTMLElement) => boolean;
  readonly clipboard?: SurfacePorts["clipboard"];
  readonly lifetime: Pick<DocumentSession, "epoch">;
  readonly heldSelection: Pick<EditorSelection<object, unknown, unknown>, "rememberFlow" | "resolveFlow" | "forget">;
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
  readonly find: WriterFindAccess;
  readonly openVisual: (rowId: string, highlight?: { from: number; to: number }) => void;
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
  readonly selectedText: () => string | null;
  readonly place: (range: FlowRange) => void;
  readonly check: () => string[];
  readonly dispose: () => void;
}

const MARK_OF: Readonly<Record<string, MarkName>> = { bold: "b", italic: "i", underline: "u", strikeThrough: "s", highlight: "hl", direction: "dir" };
const SHOWN_TAGS: Readonly<Record<string, string>> = { bold: "strong", italic: "em", underline: "u", strikeThrough: "s", highlight: "mark", direction: ".stage-dir" };
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
  let findVisuals = false;
  let visual: ReturnType<typeof createFlowVisualBox> | null = null;

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
    ...(ports.clipboard ? { clipboard: ports.clipboard } : {}),
    root,
    lifetime: ports.lifetime,
    heldSelection: ports.heldSelection,
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
    selectionMoved: () => { ports.selectionMoved(); visual?.refresh(); },
    settings: () => SETTINGS,
    openFind: () => { ports.openFind?.(); },
    plainVisual: ports.plainVisual,
    beatInput: (event, beat) => { if (isCurrent()) ports.beatInput(event, beat); },
    typeAtBeatEdge: (beat, words) => isCurrent() && ports.typeAtBeatEdge(beat, words),
    beatKeydown: (event, beat) => isCurrent() && ports.beatKeydown(event, beat),
    beatSelection: beat => { if (isCurrent()) ports.beatSelection(beat); },
    leaveBeat: beat => { if (isCurrent()) ports.leaveBeat(beat); }
  });

  visual = createFlowVisualBox({
    root, doc: ports.doc, selection: surface.selection, prepare: surface.prepareVisual, place: range => { surface.place(range); }, current: isCurrent,
    plainVisual: ports.plainVisual,
    thumbnails: row => rowSlots(row).map(slot => {
      if (slot.ref && ports.pictures) return ports.pictures.imgHtml(slot.ref, "wr-flow-visual-thumb");
      const url = safeImageSrc(slot.dataUrl);
      return url ? '<img class="wr-flow-visual-thumb" src="' + escapeHtml(url) + '" alt="' + escapeHtml(slot.name || "Picture") + '">' : "";
    }).join(""),
    save: (range, html, first) => {
      if (!isCurrent() || range.head.kind !== "beat") return null;
      const clean = toHtml(ports.decode(ports.storedHtml(html)));
      let after = range;
      if (first) {
        const result = commit("visual-selection", doc => setVisualForRange(doc, range, clean, ports.flow), range);
        if (!result || !("selection" in result)) return null;
        after = result.selection;
      } else {
        const outcome = ports.shown(() => ports.run(cellTextCommand(range.head.kind === "beat" ? range.head.rowId : "", "visualText", cellRuns(ports.decode(clean)), ports.text)));
        if (!took(outcome) && outcome.kind !== "noop") return null;
      }
      ports.heldSelection.rememberFlow(epoch, after);
      surface.repaint();
      ports.changed();
      return after;
    },
    input: (event, cell) => { if (isCurrent()) ports.visualInput?.(event, cell); },
    leave: cell => { if (isCurrent()) { ports.visualLeave?.(cell); surface.repaint(); } },
    keydown: (event, cell) => isCurrent() && !!ports.visualKeydown?.(event, cell),
    notice: message => { ports.notice(message, "warn"); },
    undo: dir => { if (isCurrent()) ports.undo.step(dir); },
    paste: (cell, data) => {
      const selection = cellSelection(cell);
      if (!selection) return;
      const holder = document.createElement("div");
      holder.innerHTML = data.getData("text/html");
      holder.querySelectorAll("img, .video-embed-card").forEach(element => element.remove());
      const html = holder.innerHTML;
      const pasted = html ? ports.decode(html) : [{ text: data.getData("text/plain"), marks: {} }];
      const old = ports.decode(ports.storedHtml(cell.innerHTML));
      const line = !html && data.getData("text/plain") === "\n" ? breakLine(old, selection.from, selection.to) : null;
      const next = line ?? insertCell(deleteRange(old, selection.from, selection.to), selection.from, pasted);
      cell.innerHTML = toHtml(next.cell);
      ensureTrailingCaretSpot(cell);
      const at = line?.pos ?? selection.from + cellLength(pasted);
      setCellSelection(cell, at, at);
    }
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
    visual?.close(false);
    const entry = dir === "undo" ? ports.undo.last() : ports.undo.nextRedo();
    replaying = entry?.selection ?? null;
    replayDir = dir;
  }

  function afterReplay(steps: readonly unknown[]): void {
    surface.repaint();
    const recorded = replaying;
    replaying = null;
    if (recorded) {
      surface.restoreAfterReplay(replayDir === "undo" ? recorded.before ?? recorded.after : recorded.after);
    } else {
      const step = (steps as readonly RowStep[]).find(item => item.op === "rowField" && item.key === "audioText");
      if (step && step.rowId) surface.restoreAfterReplay(caretAt(beatPos(step.rowId, ports.caretAfterStep(step))));
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
  const dialogs = ["comment-modal", "tag-modal"].map(id => root.ownerDocument.getElementById(id)).filter((element): element is HTMLElement => !!element);
  const observer = new MutationObserver(() => {
    if (dialogs.every(dialog => dialog.hidden) && root.isConnected && isCurrent()) surface.focusBack();
  });
  dialogs.forEach(dialog => observer.observe(dialog, { attributes: true, attributeFilter: ["hidden"] }));

  const writer: FlowWriter = {
    openVisual: (rowId, highlight) => {
      if (!isCurrent() || !rowOf(rowId)) return;
      surface.place(caretAt(beatPos(rowId, 0)), true);
      visual?.open(caretAt(beatPos(rowId, 0)), highlight);
    },
    find: {
      visuals: () => findVisuals,
      setVisuals: value => { findVisuals = value; },
      search: (needle, matchCase) => isCurrent() ? searchFlow(ports.doc(), needle, matchCase, findVisuals, ports.flow) : { matches: [], inTags: 0 },
      reveal: match => {
        if (!isCurrent()) return null;
        if (match.kind === "visual") {
          writer.openVisual(match.rowId, visualMatchHighlight(ports.doc(), match, ports.flow));
          return null;
        }
        const range = surface.domRange(match.range);
        const node = range?.startContainer;
        (node?.nodeType === 3 ? node.parentElement : node as HTMLElement | undefined)?.scrollIntoView({ block: "center" });
        return range;
      },
      replace: (matches, text) => {
        const before = surface.selection();
        const result = commit("writer-find-replace", doc => replaceFlowMatches(doc, matches, text, ports.flow), before);
        if (!result || !("rows" in result)) return false;
        surface.repaint();
        visual?.refresh();
        ports.changed();
        return true;
      },
      leave: match => {
        if (!isCurrent()) return;
        if (match?.kind === "visual") {
          writer.openVisual(match.rowId, visualMatchHighlight(ports.doc(), match, ports.flow));
          visual?.close(false);
          caret(match.rowId, 0);
        }
        else if (match) surface.place(match.range, true);
        else surface.focusBack();
      },
      selection: surface.selection,
      pickedText: () => {
        const range = surface.selection();
        return range && !isCollapsed(range) ? logicalText(ports.doc(), range, ports.flow) : "";
      },
      firstFrom: (matches, range) => {
        if (!range) return 0;
        const from = orderedRange(ports.doc(), range).from;
        const index = matches.findIndex(match => comparePos(ports.doc(), flowMatchStart(match), from) >= 0);
        return index < 0 ? 0 : index;
      }
    },
    isCurrent,
    finish: () => { visual?.close(false); return isCurrent() ? surface.finish() : null; },
    repaint: () => { if (isCurrent()) { surface.repaint(); visual?.refresh(); } },
    caret,
    format,
    marks,
    beforeReplay,
    afterReplay,
    comment,
    jumpComment,
    selection: surface.selection,
    selectedText: () => {
      const range = surface.selection();
      return range && !isCollapsed(range) ? logicalText(ports.doc(), range, ports.flow) : null;
    },
    place: range => { surface.place(range); },
    check: surface.domCheck,
    dispose: () => {
      ports.closeFind?.();
      observer.disconnect();
      visual?.dispose();
      surface.dispose();
    }
  };
  return writer;
}
