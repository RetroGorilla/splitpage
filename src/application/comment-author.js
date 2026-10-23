import { cleanAuthorName } from "../core/document/people.ts";

export function getSavedAuthorName(preferences) {
  return cleanAuthorName(preferences.commentAuthor());
}

export function saveAuthorName(preferences, name) {
  preferences.rememberCommentAuthor(cleanAuthorName(name));
}
