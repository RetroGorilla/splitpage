import type { StateField } from "../document/fields.ts";

type Bag = Record<string, unknown>;

function isObject(v: unknown): v is Bag {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function objectsOf(v: unknown): Bag[] {
  return Array.isArray(v) ? (v as unknown[]).filter(isObject) : [];
}

function shallowCopy(item: Bag): Bag {
  const out: Bag = {};
  Object.keys(item).forEach(function (k) {
    Object.defineProperty(out, k, { value: item[k], enumerable: true, writable: true, configurable: true });
  });
  return out;
}

function cleanList(v: unknown, inner?: (x: Bag) => Bag): unknown {
  if (v == null) return v;
  const items = objectsOf(v);
  return inner ? items.map(inner) : items;
}

function withLists(item: Bag, keys: readonly string[], inner?: (x: Bag) => Bag): Bag {
  if (!keys.some(function (k) { return Object.prototype.hasOwnProperty.call(item, k); })) return item;
  const out = shallowCopy(item);
  keys.forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(item, k)) out[k] = cleanList(item[k], inner);
  });
  return out;
}

function galleryItem(it: Bag): Bag { return withLists(it, ["links"]); }
function row(r: Bag): Bag { return withLists(withLists(r, ["imageLinks"]), ["moreImages"], galleryItem); }
function comment(c: Bag): Bag { return withLists(c, ["replies"]); }

export function listShapedSide<T extends object>(doc: T, fields: readonly StateField[]): T {
  const d = doc as unknown as Bag;
  const out = shallowCopy(d);
  out.rows = objectsOf(d.rows).map(row);
  out.comments = objectsOf(d.comments).map(comment);
  const lists = ["productionTags"].concat(fields.filter(function (f) { return f.merge === "list-union-with-base"; }).map(function (f) { return f.key; }));
  lists.forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = cleanList(d[k]);
  });
  return out as unknown as T;
}
