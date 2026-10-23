import type { Command, CommandOutcome } from "./document-session.ts";
import type { CellTextPorts, StampPorts } from "./ports.ts";

export interface DocumentEdits {
  readonly run: (command: Command) => CommandOutcome;
  readonly edit: (command: Command) => boolean;
  readonly allowed: () => boolean;
  readonly stamps: StampPorts;
  readonly text: CellTextPorts;
}
