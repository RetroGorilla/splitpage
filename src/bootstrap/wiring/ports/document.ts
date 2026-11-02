import type { ValidatedDocument } from "../../../core/document/validated.ts";
import type { DocumentReader } from "../../../application/session/document-reader.ts";
import { cancelRefresh, currentDocument, onDocumentReplaced, onRefresh, onSessionChange, readSession, requestRefresh, stampDocument } from "../session-owner.ts";

export const documentReader: DocumentReader<ValidatedDocument> = {
  current: currentDocument,
  read: readSession,
  onChange: onSessionChange,
  onReplaced: onDocumentReplaced,
  onRefresh: onRefresh
};

export const refresh = { request: requestRefresh, cancel: cancelRefresh };

export const stamping = { stamp: stampDocument };
