import { normalizeDocId } from "../../../shared/doc-id-policy.ts";
import { refsIn } from "../../../shared/blob-policy.ts";
import { SCHEMA_VERSION } from "../../core/document/fields.ts";
import type { Home } from "../location/document-location.ts";
import type { DocumentView } from "../session/document-session.ts";

export type DraftOriginKind = "untitled" | "file" | "import";

export interface DraftOrigin {
  kind: DraftOriginKind;
  fileId: unknown;
  fileKind: unknown;
  importName: unknown;
  baseLastModified: unknown;
  baseSize: number | null;
}

export interface DraftPayload {
  seq: number;
  editSeq: number;
  title: string;
  docId: string | null;
  docIdWrittenOut: boolean;
  schema: unknown;
  originKind: DraftOriginKind;
  fileId: unknown;
  fileKind: unknown;
  importName: unknown;
  baseLastModified: unknown;
  baseSize: number | null;
  stateJson: string;
  baseJson: string | null;
}

export interface DraftPayloadInput {
  readonly seq: number;
  readonly editSeq: number;
  readonly doc: DocumentView;
  readonly writtenOut: boolean;
  readonly origin: DraftOrigin;
  readonly stateJson: string;
  readonly baseJson: string | null;
}

export type DraftRefusal = "stop" | "pause" | "retry";

function fieldOf(value: unknown, name: string): unknown {
  const field: unknown = Reflect.get(Object(value), name);
  return field;
}

function untitledOrigin(): DraftOrigin {
  return {
    kind: "untitled", fileId: null, fileKind: null, importName: null,
    baseLastModified: null, baseSize: null
  };
}

export function desktopDraftOrigin(file: Partial<Home> | null, importHome: () => Partial<Home> | null): DraftOrigin {
  const origin = untitledOrigin();
  const handle = file && file["handle"];
  const fileId = (handle && fieldOf(handle, "_desktopId")) || null;
  if (file && fileId) {
    origin.kind = "file";
    origin.fileId = fileId;
    origin.fileKind = file["format"];
    origin.baseLastModified = file["lastModified"] || null;
    return origin;
  }
  const imported = importHome();
  if (imported) {
    origin.kind = "import";
    origin.importName = imported["name"];
    origin.baseLastModified = imported["lastModified"] || null;
    return origin;
  }
  return origin;
}

export function draftOriginSignature(origin: DraftOrigin, doc: DocumentView | null, writtenOut: boolean): string {
  return [
    origin.kind, origin.fileId || "", origin.fileKind || "", origin.importName || "",
    (doc && doc.docId) || "", writtenOut ? "1" : "0"
  ].join("|");
}

export function draftPayloadFor(input: DraftPayloadInput): DraftPayload {
  const origin = input.origin;
  return {
    seq: input.seq,
    editSeq: input.editSeq,
    title: (input.doc.title || ""),
    docId: normalizeDocId(input.doc.docId) || null,
    docIdWrittenOut: input.writtenOut,
    schema: SCHEMA_VERSION,
    originKind: origin.kind,
    fileId: origin.fileId,
    fileKind: origin.fileKind,
    importName: origin.importName,
    baseLastModified: origin.baseLastModified,
    baseSize: origin.baseSize,
    stateJson: input.stateJson,
    baseJson: input.baseJson
  };
}

export function draftRefsFor(doc: DocumentView, base: unknown, sendBase: boolean): string[] {
  const refs: string[] = refsIn(doc);
  if (sendBase && base) {
    refsIn(base).forEach(function (sha: string) { if (refs.indexOf(sha) === -1) refs.push(sha); });
  }
  return refs;
}

export function draftRefusal(code: string): DraftRefusal {
  if (code === "DISCARDED" || code === "NO_TAB") return "stop";
  if (code !== "STALE_SEQ") return "pause";
  return "retry";
}
