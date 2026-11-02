import type { BrollAnchorDeclines } from "../../application/broll-anchoring.ts";
import type { BrollView } from "../../application/preferences/broll-view.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import type { PersonColorLookup } from "../../core/document/person-colors.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { ShotHiding } from "../../application/shot-hiding.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { ProductionIndexOwner } from "../../core/production/index.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { PaintGuard } from "../../application/editing/paint-guard.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { BrollEntry } from "../../core/production/broll.ts";
import type { FieldHtml } from "../../core/production/ports.ts";
import type { Run } from "../../core/text/runs.ts";
import type { ScreenState } from "../../application/screen.ts";

interface BrollHtmlLine {
  readonly nodes: Node[];
  readonly br: Node | null;
}

interface BrollAnchors {
  readonly inRows: (rows: readonly { readonly id: string; visualText: FieldHtml }[]) => number;
  readonly htmlLines: (body: HTMLElement) => BrollHtmlLine[];
  readonly keyHtml: (id: string, text: string) => string;
}

export interface BrollRecordsPorts {
  readonly document: Pick<DocumentReader, "read"> & { readonly current: () => ValidatedDocument | null };
  readonly edits: Pick<DocumentEdits, "run" | "edit" | "stamps" | "text">;
  readonly cells: Pick<CellEditing<Element>, "edit">;
  readonly paint: Pick<PaintGuard, "whileShown">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "inertBody" | "sanitizeHtml" | "htmlToPlainText" | "productionReaders">;
  readonly scriptCellOf: (html: FieldHtml) => readonly Run[];
  readonly ids: IdSource;
  readonly caretSpot: (cell: Element) => void;
  readonly position: (cell: Node, node: Node, offset: number) => number | null;
  readonly anchors: BrollAnchors;
  readonly anchoring: Pick<BrollAnchorDeclines, "reset">;
  readonly refresh: (job: string) => void;
}

interface BrollRecords {
  readonly brollEntries: () => BrollEntry[];
  readonly addBrollProp: (shotId: string, rawName: string) => boolean;
  readonly brollShotsByProp: () => Record<string, string[]>;
  readonly maybeCaptureBroll: (e: InputEvent, cellEl: Element) => void;
  readonly anchorBrollInLeftCell: (cellEl: Element) => number;
  readonly renameBrollInScript: (entry: BrollEntry, newName: string) => boolean;
  readonly updateBrollBadge: () => void;
  readonly scheduleBrollRefresh: () => void;
}

export interface BrollRecordsMount extends BrollRecords {
  readonly dispose: () => void;
}

export interface BrollPanelPorts {
  readonly screen: () => ScreenState;
  readonly view: Pick<BrollView, "load" | "current" | "setFilter" | "setGroup" | "setPageGroup">;
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly edits: Pick<DocumentEdits, "edit">;
  readonly text: Pick<TextServices<HTMLElement>, "productionReaders">;
  readonly ids: IdSource;
  readonly production: Pick<ProductionIndexOwner, "entries">;
  readonly shotHiding: Pick<ShotHiding, "reveal">;
  readonly panels: Pick<SidePanels, "open" | "close" | "closeAll" | "registerPanel" | "sync">;
  readonly flags: Pick<ViewFlags, "brollPageOpen" | "setBrollPageOpen">;
  readonly personColors: PersonColorLookup;
  readonly undo: Pick<UndoControl, "breakCoalescing">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly notices: Pick<NoticePort, "show">;
  readonly records: Pick<BrollRecords, "brollEntries" | "addBrollProp" | "renameBrollInScript" | "updateBrollBadge">;
  readonly rows: { readonly focusField: (rowId: string, field: string) => void };
}

export interface BrollPanelState {
  readonly openBrollPanel: () => void;
  readonly dispose: () => void;
}

export interface BrollPanelEventsPorts {
  readonly exportAs: (format: string) => unknown;
}
