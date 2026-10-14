export type AuthorityKind = "none" | "owner" | "scoped-editor" | "reviewer";

export interface ConnectionFacts {
  readonly token: string;
  readonly role: string;
  readonly scope: string;
}

export interface Authority {
  readonly kind: AuthorityKind;
  readonly scope: string;
}

export type EditCapability =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export const REVIEW_REFUSAL_REASON = "review";

const NONE: Authority = Object.freeze({ kind: "none", scope: "" });

export function authorityOf(facts: ConnectionFacts | null | undefined): Authority {
  if (!facts) return NONE;
  const scope = facts.scope || "";
  if (facts.role === "review") return { kind: "reviewer", scope };
  if (scope) return { kind: "scoped-editor", scope };
  if (facts.token) return { kind: "owner", scope: "" };
  return NONE;
}

export function isReviewer(authority: Authority): boolean {
  return authority.kind === "reviewer";
}

export function isLinkGuest(authority: Authority): boolean {
  return authority.scope !== "";
}

export function isOwner(authority: Authority): boolean {
  return authority.kind === "owner";
}

export function editCapability(authority: Authority): EditCapability {
  return isReviewer(authority) ? { allowed: false, reason: REVIEW_REFUSAL_REASON } : { allowed: true };
}
