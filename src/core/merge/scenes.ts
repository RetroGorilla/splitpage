import { normalizeScenes, sceneGroups } from "../document/scenes.ts";
import type { DocumentScene, SceneDocument } from "../document/scenes.ts";

function identities(base: SceneDocument | null | undefined, mine: SceneDocument, theirs: SceneDocument): Map<string, string> {
  const b = new Map((normalizeScenes(base?.sections) ?? []).map(scene => [scene.id, scene]));
  const m = new Map((normalizeScenes(mine.sections) ?? []).map(scene => [scene.id, scene]));
  const t = new Map((normalizeScenes(theirs.sections) ?? []).map(scene => [scene.id, scene]));
  const merged = new Map<string, string>();
  for (const id of new Set([...t.keys(), ...m.keys()])) {
    const bs = b.get(id), ms = m.get(id), ts = t.get(id);
    if (!ms && bs && ts?.name === bs.name) continue;
    if (!ts && bs && ms?.name === bs.name) continue;
    const name = ms && ts ? bs && ts.name === bs.name ? ms.name : ts.name : (ms ?? ts)?.name;
    if (name) merged.set(id, name);
  }
  return merged;
}

function membership(doc: SceneDocument): Map<string, string> {
  const out = new Map(doc.rows.map(row => [row.id, ""]));
  for (const group of sceneGroups(doc)) {
    for (let i = group.start; i < group.end; i++) {
      const row = doc.rows[i];
      if (row) out.set(row.id, group.scene.id);
    }
  }
  return out;
}

function mergeOrder(base: readonly string[], mine: readonly string[], theirs: readonly string[], all: readonly string[]): string[] {
  const allowed = new Set(all), b = new Set(base), m = new Set(mine), t = new Set(theirs);
  const common = (ids: readonly string[]): string => ids.filter(id => b.has(id) && m.has(id) && t.has(id)).join("\n");
  const preferred = common(theirs) === common(base) && common(mine) !== common(base) ? mine : theirs;
  const additions = preferred === mine ? theirs : mine;
  const ordered = preferred.filter(id => allowed.has(id));
  const placed = new Set(ordered);
  for (const source of [additions, all]) {
    source.forEach((id, i) => {
      if (!allowed.has(id) || placed.has(id)) return;
      const preceding = source.slice(0, i).reverse().find(item => placed.has(item));
      const following = source.slice(i + 1).find(item => placed.has(item));
      const at = preceding !== undefined ? ordered.indexOf(preceding) + 1 : following !== undefined ? ordered.indexOf(following) : ordered.length;
      ordered.splice(at, 0, id);
      placed.add(id);
    });
  }
  return ordered;
}

export function mergeSceneLayout<T extends { readonly id: string }>(
  base: SceneDocument | null | undefined, mine: SceneDocument, theirs: SceneDocument, rows: T[]
): { rows: T[]; sections: DocumentScene[] | undefined } {
  if (!(base?.sections || mine.sections || theirs.sections)) return { rows, sections: undefined };
  const empty: SceneDocument = { rows: [] };
  const original = base ?? empty;
  const names = identities(base, mine, theirs);
  const sceneIds = (doc: SceneDocument): string[] => sceneGroups(doc).map(group => group.scene.id);
  const baseOrder = sceneIds(original), mineOrder = sceneIds(mine), theirOrder = sceneIds(theirs);
  const order = mergeOrder(baseOrder, mineOrder, theirOrder, [...names.keys()]);
  const b = membership(original), m = membership(mine), t = membership(theirs);
  const mineGroups = new Map(m), theirGroups = new Map(t);
  for (const [members, ids] of [[m, mineOrder], [t, theirOrder]] as const) {
    for (const [rowId, sceneId] of b) {
      if (!sceneId || ids.includes(sceneId) || !members.has(rowId)) continue;
      const preceding = baseOrder.slice(0, baseOrder.indexOf(sceneId)).reverse().find(id => ids.includes(id)) ?? "";
      if (members.get(rowId) === preceding) members.set(rowId, sceneId);
    }
  }
  if (!base && !mineOrder.length && theirOrder.length) m.clear();
  if (!base && !theirOrder.length && mineOrder.length) t.clear();
  const assignments = rows.map(row => {
    const bm = b.get(row.id), mm = m.get(row.id), tm = t.get(row.id);
    const preferMine = tm === undefined || (mm !== undefined && tm === bm);
    let id = (preferMine ? mm : tm) ?? "";
    if (id && !names.has(id)) {
      const observedMine = mineGroups.get(row.id), observedTheirs = theirGroups.get(row.id);
      id = (observedTheirs === undefined || (observedMine !== undefined && observedTheirs === bm) ? observedMine : observedTheirs) ?? "";
    }
    return { row, id, sideOrder: preferMine ? mineOrder : theirOrder };
  });
  const populated = new Set(assignments.filter(item => names.has(item.id)).map(item => item.id));
  const survivingGroup = (id: string, sideOrder: readonly string[]): string => {
    if (!id || populated.has(id)) return id;
    const source = baseOrder.includes(id) ? baseOrder : sideOrder;
    const before = source.slice(0, source.indexOf(id));
    return before.reverse().find(item => populated.has(item)) ?? "";
  };
  const bucket = new Map<string, T[]>();
  for (const assignment of assignments) {
    const { row } = assignment;
    const id = survivingGroup(assignment.id, assignment.sideOrder);
    const group = bucket.get(id) ?? [];
    group.push(row);
    bucket.set(id, group);
  }
  const ordered: T[] = [], scenes: DocumentScene[] = [];
  const canonicalGroups = ["", ...baseOrder];
  const rank = new Map(canonicalGroups.map((id, i) => [id, i]));
  for (const side of [mine, theirs]) {
    for (const group of sceneGroups(side)) {
      if (rank.has(group.scene.id)) continue;
      const neighbour = side.rows.slice(0, group.start + 1).reverse().find(row => b.has(row.id));
      rank.set(group.scene.id, rank.get(neighbour ? b.get(neighbour.id) ?? "" : "") ?? 0);
    }
  }
  for (const id of ["", ...order]) {
    const group = bucket.get(id);
    if (!group?.length) continue;
    const byId = new Map(group.map(row => [row.id, row]));
    const ids = (doc: SceneDocument, members: ReadonlyMap<string, string>): string[] =>
      doc.rows.filter(row => byId.has(row.id))
        .sort((a, z) => (rank.get(members.get(a.id) ?? "") ?? 0) - (rank.get(members.get(z.id) ?? "") ?? 0))
        .map(row => row.id);
    const groupOrder = mergeOrder(ids(original, b), ids(mine, mineGroups), ids(theirs, theirGroups), group.map(row => row.id));
    for (const rowId of groupOrder) {
      const row = byId.get(rowId);
      if (row) ordered.push(row);
    }
    const firstSceneId = groupOrder[0], name = names.get(id);
    if (id && name && firstSceneId) scenes.push({ id, name, firstSceneId });
  }
  return { rows: ordered, sections: scenes.length ? scenes : undefined };
}
