import { DOCUMENT_GUARD_PARAM } from "../../application/identity/document-guard.ts";

export function documentGuardAsked(search: string): boolean {
  return new URLSearchParams(search).get(DOCUMENT_GUARD_PARAM) === "1";
}
