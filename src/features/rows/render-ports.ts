import type { ActionRegistry } from "../../application/actions.ts";
import type { PersonColorLookup } from "../../core/document/person-colors.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { DeleteConfirm } from "../../application/editing/delete-confirm.ts";
import type { PaintGuard, UndoGuard } from "../../application/editing/paint-guard.ts";
import type { EditorSelection } from "../../application/editing/selection.ts";
import type { Undo } from "../../application/editing/undo/undo.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { ShotHiding } from "../../application/shot-hiding.ts";
import type { SceneView } from "../../application/editing/scene-view.ts";
import type { TagPanelState } from "../../application/tag-panel-state.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { TagWrite } from "../../core/production/tags.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import type { Run } from "../../core/text/runs.ts";

interface RowDraftMedia {
  readonly markThroughout: (cell: Run[], from: number, to: number, mark: string) => boolean;
  readonly toggleMark: (cell: Run[], from: number, to: number, mark: string) => Run[];
}

interface RowDraftEditing {
  readonly appendMedia: (cell: Element, html: string) => Element | null;
  readonly model: (cell: Element) => { cell: Run[]; media: RowDraftMedia };
  readonly edit: (cell: Element, change: (cell: Run[], selection: CellRange | null, media: RowDraftMedia) => { cell: Run[]; sel?: CellRange } | null) => Element | null;
  readonly isDraft: (cell: Element | null | undefined) => boolean;
  readonly isScript: (cell: Element | null | undefined) => boolean;
}

export interface RowsRenderPorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly edits: Pick<DocumentEdits, "allowed">;
  readonly text: Pick<TextServices, "sanitizeHtml" | "storedHtmlFromDom" | "fromHtml" | "productionReaders">;
  readonly video: {
    readonly card: (url: string) => HTMLElement;
    readonly hostLabel: (link: { href?: string | undefined }) => string;
  };
  readonly editing: {
    readonly cells: () => Pick<CellEditing<Element>, "edit" | "sync">;
    readonly selection: () => Pick<EditorSelection<Element, Range, Element>, "remember" | "forget" | "resolve" | "paintedEpoch" | "notePainted" | "holdLink" | "heldLink" | "dropLink">;
    readonly paint: () => Pick<PaintGuard, "whilePainting" | "painting" | "shown" | "afterShown">;
    readonly undo: () => Pick<UndoGuard, "whileApplying">;
  };
  readonly draft: RowDraftEditing;
  readonly undo: Pick<Undo, "track">;
  readonly hiding: () => Pick<ShotHiding, "groups">;
  readonly scenes: () => Pick<SceneView, "folded">;
  readonly pictures: Pick<PictureStore, "imgHtml">;
  readonly personColors: PersonColorLookup;
  readonly preferences: () => Pick<Preferences, "clock">;
  readonly view: () => Pick<ViewFlags, "writerOpen">;
  readonly notices: NoticePort;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly deletes: () => Pick<DeleteConfirm, "disarm">;
  readonly tagPanel: Pick<TagPanelState, "setTagAddingPerson">;
  readonly ids: Pick<IdSource, "id">;
  readonly production: {
    readonly stats: () => { derived: number; flushes: number };
    readonly resetStats: () => void;
    readonly scan: () => void;
    readonly occurrences: (html: string, phrase: string, cat: string, name: string, countOnly: boolean) => TagWrite;
  };
}
