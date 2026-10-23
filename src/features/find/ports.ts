import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { ShotHiding } from "../../application/shot-hiding.ts";
import type { TextServices } from "../../application/text/services.ts";

export interface FindPorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly edits: Pick<DocumentEdits, "edit" | "stamps">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "inertBody" | "sanitizeHtml">;
  readonly shotHiding: () => Pick<ShotHiding, "reveal">;
  readonly review: Pick<ReviewFacts, "refuseInReview">;
  readonly undo: Pick<UndoControl, "breakCoalescing">;
  readonly notices: Pick<NoticePort, "show">;
  readonly flags: Pick<ViewFlags, "setFindOpen">;
}

export interface FindControls {
  readonly openFindBar: () => void;
  readonly closeFindBar: () => void;
  readonly dispose: () => void;
}

export interface FindActionPorts {
  readonly screen: () => ScreenState;
  readonly flags: Pick<ViewFlags, "findOpen">;
}
