import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { CommandOutcome } from "../../application/session/document-session.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { SharedRecoveryName } from "../../core/collab/operations.ts";

export interface RecoveryPanelPorts {
  readonly host: HTMLElement;
  readonly session: {
    readonly current: () => Pick<SharedDocumentSession, "recovery" | "subscribe"> | null;
    readonly onChange: (listener: () => void) => () => void;
  };
  readonly document: Pick<DocumentReader, "current">;
  readonly text: Pick<TextServices, "htmlToPlainText">;
  readonly reply: (key: string) => Readonly<Record<string, unknown>> | null;
  readonly restore: (entry: SharedRecoveryName) => CommandOutcome;
  readonly discard: (entry: SharedRecoveryName) => CommandOutcome;
  readonly notices: Pick<NoticePort, "show">;
}

export interface RecoveryPanelControl {
  readonly open: () => void;
  readonly dispose: () => void;
}
