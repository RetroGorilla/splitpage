import type { ActionRegistry } from "../../application/actions.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { RowDrag } from "../../application/editing/row-drag.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { PreferenceChanges, Preferences } from "../../application/preferences/preferences.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";

export interface RundownPorts {
  readonly document: Pick<DocumentReader, "current" | "read" | "numbering">;
  readonly text: Pick<TextServices, "cellOf" | "productionReaders" | "cacheSeal">;
  readonly rowDrag: Pick<RowDrag, "dragging" | "end">;
  readonly cells: Pick<CellEditing<Element>, "moveRow">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly minimized: Pick<Preferences, "rundownMin" | "setRundownMin">;
  readonly changes: PreferenceChanges;
}

export interface TargetPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly edits: Pick<DocumentEdits, "edit">;
  readonly notices: Pick<NoticePort, "show">;
}

export interface TargetMount {
  readonly dispose: () => void;
}
