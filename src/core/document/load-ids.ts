import { sha256Hex } from "./ids.ts";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + (value as unknown[]).map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function namespaceOf(id: string): string | null {
  return /^(?:r|c|rp|p|bs|r-orphan)-load-([0-9a-f]{24})-[0-9]+(?:-[0-9]+)*$/.exec(id)?.[1] ?? null;
}

export function canShareLoadId(held: string, drawn: string): boolean {
  const repaired = (id: string) => !!namespaceOf(id) || /^(?:r|c|rp|p|bs)-[0-9a-f]{24}(?:-[0-9]+)*$/.test(id);
  return held === drawn || (!repaired(held) && !repaired(drawn));
}

export function createLoadIds(source: () => unknown, reservations: () => Iterable<string>) {
  let reserved: Set<string> | null = null;
  let namespace = "";
  const next = new Map<string, number>();
  function prepare(): Set<string> {
    if (!reserved) {
      // why: A changed source must never recycle a twin's or a displaced reservation's repaired identity.
      namespace = sha256Hex(canonicalJson(source())).slice(0, 24);
      reserved = new Set(reservations());
    }
    return reserved;
  }
  return {
    reserved: prepare,
    id: function (prefix: string): string {
      const taken = prepare();
      let at = next.get(prefix) || 0;
      let id: string;
      do { id = prefix + "-load-" + namespace + "-" + (++at); } while (taken.has(id));
      next.set(prefix, at);
      taken.add(id);
      return id;
    }
  };
}
