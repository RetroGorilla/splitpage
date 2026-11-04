import type { SceneView } from "../../application/editing/scene-view.ts";
import type { ShotHiding, ShotRow, ShotRowEntry, ShotStrip } from "../../application/shot-hiding.ts";
import { deriveDocumentNumbering } from "../../core/document/numbering.ts";
import type { DocumentNumbering } from "../../core/document/numbering.ts";
import type { DocumentScene, SceneDocument } from "../../core/document/scenes.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";

export interface SceneDivider {
  readonly scene: DocumentScene;
  readonly count: number;
  readonly folded: boolean;
  readonly letter?: string;
  readonly automatic?: boolean;
}

export type SceneRowEntry<R extends ShotRow> = ShotRowEntry<R> | ShotStrip | SceneDivider;

export function sceneRowEntries<R extends ShotRow>(doc: Pick<SceneDocument, "sections"> & { readonly rows: readonly R[] }, hiding: Pick<ShotHiding, "groups">, view: Pick<SceneView, "folded">, numbering: DocumentNumbering = deriveDocumentNumbering(doc)): SceneRowEntry<R>[] {
  const groups = numbering.scenes;
  const entries: SceneRowEntry<R>[] = [];
  const beats = (from: number, to: number): void => {
    for (const item of hiding.groups(doc.rows.slice(from, to))) {
      entries.push("strip" in item ? item : { ...item, index: item.index + from });
    }
  };
  for (const group of groups) {
    const folded = group.id !== null && view.folded(group.id);
    const scene = group.header ?? { id: "", name: "", firstSceneId: doc.rows[group.start]?.id ?? "" };
    entries.push({ scene, count: group.end - group.start, folded, letter: group.letter, automatic: group.id === null });
    if (!folded) beats(group.start, group.end);
  }
  return entries;
}

export function sceneHeaderHtml(entry: SceneDivider, readOnly = false, total = ""): string {
  const id = escapeHtml(entry.scene.id);
  const name = escapeHtml(entry.scene.name);
  const label = escapeHtml(entry.letter ?? "");
  const disabled = readOnly ? " disabled" : "";
  if (entry.automatic) return '<header class="section-header" data-section-id=""><span role="heading" aria-level="2">' + label + '</span>' +
    '<button type="button" class="section-name section-name-empty" data-section-action="name-automatic"' + disabled + '>Add a name</button>' +
    '<span class="section-stats">' + entry.count + ' beat' + (entry.count === 1 ? '' : 's') + '</span></header>';
  return '<header class="section-header" data-section-id="' + id + '">' +
    '<button type="button" class="section-grip" draggable="true" aria-label="Drag scene ' + name + '"' + disabled + '>⠿</button>' +
    '<button type="button" class="section-fold" data-section-action="fold" aria-expanded="' + !entry.folded + '" aria-label="' +
      (entry.folded ? 'Expand ' : 'Fold ') + name + '">' + (entry.folded ? '▸' : '▾') + '</button>' +
    '<span role="heading" aria-level="2"><span class="section-letter">' + label + '</span> <button type="button" class="section-name" data-section-action="rename"' + disabled + '>' + name + '</button></span>' +
    '<span class="section-stats">' + entry.count + ' beat' + (entry.count === 1 ? '' : 's') + ' · <span data-section-total="' + id + '">' + escapeHtml(total) + '</span></span>' +
    '<span class="section-hint" aria-hidden="true" hidden></span>' +
    '<details class="section-more"><summary aria-label="Scene menu for ' + name + '">⋯</summary><div class="section-menu">' +
    '<button type="button" data-section-action="rename"' + disabled + '>Rename</button>' +
    '<button type="button" data-section-action="up"' + disabled + '>Move scene ↑</button>' +
    '<button type="button" data-section-action="down"' + disabled + '>Move scene ↓</button>' +
    '<button type="button" data-section-action="remove"' + disabled + '>Remove scene header</button>' +
    '</div></details></header>';
}
