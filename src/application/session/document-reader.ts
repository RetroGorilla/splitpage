import type { CommonDocumentSession, DocumentView } from "./document-session.ts";
import type { DocumentNumbering } from "../../core/document/numbering.ts";

export interface DocumentReader<Current extends DocumentView = DocumentView> {
  readonly numbering: () => DocumentNumbering;
  readonly current: () => Current | null;
  readonly read: CommonDocumentSession["read"];
  readonly onChange: CommonDocumentSession["subscribe"];
  readonly onReplaced: (listener: () => void) => () => void;
  readonly onRefresh: (listener: (jobs: ReadonlySet<string>) => void) => () => void;
}
