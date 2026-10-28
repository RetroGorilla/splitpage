import type { DocumentReader } from "../session/document-reader.ts";
import type { LiveDocumentPort, IdentityPort } from "../transitions/ports.ts";
import type { DocumentLocation } from "../location/document-location.ts";
import type { HistoryOwner } from "../recovery/history-ports.ts";
import type { NoticePort } from "../effects/ports.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { ProjectFileServices } from "../formats/project-file-services.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";

export interface IdentityChannel {
  onmessage: ((event: { data: unknown }) => void) | null;
  readonly postMessage: (message: unknown) => void;
  readonly close?: () => void;
}

export interface DocumentIdentityPorts {
  readonly session: { readonly currentDocument: DocumentReader["current"]; readonly stampDocument: LiveDocumentPort["stamp"] };
  readonly location: Pick<DocumentLocation, "home" | "writtenOut" | "markWrittenOut">;
  readonly history: Pick<HistoryOwner, "copyHistory" | "historyDocumentChanged">;
  readonly effects: Pick<NoticePort, "show">;
  readonly desktop: { readonly running: () => boolean };
  readonly ids: Pick<IdSource, "docId"> & { readonly randomHexBytes: (count: number) => string };
  readonly now: () => number;
  readonly logger: { readonly error: (error: unknown) => void };
  readonly channel: (name: string) => IdentityChannel | null;
}

export interface IdentityEntry {
  readonly migrateDocument: ProjectFileServices["migrateDocument"];
  readonly adoptRestoredState: (snapshot: unknown) => ValidatedDocument | null;
}

export interface DocumentIdentityOwner {
  readonly startIdentity: (ports: DocumentIdentityPorts) => () => void;
  readonly documentIdentityPort: IdentityPort;
  readonly noteMergedDocId: (previous: unknown) => void;
  readonly copyDocHistorySafe: (from: unknown, to: unknown) => void;
  readonly syncDocIdentity: () => void;
  readonly reassignDocId: (toId: unknown, options?: unknown) => boolean;
  readonly initDocIdentityChannel: (factory?: unknown) => IdentityChannel | null;
  readonly docIdEvents: () => { type: string; from: string; to: string }[];
}
