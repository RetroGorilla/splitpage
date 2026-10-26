import type { Presence } from "../../application/collaboration/presence.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
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

export interface TagPanelMount extends TagPanelCommands {
  readonly openProductionPanel: () => void;
  readonly openGearPanel: () => void;
  readonly dispose: () => void;
}

export interface TagPanelPorts {
  readonly view: Pick<TagPanelState, "gearGroupBy" | "productionGroupBy" | "setTagAddingPerson" | "setTagRenaming" | "tagAddingPersonKey" | "tagExpandedKey" | "tagRenamingKey">;
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly edits: Pick<DocumentEdits, "edit" | "stamps">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "productionReaders" | "inertBody" | "retagBody" | "sanitizeHtml">;
  readonly production: Pick<ProductionIndexOwner, "entries" | "current">;
  readonly deletion: Pick<DeleteConfirm, "armedId" | "arm" | "disarm">;
  readonly selection: Pick<ProductionSelection, "selectedKeys" | "selected" | "toggle" | "select" | "prune" | "clear" | "armed" | "disarm">;
  readonly shotHiding: Pick<ShotHiding, "reveal">;
  readonly panels: Pick<SidePanels, "open">;
  readonly presence: Pick<Presence, "personColor">;
  readonly undo: Pick<UndoControl, "breakCoalescing">;
  readonly review: Pick<ReviewFacts, "reviewing" | "refuseInReview">;
  readonly notices: Pick<NoticePort, "show">;
  readonly ids: IdSource;
}
