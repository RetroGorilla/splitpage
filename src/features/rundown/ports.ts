import type { ActionRegistry } from "../../application/actions.ts";
import type { PresenceView } from "../../application/collaboration/presence.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { RowDrag } from "../../application/editing/row-drag.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { PreferenceChanges, Preferences } from "../../application/preferences/preferences.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";

export interface RundownPorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly text: Pick<TextServices, "cellOf" | "productionReaders" | "cacheSeal">;
  readonly rowDrag: Pick<RowDrag, "dragging" | "end">;
  readonly cells: Pick<CellEditing<Element>, "moveRow">;
  readonly review: Pick<ReviewFacts, "reviewing">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly minimized: Pick<Preferences, "rundownMin" | "setRundownMin">;
  readonly changes: PreferenceChanges;
}

export interface RundownPresencePorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly presence: PresenceView;
  readonly actions: Pick<ActionRegistry, "invoke">;
}

export interface TargetPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly edits: Pick<DocumentEdits, "edit">;
  readonly review: Pick<ReviewFacts, "reviewing">;
  readonly notices: Pick<NoticePort, "show">;
}

export interface TargetSection {
  readonly html: () => string;
  readonly wire: (wrap: Element, close: () => void) => void;
}

export interface TargetMount {
  readonly section: TargetSection;
  readonly dispose: () => void;
}
