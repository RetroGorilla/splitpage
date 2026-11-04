import { deriveDocumentNumbering } from "../../core/document/numbering.ts";
import type { DocumentNumbering } from "../../core/document/numbering.ts";
import type { SceneDocument } from "../../core/document/scenes.ts";
import type { ChangeSet } from "./change-set.ts";

export interface DocumentNumberingReader {
  readonly read: (doc: SceneDocument | null) => DocumentNumbering;
  readonly changed: (changes: ChangeSet) => void;
}

export function createNumberingReader(): DocumentNumberingReader {
  let held: DocumentNumbering | null = null;
  let source: SceneDocument | null = null;
  return {
    read(doc) {
      if (!held || source !== doc) held = deriveDocumentNumbering(doc ?? { rows: [] });
      source = doc;
      return held;
    },
    changed(changes) {
      if (changes.whole || changes.rowsMoved || changes.rowsInserted.length || changes.rowsRemoved.length ||
        changes.docFields.includes("sections")) held = null;
    }
  };
}
