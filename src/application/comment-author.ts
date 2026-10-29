import { cleanAuthorName } from "../core/document/people.ts";
import type { Preferences } from "./preferences/preferences.ts";

export function getSavedAuthorName(preferences: Pick<Preferences, "commentAuthor">): string {
  return cleanAuthorName(preferences.commentAuthor());
}

export function saveAuthorName(preferences: Pick<Preferences, "rememberCommentAuthor">, name: unknown): void {
  preferences.rememberCommentAuthor(cleanAuthorName(name));
}
