import type { OperationContext } from "../session/operation.ts";
import type { DraftOwnershipPort } from "./ports.ts";

function onServer(destination: unknown): boolean {
  return typeof destination === "object" && destination !== null &&
    (destination as { readonly kind?: unknown }).kind === "server";
}

export function restoreOwnership(ownership: DraftOwnershipPort): DraftOwnershipPort {
  return Object.freeze({
    capture: ownership.capture,
    stillOwns: function (ctx: OperationContext): boolean {
      if (ownership.stillOwns(ctx)) return true;
      if (onServer(ctx.destination)) return false;
      const now = ownership.capture();
      return now.epoch === ctx.epoch && now.docId === ctx.docId && now.destination === ctx.destination;
    }
  });
}
