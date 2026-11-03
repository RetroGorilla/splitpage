import { cappedText } from "./text-policy.ts";

export interface DocumentScene {
  readonly id: string;
  readonly name: string;
  readonly firstSceneId: string;
}

export interface SceneDocument {
  readonly rows: readonly { readonly id: string }[];
  readonly sections?: unknown;
}

export interface SceneGroup {
  readonly scene: DocumentScene;
  readonly start: number;
  readonly end: number;
}

export function normalizeScenes(value: unknown): DocumentScene[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const anchors = new Set<string>();
  const out: DocumentScene[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" && /^[A-Za-z0-9_-]+$/.test(item.id) ? item.id : "";
    const firstSceneId = typeof item.firstSceneId === "string" ? item.firstSceneId : "";
    const name = cappedText(item.name, 200);
    if (!id || !name || !firstSceneId || ids.has(id) || anchors.has(firstSceneId)) continue;
    ids.add(id);
    anchors.add(firstSceneId);
    out.push({ id, name, firstSceneId });
  }
  return out.length ? out : undefined;
}

export function sceneGroups(doc: SceneDocument): SceneGroup[] {
  const scenes = normalizeScenes(doc.sections);
  if (!scenes) return [];
  const positions = new Map(doc.rows.map((row, i) => [row.id, i]));
  const groups = scenes.flatMap(scene => {
    const start = positions.get(scene.firstSceneId);
    return start === undefined ? [] : [{ scene, start, end: doc.rows.length }];
  }).sort((a, b) => a.start - b.start);
  groups.forEach((group, i) => { group.end = groups[i + 1]?.start ?? doc.rows.length; });
  return groups;
}

export function scenesInOrder(doc: SceneDocument): DocumentScene[] | undefined {
  const scenes = sceneGroups(doc).map(group => group.scene);
  return scenes.length ? scenes : undefined;
}

export function sceneForBeat(doc: SceneDocument, rowId: string): DocumentScene | undefined {
  const at = doc.rows.findIndex(row => row.id === rowId);
  return sceneGroups(doc).find(group => at >= group.start && at < group.end)?.scene;
}

export function sceneBeforeBeat(doc: SceneDocument, rowId: string): DocumentScene | undefined {
  return normalizeScenes(doc.sections)?.find(scene => scene.firstSceneId === rowId);
}

export function scenesAfterRemoval(doc: SceneDocument, removed: ReadonlySet<string>): DocumentScene[] | undefined {
  const scenes = sceneGroups(doc).flatMap(group => {
    const first = doc.rows.slice(group.start, group.end).find(row => !removed.has(row.id));
    return first ? [{ ...group.scene, firstSceneId: first.id }] : [];
  });
  return scenes.length ? scenes : undefined;
}

export function writeScenes(doc: Record<string, unknown>, scenes: readonly DocumentScene[] | undefined): void {
  if (scenes?.length) doc.sections = scenes.map(scene => ({ ...scene }));
  else delete doc.sections;
}
