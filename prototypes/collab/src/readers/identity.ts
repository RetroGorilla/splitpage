import * as Y from "yjs";

export function wireIdentity(id: string): string {
  return id.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

export function normalizeIdentityTree(value: unknown): unknown {
  if (typeof value === "string") return wireIdentity(value);
  if (Array.isArray(value)) return Array.from(value, normalizeIdentityTree);
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]: [string, unknown]) => [wireIdentity(key), normalizeIdentityTree(entry)]));
  }
  return value;
}

function decodedMap(source: Y.Map<unknown>, copy: Y.Doc): Y.Map<unknown> | null {
  const path: string[] = [];
  let current = source;
  while (current.parent instanceof Y.Map) {
    const parent: Y.Map<unknown> = current.parent;
    const key = [...parent].find(([, value]) => value === current)?.[0];
    if (key === undefined) return null;
    path.unshift(wireIdentity(key)); current = parent;
  }
  const root = [...source.doc?.share ?? []].find(([, value]) => (value as unknown) === current)?.[0];
  if (root === undefined) return null;
  let result: unknown = copy.getMap(wireIdentity(root));
  for (const key of path) result = result instanceof Y.Map ? result.get(key) : null;
  return result instanceof Y.Map ? result : null;
}

export function identityEntries(source: Y.Map<unknown> | null | undefined): [string, unknown][] {
  if (!source) return [];
  const entries: [string, unknown][] = [...source].map(([key, value]) => [wireIdentity(key), value]);
  const keys = [...source._map.keys()].map(wireIdentity);
  if (new Set(keys).size === keys.length) return entries;
  const copy = new Y.Doc();
  try {
    if (!source.doc) return [];
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(source.doc));
    const decoded = decodedMap(source, copy); if (!decoded) return [];
    // why: Colliding UTF-8 keys must use the native decoded Yjs winner while retaining original text identities.
    return [...decoded].flatMap(([key]) => {
      const winner = decoded._map.get(key)?.id;
      const original = [...source._map].find(([, item]) => item.id.client === winner?.client && item.id.clock === winner.clock)?.[0];
      return original === undefined ? [] : [[key, source.get(original)] as [string, unknown]];
    });
  } finally { copy.destroy(); }
}

export function identityGet(source: Y.Map<unknown> | null | undefined, key: string): unknown {
  const id = wireIdentity(key);
  return id.includes("\ufffd") ? identityEntries(source).find(([key]) => key === id)?.[1] : source?.get(id);
}

export function identityHas(source: Y.Map<unknown> | null | undefined, key: string): boolean {
  const id = wireIdentity(key);
  return id.includes("\ufffd") ? identityEntries(source).some(([key]) => key === id) : source?.has(id) ?? false;
}
