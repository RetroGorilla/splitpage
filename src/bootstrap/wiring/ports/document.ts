import type { DocumentReader } from "../../../application/session/document-reader.ts";
import { currentDocument, onDocumentReplaced, onRefresh, onSessionChange, readSession } from "../../../legacy/session-bridge.ts";

export const documentReader: DocumentReader = {
  current: currentDocument,
  read: readSession,
  onChange: onSessionChange,
  onReplaced: onDocumentReplaced,
  onRefresh: onRefresh
};
