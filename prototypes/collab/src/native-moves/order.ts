export interface OrderBlock { ref: string; kind: "b" | "h"; segment: string; start: number }
export interface Placement { a: string | null; n: number; u: string | null }
export interface Arrangement {
  order: string[];
  parent: Map<string, string | null>;
  placed: Map<string, Placement>;
  leader: Map<string, string>;
}

export function placementOf(value: unknown): Placement | null {
  if (!value || typeof value !== "object") return null;
  const { a, n, u } = value as Record<string, unknown>;
  if (typeof n !== "number" || (a !== null && typeof a !== "string") || (u !== null && typeof u !== "string")) return null;
  return { a, n, u };
}

export const blockRef = (kind: "b" | "h", id: string): string => `${kind}:${id}`;

function newer(left: [string, Placement], right: [string, Placement]): number {
  return right[1].n - left[1].n || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

// why: a moved block keeps its text where it was typed; it is shown after its anchor, and blocks split off it that its
// mover had not seen (between it and the block that followed it then) go with it, up to the first unmoved heading
function followersOf(natural: readonly OrderBlock[], placed: ReadonlyMap<string, Placement>, at: ReadonlyMap<string, OrderBlock>): Map<string, string> {
  const leader = new Map<string, string>();
  let segment: string | null = null, stack: { ref: string; until: number }[] = [];
  for (const block of natural) {
    if (block.segment !== segment) { segment = block.segment; stack = []; }
    while (stack.length && block.start >= (stack.at(-1)?.until ?? 0)) stack.pop();
    const place = placed.get(block.ref);
    if (place) {
      const until = place.u === null ? Number.POSITIVE_INFINITY : at.get(place.u);
      stack.push({ ref: block.ref, until: typeof until === "number" ? until : until && until.segment === segment && until.start > block.start ? until.start : block.start });
    } else if (block.kind === "h") stack = [];
    else if (stack.length) leader.set(block.ref, stack.at(-1)?.ref ?? "");
  }
  return leader;
}

function parentOf(ref: string, placed: ReadonlyMap<string, Placement>, leader: ReadonlyMap<string, string>): string | null | undefined {
  const place = placed.get(ref);
  if (place) return place.a;
  return leader.get(ref);
}

// why: two moves made at once can each anchor a block after the other; the older of the moves in such a loop is
// read as not made, so every block still has exactly one place and every copy picks the same one
function breakLoops(natural: readonly OrderBlock[], placed: Map<string, Placement>, at: ReadonlyMap<string, OrderBlock>): Map<string, string> {
  for (;;) {
    const leader = followersOf(natural, placed, at), state = new Map<string, 1 | 2>();
    let loop: string[] | null = null;
    for (const start of placed.keys()) {
      const path: string[] = [];
      let current: string | null | undefined = start;
      while (typeof current === "string" && !state.has(current)) { state.set(current, 1); path.push(current); current = parentOf(current, placed, leader); }
      if (typeof current === "string" && state.get(current) === 1) loop = path.slice(path.indexOf(current));
      for (const ref of path) state.set(ref, 2);
      if (loop) break;
    }
    if (!loop) return leader;
    const members = loop.flatMap(ref => { const place = placed.get(ref); return place ? [[ref, place] as [string, Placement]] : []; });
    const oldest = members.sort(newer).at(-1);
    if (!oldest) throw new Error("A loop of placements holds no placed block");
    placed.delete(oldest[0]);
  }
}

export function arrange(natural: readonly OrderBlock[], placeOf: (ref: string) => Placement | null): Arrangement {
  const at = new Map(natural.map(block => [block.ref, block])), placed = new Map<string, Placement>();
  for (const block of natural) {
    const place = placeOf(block.ref);
    if (place && place.a !== block.ref && (place.a === null || at.has(place.a))) placed.set(block.ref, place);
  }
  if (!placed.size) return { order: natural.map(block => block.ref), parent: new Map(), placed, leader: new Map() };
  const leader = breakLoops(natural, placed, at);
  const children = new Map<string | null, [string, Placement][]>(), trailing = new Map<string, string[]>(), parent = new Map<string, string | null>();
  for (const [ref, place] of placed) {
    children.set(place.a, [...(children.get(place.a) ?? []), [ref, place]]);
    parent.set(ref, place.a);
  }
  for (const list of children.values()) list.sort(newer);
  const chain: string[] = [];
  for (const block of natural) {
    const head = leader.get(block.ref);
    if (placed.has(block.ref)) continue;
    if (head === undefined) chain.push(block.ref);
    else { trailing.set(head, [...(trailing.get(head) ?? []), block.ref]); parent.set(block.ref, head); }
  }
  const order: string[] = [], pending: string[] = [];
  const queue = (refs: readonly string[]): void => { for (let index = refs.length - 1; index >= 0; index--) pending.push(refs[index] ?? ""); };
  queue([...(children.get(null) ?? []).map(([ref]) => ref), ...chain]);
  while (pending.length) {
    const ref = pending.pop() ?? "";
    order.push(ref);
    queue([...(children.get(ref) ?? []).map(([child]) => child), ...(trailing.get(ref) ?? [])]);
  }
  if (order.length !== natural.length) throw new Error(`Arranged ${order.length} of ${natural.length} blocks`);
  return { order, parent, placed, leader };
}
