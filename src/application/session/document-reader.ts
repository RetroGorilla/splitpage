import type { DocumentView, SessionListener } from "./document-session.ts";

export interface DocumentReader {
  readonly current: () => DocumentView | null;
  readonly read: <T>(select: (doc: DocumentView | null) => T) => T;
  readonly onChange: (listener: SessionListener) => () => void;
  readonly onReplaced: (listener: () => void) => () => void;
  readonly onRefresh: (listener: (jobs: ReadonlySet<string>) => void) => () => void;
}
