import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { PaintGuard } from "../../application/editing/paint-guard.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";

export interface ReadTimePorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly text: Pick<TextServices, "productionReaders">;
  readonly edits: Pick<DocumentEdits, "run" | "stamps">;
  readonly undo: Pick<UndoControl, "undo" | "redo">;
  readonly paint: Pick<PaintGuard, "afterThisPaint">;
  readonly review: Pick<ReviewFacts, "reviewing">;
  readonly notices: Pick<NoticePort, "show">;
}
