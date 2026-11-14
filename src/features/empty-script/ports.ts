import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";

export type EmptyScriptCreated = { readonly ok: true; readonly rowId: string } | { readonly ok: false; readonly reason: string };
export type EmptyScriptHold = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly reason: string };

export interface EmptyScriptPorts extends Pick<BufferedFieldPorts, "report"> {
  readonly host: HTMLElement;
  readonly document: Pick<DocumentReader, "current" | "onChange">;
  readonly lifetime: Pick<SharedDocumentSession, "epoch" | "beforeCommand">;
  readonly edits: Pick<DocumentEdits, "allowed">;
  readonly hold: () => EmptyScriptHold;
  readonly create: (text: string) => EmptyScriptCreated;
  readonly place: (rowId: string, offset: number) => boolean;
}
