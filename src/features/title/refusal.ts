import type { Refusal } from "../../application/actions.ts";
import type { NoticePort } from "../../application/effects/ports.ts";

export function showRefusal(notices: Pick<NoticePort, "show">, outcome: Refusal | null | undefined): void {
  if (!outcome || outcome.kind !== "unavailable" || !outcome.reason) return;
  const text = outcome.reason;
  notices.show(/[.!?…]$/.test(text) ? text : text + ".", "warn");
}
