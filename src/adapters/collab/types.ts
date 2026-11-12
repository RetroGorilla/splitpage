export interface SharedDocumentHandle { readonly sharedDocumentHandle: unique symbol }
export type SharedTransactionOrigin = "local-command" | "local-undo" | "hydration" | "remote" | "cleanup";
// why: ok says the update is valid, not that it is applied: it may be held until the current notifications finish.
export type SharedApplyResult = { readonly ok: true } | { readonly ok: false; readonly reason: "invalid-update" | "queue-full" };
