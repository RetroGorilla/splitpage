import type { ValidatedDocument } from "../../../core/document/validated.ts";
import type { DocumentReader } from "../../../application/session/document-reader.ts";
import type { CommonDocumentSession, StandaloneDocumentSession } from "../../../application/session/document-session.ts";
import { cancelRefresh, currentDocument, documentNumbering, liveSession, noteSessionEdit, onDocumentReplaced, onRefresh, onSessionChange, readSession, requestRefresh, stampDocument } from "../session-owner.ts";

export const documentReader: DocumentReader<ValidatedDocument> = {
  numbering: documentNumbering,
  current: currentDocument,
  read: readSession,
  onChange: onSessionChange,
  onReplaced: onDocumentReplaced,
  onRefresh: onRefresh
};

export const refresh: { readonly request: CommonDocumentSession["refresh"]; readonly cancel: CommonDocumentSession["cancelRefresh"] } = { request: requestRefresh, cancel: cancelRefresh };

export const documentLifetime: Pick<CommonDocumentSession, "epoch"> = { epoch: () => liveSession().epoch() };

export const stamping: Pick<StandaloneDocumentSession, "stamp"> = { stamp: stampDocument };

export const legacyEdit: Pick<StandaloneDocumentSession, "noteEdit"> = { noteEdit: noteSessionEdit };
