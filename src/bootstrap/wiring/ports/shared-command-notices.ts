import type { NoticePort } from "../../../application/effects/ports.ts";
import type { SharedSessionPorts } from "../../../application/session/shared-session.ts";
import type { SharedCommandGuard } from "../../../application/session/document-edits.ts";
import type { BufferedFieldPorts } from "../../../application/editing/buffered-field.ts";
import { SHARED_SESSION_DISABLED } from "../../../application/session/ports.ts";

export function sharedCommandRefusalNotice(notices: Pick<NoticePort, "show">): NonNullable<SharedSessionPorts["refused"]> {
  return reason => {
    notices.show(reason === SHARED_SESSION_DISABLED.moves ? reason : "This is not available in a shared session yet.", "warn");
  };
}

export function sharedCommandReport(notices: Pick<NoticePort, "show">, report: BufferedFieldPorts["report"]): BufferedFieldPorts["report"] {
  const refuse = sharedCommandRefusalNotice(notices);
  return outcome => {
    if (outcome.kind !== "rejected") { report(outcome); return; }
    if (!outcome.notified) refuse(outcome.reason);
  };
}

export function sharedCommandGuard(shared: () => boolean, notices: Pick<NoticePort, "show">): SharedCommandGuard {
  const refuse = sharedCommandRefusalNotice(notices);
  return { refuseUnsupported: () => {
    if (!shared()) return false;
    refuse("not shared");
    return true;
  } };
}
