import type { ReaderJoinRecord } from "./records.ts";

export function readerJoinGroups(ids: readonly string[], joins: ReadonlyMap<string, ReaderJoinRecord>, removed: ReadonlySet<string>): { root: string; members: string[] }[] {
  const available = new Set(ids), edges = new Map<string, string>();
  for (const id of ids) {
    const into = joins.get(id)?.into;
    if (into !== undefined && available.has(into)) edges.set(id, into);
  }
  const done = new Set<string>();
  for (const start of ids) {
    const path: string[] = [], positions = new Map<string, number>();
    let id: string | undefined = start;
    while (id !== undefined && !done.has(id) && !positions.has(id)) {
      positions.set(id, path.length); path.push(id); id = edges.get(id);
    }
    if (id !== undefined && positions.has(id)) for (const member of path.slice(positions.get(id))) edges.delete(member);
    for (const member of path) done.add(member);
  }
  const affected = new Map<string, boolean>();
  for (const start of ids) {
    const path: string[] = [];
    let id: string | undefined = start;
    while (id !== undefined && !affected.has(id)) { path.push(id); id = edges.get(id); }
    let removal = id !== undefined && affected.get(id) === true;
    for (const member of path.reverse()) { removal ||= removed.has(member); affected.set(member, removal); }
  }
  for (const [id, parent] of edges) if (removed.has(id) && !affected.get(parent)) edges.delete(id);
  const children = new Map<string, string[]>();
  for (const id of ids) {
    const parent = edges.get(id);
    if (parent !== undefined) { const list = children.get(parent) ?? []; list.push(id); children.set(parent, list); }
  }
  return ids.filter(id => !edges.has(id)).map(root => {
    const members: string[] = [], stack = [root];
    while (stack.length) {
      const id = stack.pop(); if (id === undefined) continue;
      members.push(id); for (const child of [...children.get(id) ?? []].reverse()) stack.push(child);
    }
    return { root, members };
  });
}
