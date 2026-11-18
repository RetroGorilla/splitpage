import * as Y from "yjs";

export interface Seen { readonly token: string; readonly id: string; readonly at: number; readonly units: number }
export interface LedgerStep { readonly actor: string; readonly inserted: readonly string[]; readonly deleted: readonly string[] }
export interface UndoForecast { readonly deletes: readonly string[]; readonly restores: readonly string[] }
export interface OrderBreak { readonly message: string; readonly restored: boolean }
export interface LedgerFindings { readonly identity: string[]; readonly order: OrderBreak[]; readonly liveOrder: OrderBreak[] }
export type EdgeSource = "command" | "screen" | "commit";

interface Node { readonly token: string; id: string | null; dead: boolean; readonly restored: boolean }

export const tokenOf = (insert: unknown): string => typeof insert === "string" ? insert : JSON.stringify(insert);

export function label(token: string): string {
  return Array.from(token).map(part => {
    const code = part.codePointAt(0) ?? 0;
    return code >= 0x20 && code < 0x7f ? part : `U+${code.toString(16).toUpperCase()}`;
  }).join("");
}

export function view(text: Y.Text): Seen[] {
  const seen: Seen[] = [];
  let at = 0;
  for (const step of text.toDelta() as { insert: unknown }[]) {
    const parts = typeof step.insert === "string" ? Array.from(step.insert) : [tokenOf(step.insert)];
    for (const part of parts) {
      const units = typeof step.insert === "string" ? part.length : 1;
      const item = Y.createRelativePositionFromTypeIndex(text, at).item;
      if (item === null) throw new Error("token without an item");
      seen.push({ token: part, id: `${item.client}:${item.clock}`, at, units });
      at += units;
    }
  }
  return seen;
}

export function malformed(tokens: readonly string[]): string[] {
  return tokens.filter(token => token === "�" || (token.length === 1 && token.charCodeAt(0) >= 0xd800 && token.charCodeAt(0) <= 0xdfff)).map(token => `malformed unit ${label(token)}`);
}

const count = (tokens: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
};

// why: every expected instance is recorded from a command or an undo forecast before the write runs; Yjs ids are bound
// afterwards only as labels, so an instance the write never produced stays expected and is reported missing
export class Ledger {
  private readonly nodes = new Map<string, Node>();
  private readonly byId = new Map<string, string>();
  private readonly full = new Map<string, Set<string>>();
  private readonly live = new Map<string, Set<string>>();

  add(key: string, token: string, restored = false): void {
    if (this.nodes.has(key)) throw new Error(`instance ${key} recorded twice`);
    this.nodes.set(key, { token, id: null, dead: false, restored });
  }

  bind(key: string, id: string): void {
    this.node(key).id = id;
    this.byId.set(id, key);
  }

  bindSeen(seen: readonly Seen[], keys: readonly string[]): string[] {
    const unbound: string[] = [];
    for (const key of keys) {
      const match = seen.find(item => item.token === this.token(key) && !this.byId.has(item.id));
      if (match === undefined || this.idOf(key) !== null) unbound.push(key); else this.bind(key, match.id);
    }
    return unbound;
  }

  has(key: string): boolean {
    return this.nodes.has(key);
  }

  keyOf(id: string): string | undefined {
    return this.byId.get(id);
  }

  idOf(key: string): string | null {
    return this.node(key).id;
  }

  token(key: string): string {
    return this.node(key).token;
  }

  private node(key: string): Node {
    const node = this.nodes.get(key);
    if (node === undefined) throw new Error(`unknown instance ${key}`);
    return node;
  }

  // why: "screen" edges are what the composing person saw, deleted characters included; "commit" edges keep only the
  // screen neighbours still live in the document at commit, which is all an index-based Y.Text write can address
  before(left: string | undefined, right: string | undefined, source: EdgeSource = "command"): void {
    if (left === undefined || right === undefined) return;
    for (const [graph, wanted] of [[this.full, source !== "commit"], [this.live, source !== "screen"]] as const) {
      if (!wanted) continue;
      const set = graph.get(left) ?? new Set<string>();
      set.add(right);
      graph.set(left, set);
    }
  }

