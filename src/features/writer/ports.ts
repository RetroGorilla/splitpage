import type { ActionRegistry } from "../../application/actions.ts";
import type { PaintGuard } from "../../application/editing/paint-guard.ts";
import type { EditorSelection } from "../../application/editing/selection.ts";
import type { Undo, UndoDirection } from "../../application/editing/undo/undo.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { PaintedTextSource, WholeFieldTextCommit } from "../../application/editing/ports.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { Command, CommonDocumentSession } from "../../application/session/document-session.ts";
import type { CellTextPorts } from "../../application/session/ports.ts";
import type { FlowCommandSource } from "../../application/commands/flow.ts";
import type { FlowDoc, FlowPorts, FlowRange, FlowRow } from "../../core/flow/flow.ts";
import type { Run } from "../../core/text/runs.ts";
import type { SurfacePorts } from "./flow-surface.ts";
import type { WriterFindAccess } from "../common/writer-find.ts";
import type { FlowVisualBufferMount } from "./flow-visual-box.ts";

export interface FlowWriter {
  readonly settle?: () => boolean;
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
  readonly place: (range: FlowRange, scroll?: boolean) => void;
  readonly check: () => string[];
  readonly dispose: () => void;
}

export interface FlowUndoPorts extends Pick<Undo, "flush" | "breakCoalescing" | "last" | "nextRedo"> {
  readonly step: (dir: UndoDirection) => void;
}

export interface FlowWriterPorts {
  readonly visualBuffer?: FlowVisualBufferMount;
  readonly commands?: FlowCommandSource;
  readonly openFind?: () => void;
  readonly closeFind?: () => void;
  readonly pictures?: Pick<PictureStore, "imgHtml">;
  readonly visualInput?: (event: InputEvent, cell: HTMLElement) => void;
  readonly visualBeforeWrite?: (cell: Element) => ((selection?: CellRange | null) => void) | null;
  readonly visualLeave?: (cell: HTMLElement) => void;
  readonly visualKeydown?: (event: KeyboardEvent, cell: HTMLElement) => boolean;
  readonly clipboard?: SurfacePorts["clipboard"];
  readonly paintedText?: PaintedTextSource;
  readonly bufferedText?: SurfacePorts["bufferedText"];
  readonly lifetime: Pick<CommonDocumentSession, "epoch">;
  readonly heldSelection: Pick<EditorSelection<object, unknown, unknown>, "rememberFlow" | "resolveFlow" | "forget">;
  readonly root: HTMLElement;
  readonly doc: () => FlowDoc;
  readonly flow: FlowPorts;
  readonly decode: (html: string) => Run[];
  readonly storedHtml: (html: string) => string;
  readonly moveBeat: (rowId: string, direction: -1 | 1) => Command;
  readonly run: CommonDocumentSession["run"];
  readonly shown: <T>(edit: () => T) => T;
  readonly editingBlocked: () => boolean;
  readonly text: CellTextPorts;
  readonly wholeFieldText: WholeFieldTextCommit;
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

export interface FlowWriterMaker {
  readonly prepareSplit: (rowId?: string) => void;
  readonly splitReady: () => boolean;
  readonly create: (root: HTMLElement, selectionMoved: () => void, undoStep: (dir: UndoDirection) => void) => FlowWriter;
}

export interface WriterFeaturePorts {
  readonly flow: FlowWriterMaker;
  readonly document: Pick<DocumentReader, "current" | "read" | "numbering">;
  readonly edits: Pick<DocumentEdits, "allowed" | "run" | "text">;
  readonly text: Pick<TextServices, "sanitizeHtml" | "storedHtmlFromDom" | "productionReaders" | "htmlToPlainText">;
  readonly editing: {
    readonly selection: () => Pick<EditorSelection<Element, Range, Element>, "remember" | "forget" | "paintedEpoch" | "resolve" | "notePainted">;
    readonly paint: () => Pick<PaintGuard, "whilePainting" | "whileShown">;
  };
  readonly undo: Pick<Undo, "breakCoalescing" | "last" | "nextRedo" | "lifetime" | "mark" | "serial">;
  readonly panels: () => Pick<SidePanels, "closeAll" | "open">;
  readonly preferences: () => Pick<Preferences, "writerSize" | "setWriterSize">;
  readonly view: () => Pick<ViewFlags, "writerOpen" | "setWriterOpen" | "findOpen">;
  readonly notices: Pick<NoticePort, "show">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly formatting: {
    readonly selection: (button: Element, cell: HTMLElement, wrap: Element) => void;
    readonly confirmLink: (wrap: Element, cell: HTMLElement | null) => void;
    readonly cancelLink: (wrap: Element) => void;
  };
  readonly dismissTagGhost: () => void;
  readonly scheduleStats: (job: string) => void;
  readonly cancelStats: () => void;
}

export interface WriterActionPorts {
  readonly screen: () => ScreenState;
}
