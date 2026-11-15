import type { Run } from "../../../src/core/text/runs.ts";
import { caretAfterStep } from "../../../src/features/undo/caret.ts";

export function standaloneCaretOffset(before: readonly Run[], after: readonly Run[]): number | null {
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return caretAfterStep(value => value as readonly Run[], { before, after });
}

export function markRuns(characters: readonly { readonly value: string; readonly marks: readonly (readonly [string, unknown])[] }[]): Run[] {
  return characters.map(character => ({ text: character.value, marks: Object.fromEntries(character.marks) }) as Run);
}
