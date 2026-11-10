export interface SharedDocumentHandle { readonly sharedDocumentHandle: unique symbol }
export type SharedTransactionOrigin = "local-command" | "local-undo" | "hydration" | "remote";
export type SharedApplyResult = { readonly ok: true } | { readonly ok: false; readonly reason: "invalid-update" };
