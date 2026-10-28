import type { ActionRegistry } from "../../application/actions.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { FocusMemory } from "../../application/editing/focus-memory.ts";
import type { PaintGuard } from "../../application/editing/paint-guard.ts";
import type { EditorSelection } from "../../application/editing/selection.ts";
import type { Undo } from "../../application/editing/undo/undo.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { ShotRow } from "../../application/shot-hiding.ts";

export interface WriterFeaturePorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly edits: Pick<DocumentEdits, "allowed" | "run" | "text">;
  readonly text: Pick<TextServices, "sanitizeHtml" | "storedHtmlFromDom" | "productionReaders" | "htmlToPlainText">;
  readonly editing: {
    readonly cells: () => Pick<CellEditing<Element>, "sync">;
    readonly selection: () => Pick<EditorSelection<Element, Range, Element>, "remember" | "forget" | "paintedEpoch" | "resolve" | "notePainted">;
    readonly focus: () => Pick<FocusMemory<Element>, "focusedParagraph" | "writerParagraph">;
    readonly paint: () => Pick<PaintGuard, "whilePainting" | "whileShown">;
  };
  readonly undo: Pick<Undo, "breakCoalescing" | "last" | "nextRedo" | "lifetime" | "mark" | "serial">;
  readonly rows: { readonly splitField: (cell: Element) => { readonly id: string; readonly field: string } | null };
  readonly hiding: { readonly renderGroups: <R extends ShotRow>(rows: readonly R[], render: (row: R, index: number) => string) => string };
  readonly panels: () => Pick<SidePanels, "closeAll">;
  readonly preferences: () => Pick<Preferences, "writerSize" | "setWriterSize">;
  readonly view: () => Pick<ViewFlags, "writerOpen" | "setWriterOpen" | "findOpen">;
  readonly notices: Pick<NoticePort, "show">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly formatting: {
    readonly state: (cell: Element) => object | null;
    readonly direction: (cell: Element) => Element | null;
    readonly toggle: (cell: Element, command: string) => Element | null;
  };
  readonly dismissTagGhost: () => void;
  readonly scheduleStats: (job: string) => void;
  readonly cancelStats: () => void;
}

export interface WriterActionPorts {
  readonly screen: () => ScreenState;
}
