import type { ActionView } from "./actions.ts";

export interface KeyChord {
  readonly key: string;
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export interface KeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

const MODIFIERS = new Set(["mod", "shift", "alt"]);

export function parseChord(text: string): KeyChord {
  const parts = text.split("+").map((p) => p.trim()).filter((p) => p !== "");
  const key = parts.pop();
  if (key === undefined || MODIFIERS.has(key.toLowerCase())) throw new Error(`shortcut ${JSON.stringify(text)} names no key`);
  const unknown = parts.filter((p) => !MODIFIERS.has(p.toLowerCase()));
  if (unknown.length) throw new Error(`shortcut ${JSON.stringify(text)} has unknown modifiers ${unknown.join(", ")}`);
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { key: key.toLowerCase(), mod: mods.has("mod"), shift: mods.has("shift"), alt: mods.has("alt") };
}

export function chordMatches(chord: KeyChord, input: KeyInput): boolean {
  if (input.isComposing) return false;
  const mod = input.ctrlKey || input.metaKey;
  return mod === chord.mod && input.altKey === chord.alt && input.shiftKey === chord.shift
    && input.key.toLowerCase() === chord.key;
}

export function actionForKey(actions: readonly ActionView[], input: KeyInput): string | null {
  for (const action of actions) {
    if (action.keys.some((k) => chordMatches(parseChord(k), input))) return action.id;
  }
  return null;
}
