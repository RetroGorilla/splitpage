import type { DocumentReader } from "../../../application/session/document-reader.ts";
import { currentDocument, onDocumentReplaced, onRefresh, onSessionChange, readSession, requestRefresh, stampDocument } from "../../../legacy/session-bridge.ts";

export const documentReader: DocumentReader = {
  current: currentDocument,
  read: readSession,
  onChange: onSessionChange,
  onReplaced: onDocumentReplaced,
  onRefresh: onRefresh
};

export const refresh = { request: requestRefresh };

export const stamping = { stamp: stampDocument };
