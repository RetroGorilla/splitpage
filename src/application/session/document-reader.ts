import type { DocumentView, SessionListener } from "./document-session.ts";
import type { DocumentNumbering } from "../../core/document/numbering.ts";

export interface DocumentReader<Current extends DocumentView = DocumentView> {
  readonly numbering: () => DocumentNumbering;
  readonly current: () => Current | null;
  readonly read: <T>(select: (doc: DocumentView | null) => T) => T;
  readonly onChange: (listener: SessionListener) => () => void;
  readonly onReplaced: (listener: () => void) => () => void;
  readonly onRefresh: (listener: (jobs: ReadonlySet<string>) => void) => () => void;
}
