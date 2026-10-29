export interface KeyChord {
  readonly key: string;
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export interface KeyInput {
  readonly key?: string | undefined;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

export interface KeyedAction {
  readonly id: string;
  readonly keys: readonly string[];
  readonly claim: boolean;
}

export interface ChordReader {
  readonly chordKey: (text: string) => string;
  readonly actionForKey: (actions: readonly KeyedAction[], input: KeyInput) => KeyedAction | null;
}

const MODIFIERS: readonly string[] = Object.freeze(["mod", "shift", "alt"]);
const FUNCTION_KEY = /^f([1-9]|1[0-9]|2[0-4])$/i;

export function parseChord(text: string): KeyChord {
  const parts = text.split("+").map((p) => p.trim()).filter((p) => p !== "");
  const key = parts.pop();
  if (key === undefined || MODIFIERS.includes(key.toLowerCase())) throw new Error(`shortcut ${JSON.stringify(text)} names no key`);
  const unknown = parts.filter((p) => !MODIFIERS.includes(p.toLowerCase()));
  if (unknown.length) throw new Error(`shortcut ${JSON.stringify(text)} has unknown modifiers ${unknown.join(", ")}`);
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const chord = { key: key.toLowerCase(), mod: mods.has("mod"), shift: mods.has("shift"), alt: mods.has("alt") };
  if (!chord.mod && !chord.alt && !FUNCTION_KEY.test(chord.key)) throw new Error(`shortcut ${JSON.stringify(text)} needs mod or alt, or a function key`);
  return chord;
}

export function canBeShortcut(input: KeyInput): boolean {
  if (input.ctrlKey || input.metaKey || input.altKey) return true;
  return typeof input.key === "string" && FUNCTION_KEY.test(input.key);
}


export function chordMatches(chord: KeyChord, input: KeyInput): boolean {
  if (input.isComposing) return false;
  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  const mod = input.ctrlKey || input.metaKey;
  return key !== "" && mod === chord.mod && input.altKey === chord.alt && input.shiftKey === chord.shift && key === chord.key;
}

export function createChordReader(): ChordReader {
  const parsed = new Map<string, KeyChord>();
  const chordFor = (text: string): KeyChord => {
    let chord = parsed.get(text);
    if (!chord) {
      chord = parseChord(text);
      parsed.set(text, chord);
    }
    return chord;
  };
  return {
    chordKey(text) {
      const chord = chordFor(text);
      return [chord.mod ? "mod" : "", chord.alt ? "alt" : "", chord.shift ? "shift" : "", chord.key].filter((p) => p !== "").join("+");
    },
    actionForKey(actions, input) {
      for (const action of actions) {
        if (action.keys.some((k) => chordMatches(chordFor(k), input))) return action;
      }
      return null;
    }
  };
}
