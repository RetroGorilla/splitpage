import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { BulkTagRows } from "../../application/commands/bulk-tags.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { FindOptions } from "../../application/find-options.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentEdits, SharedCommandGuard } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { ShotHiding } from "../../application/shot-hiding.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { PrompterState } from "../../application/prompter-state.ts";
import type { WriterFindAccess } from "../common/writer-find.ts";

export interface FindPorts {
  readonly sharedCommands: SharedCommandGuard;
  readonly writer?: () => WriterFindAccess | null;
  readonly document: Pick<DocumentReader, "current" | "read" | "onChange">;
  readonly edits: Pick<DocumentEdits, "edit" | "stamps">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "inertBody" | "sanitizeHtml">;
  readonly shotHiding: () => Pick<ShotHiding, "reveal">;
  readonly undo: Pick<UndoControl, "breakCoalescing">;
  readonly notices: Pick<NoticePort, "show">;
  readonly flags: Pick<ViewFlags, "setFindOpen">;
  readonly options: Pick<FindOptions, "matchesCase">;
  readonly bulkTag: BulkTagRows;
  readonly present: Pick<PrompterState, "isOpen"> & {
    readonly setSearching: (value: boolean, dismiss?: () => void) => void;
    readonly jump: (range: Range) => void;
    readonly onViewChange: (listener: () => void) => () => void;
  };
}

export interface FindControls {
  readonly openFindBar: () => void;
  readonly closeFindBar: () => void;
  readonly dispose: () => void;
}

export interface FindActionPorts {
  readonly flowWriterOpen?: () => boolean;
  readonly screen: () => ScreenState;
  readonly flags: Pick<ViewFlags, "findOpen">;
}
