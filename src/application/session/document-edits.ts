import type { Command, CommonDocumentSession } from "./document-session.ts";
import type { CellTextPorts, StampPorts } from "./ports.ts";

export interface SharedCommandGuard {
  readonly refuseUnsupported: () => boolean;
}

export interface DocumentEdits {
  readonly run: CommonDocumentSession["run"];
  readonly edit: (command: Command) => boolean;
  readonly allowed: () => boolean;
  readonly stamps: StampPorts;
  readonly text: CellTextPorts;
}