  between(left: string | undefined, run: readonly string[], right: string | undefined, source: EdgeSource = "command"): void {
    [left, ...run, right].forEach((key, index, all) => this.before(key, all[index + 1], source));
  }

  kill(key: string): void {
    this.node(key).dead = true;
  }

  // why: Yjs redoes a deleted item, possibly a run of several, between the undoing replica's left neighbour and its
  // tombstone (redoItem, Item.js): the copy follows what that replica held before the run, and precedes the original
  restore(original: string, id: string, held: (id: string) => boolean, run: ReadonlySet<string>): void {
    this.add(id, this.token(original), true);
    for (const graph of [this.full, this.live]) {
      const earlier = new Set<string>(), queue = [original];
      while (queue.length > 0) {
        const next = queue.pop() as string;
        for (const [left, rights] of graph) if (rights.has(next) && !earlier.has(left)) { earlier.add(left); queue.push(left); }
      }
      for (const left of earlier) {
        const leftId = this.nodes.get(left)?.id ?? null;
        if (leftId !== null && held(leftId) && !run.has(left)) graph.set(left, (graph.get(left) ?? new Set<string>()).add(id));
      }
      graph.set(id, (graph.get(id) ?? new Set<string>()).add(original));
    }
  }

  // why: Y.UndoManager pops until a step changes something; a step deletes its insertions still visible, following the
  // copies this replica redid them as, and redoes each deletion not of its own insertion (popStackItem, redoItem)
  forecast(stack: LedgerStep[], visible: ReadonlySet<string>, redone: ReadonlyMap<string, string>): UndoForecast | null {
    const latest = (key: string): string => { let at = key; while (redone.has(at)) at = redone.get(at) as string; return at; };
    while (stack.length > 0) {
      const step = stack.pop() as LedgerStep;
      const deletes = step.inserted.map(latest).filter(key => visible.has(this.idOf(key) ?? ""));
      const again = step.deleted.filter(key => !step.inserted.includes(key));
      const restores = again.filter(key => !redone.has(key));
      if (deletes.length > 0 || again.length > 0) return { deletes, restores };
    }
    return null;
  }

  expectedTokens(): string[] {
    return [...this.nodes.values()].filter(node => !node.dead).map(node => node.token);
  }

  check(final: readonly Seen[]): LedgerFindings {
    const identity: string[] = [];
    const position = new Map<string, number>();
    final.forEach((seen, index) => {
      const key = this.byId.get(seen.id);
      if (key === undefined) { identity.push(`unknown instance ${label(seen.token)}`); return; }
      if (position.has(key)) identity.push(`instance of ${label(seen.token)} shown twice`);
      position.set(key, index);
      if (this.node(key).dead) identity.push(`${label(seen.token)} shown although deleted`);
    });
    for (const [key, node] of this.nodes) {
      if (!node.dead && !position.has(key)) identity.push(`${label(node.token)} missing${node.id === null ? ", never written" : ""}`);
    }
    const expected = count(this.expectedTokens()), actual = count(final.map(seen => seen.token));
    for (const token of new Set([...expected.keys(), ...actual.keys()])) {
      if ((expected.get(token) ?? 0) !== (actual.get(token) ?? 0)) identity.push(`${label(token)} expected ${expected.get(token) ?? 0} times, shown ${actual.get(token) ?? 0}`);
    }
    return { identity, order: this.order(this.full, position), liveOrder: this.order(this.live, position) };
  }

  private order(graph: ReadonlyMap<string, ReadonlySet<string>>, position: ReadonlyMap<string, number>): OrderBreak[] {
    const breaks: OrderBreak[] = [];
    for (const [key, at] of position) {
      const reached = new Set<string>(), queue = [...(graph.get(key) ?? [])];
      while (queue.length > 0) {
        const next = queue.pop() as string;
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(...(graph.get(next) ?? []));
      }
      for (const later of reached) {
        const laterAt = position.get(later);
        if (laterAt !== undefined && laterAt < at) breaks.push({ message: `${label(this.token(key))} must precede ${label(this.token(later))}`, restored: this.node(key).restored || this.node(later).restored });
      }
    }
    return breaks;
  }
}
