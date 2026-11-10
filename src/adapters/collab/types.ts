export interface SharedDocumentHandle { readonly sharedDocumentHandle: unique symbol }
export type SharedTransactionOrigin = "local-command" | "local-undo" | "hydration" | "remote" | "cleanup";
export type SharedApplyResult = { readonly ok: true } | { readonly ok: false; readonly reason: "invalid-update" };
