import type { DocumentSession } from "../../application/session/document-session.ts";
import type { FocusMemory } from "../../application/editing/focus-memory.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { PersonColorLookup } from "../../core/document/person-colors.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { DeleteConfirm } from "../../application/editing/delete-confirm.ts";
import type { ProductionSelection } from "../../application/editing/production-selection.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { ShotHiding } from "../../application/shot-hiding.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { ProductionIndexOwner } from "../../core/production/index.ts";
import type { TagPanelState } from "../../application/tag-panel-state.ts";
import type { TagPanelCommands } from "../../application/tag-panel-commands.ts";
import type { BulkTagRows } from "../../application/commands/bulk-tags.ts";
import type { Marks } from "../../core/text/runs.ts";
import type { BrollEntry } from "../../core/production/broll.ts";

export interface TagPanelMount extends TagPanelCommands {
  readonly openProductionPanel: () => void;
  readonly openGearPanel: () => void;
  readonly dispose: () => void;
}

export interface PlainTagPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly cells: Pick<CellEditing<Element>, "edit" | "open">;
  readonly undo: Pick<UndoControl, "breakCoalescing">;
  readonly text: Pick<TextServices<HTMLElement>, "fromHtml" | "storedHtmlFromDom">;
}

export type TagCaretRefusal = "audio" | "link" | "tag" | "tag-selection" | "open" | "elsewhere";

export interface PlainTagControl {
  readonly openCategoryAtCaret: (cellEl: HTMLElement, marks: Marks) => TagCaretRefusal | null;
  readonly chooseCategory: (cat: string | null) => boolean;
  readonly cancelCategory: () => boolean;
  readonly maybeOpen: (e: { inputType?: string; data?: string | null }, cellEl: Element) => void;
  readonly refresh: () => void;
  readonly beforeWrite: (cellEl: Element) => (() => void) | null;
  readonly noteInput: (cellEl: Element) => void;
  readonly cancel: () => void;
  readonly close: () => boolean;
  readonly isOpen: (cellEl?: Element | null) => boolean;
  readonly emptyAtCaret: () => boolean;
  readonly cancelOnBackspace: () => boolean;
  readonly onTagged: (listener: () => void) => () => void;
}

export interface PlainTagMount extends PlainTagControl {
  readonly dispose: () => void;
}

export interface WhoListPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly cells: Pick<CellEditing<Element>, "edit">;
  readonly text: Pick<TextServices<HTMLElement>, "fromHtml" | "storedHtmlFromDom">;
}

export interface WhoListControl {
  readonly maybeOpen: (e: { inputType?: string; data?: string | null }, cellEl: Element) => void;
  readonly refresh: () => void;
  readonly keydown: (e: KeyboardEvent, cellEl: Element) => boolean;
  readonly cancel: () => void;
  readonly isOpen: (cellEl?: Element | null) => boolean;
  readonly onPicked: (listener: () => void) => () => void;
}

export interface WhoListMount extends WhoListControl {
  readonly dispose: () => void;
}

export interface TagPanelPorts {
  readonly view: Pick<TagPanelState, "prep" | "gearGroupBy" | "productionGroupBy" | "setTagAddingPerson" | "setTagRenaming" | "tagAddingPersonKey" | "tagExpandedKey" | "tagRenamingKey">;
  readonly focus: Pick<FocusMemory<HTMLElement>, "lastRow">;
  readonly beats: { readonly setFilmed: (rowId: string, filmed: boolean) => void; readonly reveal: (rowId: string) => void };
  readonly footage: { readonly entries: () => readonly BrollEntry[]; readonly open: (id: string) => void };
  readonly document: Pick<DocumentReader, "current" | "read" | "numbering">;
  readonly lifetime: Pick<DocumentSession, "epoch">;
  readonly edits: Pick<DocumentEdits, "edit" | "stamps">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "productionReaders" | "inertBody" | "retagBody" | "sanitizeHtml">;
  readonly production: Pick<ProductionIndexOwner, "entries" | "current">;
  readonly deletion: Pick<DeleteConfirm, "armedId" | "arm" | "disarm">;
  readonly selection: Pick<ProductionSelection, "selectedKeys" | "selected" | "toggle" | "select" | "prune" | "clear" | "armed" | "disarm">;
  readonly shotHiding: Pick<ShotHiding, "reveal">;
  readonly panels: Pick<SidePanels, "open">;
  readonly personColors: PersonColorLookup;
  readonly undo: Pick<UndoControl, "breakCoalescing" | "undo" | "last">;
  readonly notices: Pick<NoticePort, "show" | "showAction">;
  readonly ids: IdSource;
  readonly bulkTag: BulkTagRows;
}

export interface ProductionTagPorts {
  readonly document: Pick<DocumentReader, "current" | "read" | "numbering">;
  readonly edits: Pick<DocumentEdits, "edit" | "stamps">;
  readonly refresh: { readonly request: DocumentSession["refresh"]; readonly cancel: DocumentSession["cancelRefresh"] };
  readonly stamping: Pick<DocumentSession, "stamp">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "inertBody" | "sanitizeHtml" | "productionReaders">;
  readonly production: () => Pick<ProductionIndexOwner, "entries" | "current" | "recordsPlan" | "derived" | "resetDerived">;
  readonly editing: {
    readonly cells: () => Pick<CellEditing<Element>, "edit" | "sync">;
    readonly focus: () => Pick<FocusMemory<Element>, "promptMutedFor">;
  };
  readonly undo: Pick<UndoControl, "breakCoalescing">;
  readonly view: () => Pick<ViewFlags, "writerOpen">;
  readonly notices: Pick<NoticePort, "show">;
  readonly ids: IdSource;
}
