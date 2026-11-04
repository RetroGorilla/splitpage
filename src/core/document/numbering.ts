import { sceneGroups } from "./scenes.ts";
import type { DocumentScene, SceneDocument } from "./scenes.ts";

export interface NumberedScene {
  readonly id: string | null;
  readonly letter: string;
  readonly name: string;
  readonly header: DocumentScene | null;
  readonly start: number;
  readonly end: number;
}

export interface BeatNumber {
  readonly scene: NumberedScene;
  readonly number: number;
  readonly full: string;
  readonly short: string;
}

export interface DocumentNumbering {
  readonly scenes: readonly NumberedScene[];
  readonly beats: Readonly<Record<string, BeatNumber>>;
  readonly shot: (rowId: string | null, ordinal: number) => { readonly full: string; readonly short: string } | null;
}

export function deriveDocumentNumbering(doc: SceneDocument): DocumentNumbering {
  const groups = sceneGroups(doc);
  const scenes: NumberedScene[] = [];
  const beats: Record<string, BeatNumber> = Object.create(null);
  const starts = new Map(groups.map(group => [group.start, group]));
  let scene: NumberedScene | null = null;
  let number = 0;
  doc.rows.forEach((row, index) => {
    const group = starts.get(index);
    if (!scene || group) {
      let n = scenes.length + 1;
      let letter = "";
      while (n > 0) {
        n--;
        letter = String.fromCharCode(65 + n % 26) + letter;
        n = Math.floor(n / 26);
      }
      scene = {
        id: group?.scene.id ?? null, letter, name: group?.scene.name ?? "",
        header: group?.scene ?? null, start: index, end: group?.end ?? groups[0]?.start ?? doc.rows.length
      };
      scenes.push(scene);
      number = 0;
    }
    number++;
    beats[row.id] = { scene, number, full: scene.letter + "." + number, short: String(number) };
  });
  return {
    scenes, beats,
    shot(rowId, ordinal) {
      const beat = rowId === null ? undefined : beats[rowId];
      return beat && Number.isInteger(ordinal) && ordinal >= 0
        ? { full: beat.full + "." + (ordinal + 1), short: beat.short + "." + (ordinal + 1) } : null;
    }
  };
}
