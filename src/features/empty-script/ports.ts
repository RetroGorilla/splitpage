import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { CommonDocumentSession } from "../../application/session/document-session.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { NoticePort } from "../../application/effects/ports.ts";

export type EmptyScriptCreated = { readonly ok: true; readonly rowId: string } | { readonly ok: false; readonly reason: string };
export type EmptyScriptHold = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly reason: string };

export interface EmptyScriptPorts {
  readonly host: HTMLElement;
  readonly document: Pick<DocumentReader, "current" | "onChange">;
  readonly lifetime: Pick<CommonDocumentSession, "epoch" | "beforeCommand">;
  readonly edits: Pick<DocumentEdits, "allowed">;
  readonly notices: Pick<NoticePort, "show">;
  readonly hold: () => EmptyScriptHold;
  readonly create: (text: string) => EmptyScriptCreated;
  readonly place: (rowId: string, offset: number) => boolean;
}
