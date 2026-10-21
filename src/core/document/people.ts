import { normalizeEditorName } from "./fields.ts";

export function cleanAuthorName(name: unknown): string {
  return normalizeEditorName(name) || "";
}
