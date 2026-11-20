import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { createNativeHeading, removeNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import type { NativeMoveBlock } from "../../../../src/adapters/collab/native/move-commands.ts";
import { isValidNativeRank } from "../../../../src/adapters/collab/native/rank.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, replaceNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { copiesOf, structureScript } from "./structure-harness.ts";

after(() => { dom.window.close(); });

const SEEDS = 40, STEPS = 80, CONTROL_SEEDS = 5;
const ROWS = { R1: "abc", R2: "def", R3: "ghi", R4: "jkl", R5: "mno", R6: "pqr" };
const VISUALS = { R1: "1", R2: "2", R3: "3", R4: "4", R5: "5", R6: "6" };

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

type Write = "Text.insertEmbed" | "Text.insert" | "Text.delete" | "Map.set" | "Map.delete" | "Array.insert";
type Kind = "type" | "delete" | "split" | "join" | "unjoin" | "remove" | "heading-create" | "heading-remove" | "move";
interface Call { readonly command: number; readonly kind: Kind; readonly slot: number; readonly write: Write; readonly blockKey?: string }
interface MutedMoveInfo {
  readonly blockKey: string;
  readonly orderMatches: boolean;
  readonly hasRank: boolean;
  readonly beforeRank: string;
  readonly keptRank: string;
  readonly prevRank: string | null;
  readonly nextRank: string | null;
}
interface Options { readonly mute?: Call; readonly calls?: Call[]; readonly spoil?: boolean; readonly onMutedMove?: (info: MutedMoveInfo) => void }

class LocalCheck extends Error {}

const PATCHED: readonly [object, string, Write][] = [
  [Y.Text.prototype, "insertEmbed", "Text.insertEmbed"],
  [Y.Text.prototype, "insert", "Text.insert"],
  [Y.Text.prototype, "delete", "Text.delete"],
  [Y.Map.prototype, "set", "Map.set"],
  [Y.Map.prototype, "delete", "Map.delete"],
  [Y.Array.prototype, "insert", "Array.insert"]
];

function mapBlockKey(actor: NativeScript, target: unknown): string | undefined {
  if (!(target instanceof Y.Map)) return undefined;
  for (const [id, map] of actor.roots.beats) if (map === target) return "beat:" + id;
  for (const [id, map] of actor.roots.headings) if (map === target) return "heading:" + id;
  return undefined;
}

// why: every public Yjs write is numbered per command so controls can mute one write at a time and check detection
function intercept(command: number, kind: Kind, actor: NativeScript, options: Options): () => void {
  let slot = 0;
  const originals = PATCHED.map(([owner, name, write]) => {
    const table = owner as Record<string, (...args: unknown[]) => unknown>, original = table[name] as (...args: unknown[]) => unknown;
    table[name] = function (this: unknown, ...args: unknown[]): unknown {
      const key = write === "Map.set" && args[0] === "rank" ? mapBlockKey(actor, this) : undefined;
      const call: Call = key === undefined ? { command, kind, slot: slot++, write } : { command, kind, slot: slot++, write, blockKey: key };
      options.calls?.push(call);
      if (options.mute?.command === command && options.mute.slot === call.slot) return undefined;
      return original.apply(this, args);
    };
    return () => { table[name] = original; };
  });
  return () => { for (const restore of originals) restore(); };
}

interface Entry {
  readonly id: string;
  readonly heading: boolean;
  readonly head: string | null;
  readonly name: string;
  readonly narration: string;
  readonly visual: string;
  readonly hasRank: boolean;
  readonly storedRank: string;
  readonly shownRank: string;
  readonly joined: string;
  readonly pieces: readonly string[];
  readonly own: number;
}

function view(script: NativeScript): Entry[] {
  const reader = script.reader, ranked = reader.rankedOrder();
  const names = new Map(reader.outline().flatMap(entry => entry.kind === "heading" ? [[entry.id, entry.name] as const] : []));
  return ranked.map(block => {
    if (block.kind === "heading") {
      const record = script.roots.headings.get(block.id), raw = record?.get("rank");
      return {
        id: block.id, heading: true, head: null, name: names.get(block.id) ?? "", narration: "", visual: "",
        hasRank: record?.has("rank") === true, storedRank: typeof raw === "string" ? raw : "", shownRank: block.rank,
        joined: "", pieces: [], own: -1
      };
    }
    const record = script.roots.beats.get(block.id), raw = record?.get("rank"), joined: unknown = record?.get("joined");
    const places = reader.narrationSpans(block.id), own = reader.beatBoundary(block.id);
    const pieces = places.map(place => (nativeSegmentSpans(script.roots.segments.get(place.segment))?.[place.span]?.items ?? [])
      .map(item => typeof item.insert === "string" ? item.insert : "").join(""));
    return {
      id: block.id, heading: false, head: block.head, name: "", narration: pieces.join(""),
      visual: script.roots.visuals.get(block.id)?.toString() ?? "",
      hasRank: record?.has("rank") === true, storedRank: typeof raw === "string" ? raw : "", shownRank: block.rank,
      joined: joined === undefined ? "" : JSON.stringify(joined), pieces, own: own ? places.indexOf(own) : -1
    };
  });
}

const compared = (entries: readonly Entry[], withRanks: boolean): string => JSON.stringify(entries.map(entry => [
  entry.id, entry.heading, entry.name, entry.narration, entry.visual, entry.joined,
  ...withRanks ? [entry.hasRank, entry.storedRank] : []
]));

function splitCut(row: Entry, offset: number): number {
  let start = 0, caret = -1;
  const starts = row.pieces.map(piece => { const at = start; start += piece.length; return at; });
  for (const [index, piece] of row.pieces.entries()) if (offset <= (starts[index] ?? 0) + piece.length) { caret = index; break; }
  const ownStart = starts[row.own] ?? 0, ownEnd = ownStart + (row.pieces[row.own]?.length ?? 0);
  return caret === row.own ? offset : caret < row.own ? ownStart : ownEnd;
}

function storedLetters(script: NativeScript): string[] {
  return [...script.roots.segments.values()].flatMap(segment => (nativeSegmentSpans(segment) ?? [])
    .flatMap(span => span.items.flatMap(item => typeof item.insert === "string" ? [...item.insert] : [])));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function moveKey(entry: Entry): string {
  return (entry.heading ? "heading:" : "beat:") + entry.id;
}

function moveRef(entry: Entry): NativeMoveBlock {
  return { kind: entry.heading ? "heading" : "beat", id: entry.id };
}

interface MoveCheck {
  readonly ascending: readonly string[];
  readonly pinned: readonly (readonly [string, string])[];
  readonly leadingPinned: readonly string[];
  readonly leftBound: string | null;
  readonly rightBound: string | null;
}

function planMoveCheck(before: readonly Entry[], moving: readonly Entry[], remaining: readonly Entry[], insertAt: number): MoveCheck {
  const ascending: string[] = [], pinned: [string, string][] = [], leadingPinned: string[] = [], movingKeys = new Set(moving.map(moveKey));
  const handled = new Set<string>(movingKeys);
  const left = insertAt > 0 ? remaining[insertAt - 1] ?? null : null;
  let leftBound: string | null = null;
  if (left) {
    if (left.shownRank !== "") {
      leftBound = left.shownRank;
      if (!left.hasRank) { pinned.push([moveKey(left), leftBound]); handled.add(moveKey(left)); }
    } else { ascending.push(moveKey(left)); handled.add(moveKey(left)); }
  }
  for (const entry of moving) ascending.push(moveKey(entry));
  let upper: Entry | null = null;
  for (let stop = insertAt; stop < remaining.length; stop++) {
    const entry = remaining[stop];
    if (!entry) break;
    if (entry.shownRank !== "" && (leftBound === null || entry.shownRank > leftBound)) { upper = entry; break; }
    ascending.push(moveKey(entry));
    handled.add(moveKey(entry));
  }
  const rightBound = upper ? upper.shownRank : null;
  if (upper && rightBound !== null && !upper.hasRank) { pinned.push([moveKey(upper), rightBound]); handled.add(moveKey(upper)); }
  for (let index = 1; index < before.length; index++) {
    const prev = before[index - 1], current = before[index];
    if (!prev || !current || !movingKeys.has(moveKey(prev))) continue;
    const key = moveKey(current);
    if (handled.has(key) || current.hasRank) continue;
    if (current.shownRank !== "") { pinned.push([key, current.shownRank]); handled.add(key); }
    else { leadingPinned.push(key); handled.add(key); }
  }
  return { ascending, pinned, leadingPinned, leftBound, rightBound };
}

function verifyMoveRanks(seed: number, command: number, before: readonly Entry[], got: readonly Entry[], check: MoveCheck): void {
  const byKey = new Map(got.map(entry => [moveKey(entry), entry]));
  const planned = new Set<string>([...check.ascending, ...check.leadingPinned, ...check.pinned.map(([key]) => key)]);
  for (const prev of before) {
    const key = moveKey(prev);
    if (planned.has(key)) continue;
    const entry = byKey.get(key);
    if (!entry || entry.hasRank !== prev.hasRank || entry.storedRank !== prev.storedRank) {
      throw new LocalCheck(`seed ${seed}, command ${command}: uninvolved block ${key} changed rank`);
    }
  }
  for (const [key, rank] of check.pinned) {
    const entry = byKey.get(key);
    if (!entry || !entry.hasRank || entry.storedRank !== rank) {
      throw new LocalCheck(`seed ${seed}, command ${command}: rankless neighbour ${key} was not pinned to ${rank}`);
    }
  }
  for (const key of check.leadingPinned) {
    const entry = byKey.get(key);
    if (!entry || !entry.hasRank || !isValidNativeRank(entry.storedRank)) {
      throw new LocalCheck(`seed ${seed}, command ${command}: leading rankless follower ${key} was not given a valid rank`);
    }
  }
  let previous = check.leftBound;
  for (const key of check.ascending) {
    const entry = byKey.get(key);
    if (!entry || !entry.hasRank || !isValidNativeRank(entry.storedRank)) {
      throw new LocalCheck(`seed ${seed}, command ${command}: ${key} has no valid rank after move`);
    }
    if (previous !== null && !(previous < entry.storedRank)) {
      throw new LocalCheck(`seed ${seed}, command ${command}: ${key} rank ${entry.storedRank} is not after ${previous}`);
    }
    if (check.rightBound !== null && !(entry.storedRank < check.rightBound)) {
      throw new LocalCheck(`seed ${seed}, command ${command}: ${key} rank ${entry.storedRank} is not before ${check.rightBound}`);
    }
    previous = entry.storedRank;
  }
}

interface Counts {
  commands: number; written: number; unchanged: number; refused: number;
  moves: number; tiedMoves: number; ranklessMoves: number; movesWithRankless: number;
  undos: number; redos: number;
  headingCreates: number; headingRemoves: number;
  splits: number; joins: number; unjoins: number; removals: number;
  letters: number; shown: number; twice: number; storedTwice: number; unplaced: number; deleted: number; notDeleted: number; lost: number;
  records: number; shownRows: number; keptRows: number; vanished: number; missingParts: number;
  visualLetters: number; visualStored: number; visualOnHidden: number; multiSegmentBeats: number;
}

const RANK_OR_FLAG: ReadonlySet<Kind> = new Set(["move", "join", "unjoin", "heading-remove"]);

function history(seed: number, options: Options = {}): Counts {
  const chance = random(seed), pick = <T>(list: readonly T[]): T => list[Math.floor(chance() * list.length)] as T;
  const { net, all, undo } = copiesOf(structureScript(ROWS, VISUALS, [{ id: "H0", name: "Scene 0", before: "R4" }]), [2, 3, 4]);
  const counts: Counts = {
    commands: 0, written: 0, unchanged: 0, refused: 0,
    moves: 0, tiedMoves: 0, ranklessMoves: 0, movesWithRankless: 0,
    undos: 0, redos: 0,
    headingCreates: 0, headingRemoves: 0,
    splits: 0, joins: 0, unjoins: 0, removals: 0,
    letters: 0, shown: 0, twice: 0, storedTwice: 0, unplaced: 0, deleted: 0, notDeleted: 0, lost: 0,
    records: 0, shownRows: 0, keptRows: 0, vanished: 0, missingParts: 0,
    visualLetters: 0, visualStored: 0, visualOnHidden: 0, multiSegmentBeats: 0
  };
  const letters = new Set(Object.values(ROWS).join("")), visualLetters = new Set<string>(), deletions = new Map<string, number[]>();
  const records = new Set(Object.keys(ROWS)), removed = new Set<string>(), usedHeadings = new Set(["H0"]);
  const undoKinds = all.map(() => [] as Kind[]), redoKinds = all.map(() => [] as Kind[]);
  let fresh = 0, headingSeq = 1;
  const letter = (base: number): string => String.fromCharCode(base + fresh++);
  const deleting = (gone: string, command: number): void => { deletions.set(gone, [...deletions.get(gone) ?? [], command]); };

  const noteWritten = (actorIndex: number, kind: Kind): void => {
    undoKinds[actorIndex]?.push(kind);
    const redoStack = redoKinds[actorIndex];
    if (redoStack) redoStack.length = 0;
  };

  const execute = (command: number, kind: Kind, actorIndex: number, actor: NativeScript, act: () => { kind: string; created?: string }): { kind: string; created?: string } => {
    const before = Y.encodeStateAsUpdate(actor.doc), restore = intercept(command, kind, actor, options);
    let outcome: { kind: string; created?: string };
    try { outcome = act(); } finally { restore(); }
    if (outcome.kind === "written") noteWritten(actorIndex, kind);
    if (options.spoil && outcome.kind === "refused") {
      actor.doc.transact(() => { actor.roots.beats.get("R1")?.set("spoiled", command); }, actor.origin);
    }
    if (outcome.kind !== "written" && !sameBytes(before, Y.encodeStateAsUpdate(actor.doc))) {
      throw new LocalCheck(`seed ${seed}, command ${command}: ${outcome.kind} but the stored update changed`);
    }
    return outcome;
  };

  const checkLocal = (
    command: number, actor: NativeScript, beforeEntries: readonly Entry[], want: readonly Entry[], wantStored: readonly string[],
    outcomeKind: string, expected: string, withRanks: boolean, moveCheck?: MoveCheck
  ): void => {
    actor.reader.refresh();
    counts[outcomeKind === "written" ? "written" : outcomeKind === "unchanged" ? "unchanged" : "refused"]++;
    const got = view(actor), stored = storedLetters(actor), sorted = (list: readonly string[]): string => [...list].sort().join("");
    if (outcomeKind !== expected || compared(got, withRanks) !== compared(want, withRanks) || sorted(stored) !== sorted(wantStored)) {
      throw new LocalCheck(`seed ${seed}, command ${command}: ${outcomeKind} (expected ${expected})\n${compared(want, withRanks)}\n${compared(got, withRanks)}`);
    }
    if (outcomeKind === "written" && moveCheck) verifyMoveRanks(seed, command, beforeEntries, got, moveCheck);
    if (options.onMutedMove && options.mute?.command === command && options.mute.blockKey) {
      const targetKey = options.mute.blockKey, at = got.findIndex(entry => moveKey(entry) === targetKey);
      const entry = at >= 0 ? got[at] : undefined, beforeEntry = beforeEntries.find(item => moveKey(item) === targetKey);
      const prev = at > 0 ? got[at - 1] : undefined, next = at >= 0 && at + 1 < got.length ? got[at + 1] : undefined;
      options.onMutedMove({
        blockKey: targetKey,
        orderMatches: got.length === want.length && got.every((item, idx) => moveKey(item) === moveKey(want[idx] as Entry)),
        hasRank: entry?.hasRank === true && beforeEntry?.hasRank === true,
        beforeRank: beforeEntry?.storedRank ?? "",
        keptRank: entry?.storedRank ?? "",
        prevRank: prev ? prev.shownRank : null,
        nextRank: next ? next.shownRank : null
      });
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const actorIndex = Math.floor(chance() * all.length), actor = all[actorIndex];
    const actorUndo = undo[actorIndex], uStack = undoKinds[actorIndex], rStack = redoKinds[actorIndex];
    assert.ok(actor && actorUndo && uStack && rStack);
    const roll = chance();
    if (roll < 0.18) { const to = pick(all.filter(copy => copy !== actor)); net.deliver(actor, to); continue; }
    if (roll < 0.28) {
      const topRedo = rStack.at(-1), topUndo = uStack.at(-1);
      if (topRedo && RANK_OR_FLAG.has(topRedo) && chance() < 0.35) {
        rStack.pop();
        if (actorUndo.redo()) { uStack.push(topRedo); counts.redos++; actor.reader.refresh(); }
        continue;
      }
      if (topUndo && RANK_OR_FLAG.has(topUndo)) {
        uStack.pop();
        if (actorUndo.undo()) { rStack.push(topUndo); counts.undos++; actor.reader.refresh(); }
        continue;
      }
    }
    const before = view(actor), stored = storedLetters(actor);
    const rows = before.filter(entry => !entry.heading && entry.own >= 0 && actor.roots.beats.get(entry.id) instanceof Y.Map);
    const heads = before.filter(entry => entry.heading || entry.head === entry.id);
    if (!rows.length || !heads.length) continue;
    const row = pick(rows), at = before.indexOf(row), command = counts.commands++;

    if (roll < 0.56) {
      if (chance() < 0.12) {
        const ref = moveRef(pick(heads));
        const outcome = execute(command, "move", actorIndex, actor, () => moveNativeBlocks(actor, [ref], ref));
        checkLocal(command, actor, before, before, stored, outcome.kind, "refused", true);
        continue;
      }
      const startIndex = Math.floor(chance() * heads.length), firstHead = heads[startIndex];
      assert.ok(firstHead);
      const span = chance() < 0.35 && startIndex + 1 < heads.length ? 2 : 1;
      const chosenHeads = heads.slice(startIndex, startIndex + span);
      const chosenKeys = new Set(chosenHeads.map(moveKey));
      const moving = before.filter(entry => chosenKeys.has(moveKey(entry)) || (!entry.heading && entry.head !== null && chosenKeys.has("beat:" + entry.head)));
      const movingSet = new Set(moving);
      const remaining = before.filter(entry => !movingSet.has(entry));
      const remainingHeads = remaining.filter(entry => entry.heading || entry.head === entry.id);
      const dropEntry = chance() < 0.25 || !remainingHeads.length ? null : pick(remainingHeads);
      const insertAt = dropEntry ? remaining.indexOf(dropEntry) : remaining.length;
      const want = [...remaining.slice(0, insertAt), ...moving, ...remaining.slice(insertAt)];
      const same = want.length === before.length && want.every((entry, idx) => entry === before[idx]);
      const expected = same ? "unchanged" : "written";
      const moveCheck = same ? undefined : planMoveCheck(before, moving, remaining, insertAt);
      const hasRankless = before.some(entry => !entry.hasRank);
      const blocks = chosenHeads.map(moveRef), drop = dropEntry ? moveRef(dropEntry) : null;
      const outcome = execute(command, "move", actorIndex, actor, () => moveNativeBlocks(actor, blocks, drop));
      if (outcome.kind === "written") {
        counts.moves++;
        if (hasRankless) counts.movesWithRankless++;
        if (moveCheck && moveCheck.ascending.length > moving.length) counts.tiedMoves++;
        if (moveCheck && moveCheck.pinned.length > 0) counts.ranklessMoves++;
      }
      checkLocal(command, actor, before, want, stored, outcome.kind, expected, false, moveCheck);
      continue;
    }

    if (roll < 0.65) {
      const visual = chance() < 0.3, cell = visual ? row.visual : row.narration, offset = Math.floor(chance() * (cell.length + 1));
      const typed = letter(visual ? 0xac00 : 0x4e00);
      (visual ? visualLetters : letters).add(typed);
      const wantStored = visual ? stored : [...stored, typed];
      const want = before.map(entry => entry !== row ? entry : visual
        ? { ...entry, visual: cell.slice(0, offset) + typed + cell.slice(offset) }
        : { ...entry, narration: cell.slice(0, offset) + typed + cell.slice(offset) });
      const outcome = execute(command, "type", actorIndex, actor, () => {
        const anchored = anchorNativeText(actor, { beat: row.id, cell: visual ? "visual" : "narration" }, offset);
        return anchored.kind === "anchored" ? replaceNativeText(actor, anchored.range, [{ text: typed, marks: {} }]) : anchored;
      });
      checkLocal(command, actor, before, want, wantStored, outcome.kind, "written", true);
    } else if (roll < 0.7 && row.narration.length) {
      const from = Math.floor(chance() * row.narration.length), to = Math.min(row.narration.length, from + 1 + Math.floor(chance() * 2));
      const gone = [...row.narration.slice(from, to)];
      for (const value of gone) deleting(value, command);
      const wantStored = stored.filter(value => !gone.includes(value));
      const want = before.map(entry => entry !== row ? entry : { ...entry, narration: entry.narration.slice(0, from) + entry.narration.slice(to) });
      const outcome = execute(command, "delete", actorIndex, actor, () => {
        const anchored = anchorNativeText(actor, { beat: row.id, cell: "narration" }, from, to);
        return anchored.kind === "anchored" ? replaceNativeText(actor, anchored.range, []) : anchored;
      });
      checkLocal(command, actor, before, want, wantStored, outcome.kind, "written", true);
    } else if (roll < 0.79) {
      const offset = Math.floor(chance() * (row.narration.length + 1));
      const outcome = execute(command, "split", actorIndex, actor, () => {
        const anchored = anchorNativeText(actor, { beat: row.id, cell: "narration" }, offset);
        return anchored.kind === "anchored" ? splitNativeRow(actor, anchored.range) : anchored;
      });
      const created = outcome.created ?? "";
      if (outcome.kind === "written") { counts.splits++; records.add(created); }
      const cut = splitCut(row, offset);
      const want = [
        ...before.slice(0, at),
        { ...row, narration: row.narration.slice(0, cut) },
        { id: created, heading: false, head: created, name: "", narration: row.narration.slice(cut), visual: "", hasRank: row.hasRank, storedRank: row.storedRank, shownRank: row.shownRank, joined: "", pieces: [], own: -1 },
        ...before.slice(at + 1)
      ];
      checkLocal(command, actor, before, want, stored, outcome.kind, "written", true);
    } else if (roll < 0.85) {
      const above = before[at - 1], glue = pick([" ", "", " - "]);
      const expected = !above || above.heading ? "refused" : row.joined === JSON.stringify({ into: above.id, glue }) ? "unchanged" : "written";
      const want = expected === "written" && above ? before.map(entry => entry !== row ? entry : { ...entry, joined: JSON.stringify({ into: above.id, glue }) }) : before;
      const into = above && !above.heading ? above.id : pick(rows).id;
      const outcome = execute(command, "join", actorIndex, actor, () => joinNativeRow(actor, row.id, into, glue));
      if (outcome.kind === "written") counts.joins++;
      checkLocal(command, actor, before, want, stored, outcome.kind, expected, true);
    } else if (roll < 0.88) {
      const expected = row.joined ? "written" : "unchanged";
      const want = before.map(entry => entry !== row ? entry : { ...entry, joined: "" });
      const outcome = execute(command, "unjoin", actorIndex, actor, () => unjoinNativeRow(actor, row.id));
      if (outcome.kind === "written") counts.unjoins++;
      checkLocal(command, actor, before, want, stored, outcome.kind, expected, true);
    } else if (roll < 0.94) {
      const shownHeadings = before.filter(entry => entry.heading);
      if (shownHeadings.length && chance() < 0.45) {
        const target = pick(shownHeadings);
        const want = before.filter(entry => entry !== target);
        const outcome = execute(command, "heading-remove", actorIndex, actor, () => removeNativeHeading(actor, target.id));
        if (outcome.kind === "written") counts.headingRemoves++;
        checkLocal(command, actor, before, want, stored, outcome.kind, "written", false);
      } else {
        const candidates = rows.filter(entry => entry.head === entry.id && entry.pieces.length === 1);
        const target = candidates.length ? pick(candidates) : row;
        const targetAt = before.indexOf(target), above = before[targetAt - 1];
        const tied = !!above && above.shownRank === target.shownRank;
        const canPlace = target.head === target.id && target.pieces.length === 1 && !tied && (above ? target.shownRank !== "" : true);
        const id = `H${actor.doc.clientID}-${headingSeq++}`;
        while (usedHeadings.has(id)) headingSeq++;
        usedHeadings.add(id);
        const name = "S" + id;
        const outcome = execute(command, "heading-create", actorIndex, actor, () => {
          const anchored = anchorNativeText(actor, { beat: target.id, cell: "narration" }, 0);
          return anchored.kind === "anchored" ? createNativeHeading(actor, anchored.range, id, name) : anchored;
        });
        const expected = canPlace ? "written" : "refused";
        const want = expected === "written"
          ? [...before.slice(0, targetAt), { id, heading: true, head: null, name, narration: "", visual: "", hasRank: true, storedRank: "", shownRank: "", joined: "", pieces: [], own: -1 }, ...before.slice(targetAt)]
          : before;
        if (outcome.kind === "written") counts.headingCreates++;
        checkLocal(command, actor, before, want, stored, outcome.kind, expected, false);
      }
    } else {
      const chosen = new Set([row.id, ...chance() < 0.35 && rows.length > 1 ? [pick(rows).id] : []]), gone: string[] = [];
      for (const entry of rows) if (chosen.has(entry.id)) { gone.push(...entry.narration); removed.add(entry.id); }
      for (const value of gone) deleting(value, command);
      const wantStored = stored.filter(value => !gone.includes(value));
      const want = before.filter(entry => !(!entry.heading && chosen.has(entry.id)));
      const outcome = execute(command, "remove", actorIndex, actor, () => removeNativeRows(actor, [...chosen]));
      if (outcome.kind === "written") counts.removals++;
      checkLocal(command, actor, before, want, wantStored, outcome.kind, "written", true);
    }
  }

  net.settle(); net.settle();
  net.agree();
  const [first] = all;
  assert.ok(first);
  const shownRows = new Set(view(first).filter(entry => !entry.heading).map(entry => entry.id));
  const shownLetters = first.reader.rows().flatMap(row => [...row.narration.map(run => run.text).join("")]);
  const stored = storedLetters(first);
  for (const value of letters) {
    counts.letters++;
    const times = shownLetters.filter(ch => ch === value).length, kept = stored.includes(value);
    const by = deletions.get(value) ?? [];
    if (times > 1) counts.twice++;
    if (stored.filter(ch => ch === value).length > 1) counts.storedTwice++;
    if (kept && by.length) counts.notDeleted++;
    else if (times) counts.shown++;
    else if (kept) counts.unplaced++;
    else if (by.length) counts.deleted++;
    else counts.lost++;
  }
  for (const id of records) {
    counts.records++;
    const record = first.roots.beats.get(id), cell = first.roots.visuals.get(id);
    if (!(record instanceof Y.Map) || !(cell instanceof Y.Text)) { counts.missingParts++; continue; }
    if (shownRows.has(id)) counts.shownRows++;
    else if (removed.has(id)) counts.keptRows++;
    else counts.vanished++;
  }
  const visualText = [...first.roots.visuals].map(([id, cell]) => [id, cell.toString()] as const);
  for (const value of visualLetters) {
    counts.visualLetters++;
    const holder = visualText.find(([, text]) => text.includes(value));
    if (holder) { counts.visualStored++; if (!shownRows.has(holder[0])) counts.visualOnHidden++; }
  }
  const byBeat = new Map<string, Set<string>>();
  for (const [key, seg] of first.roots.segments) {
    for (const span of nativeSegmentSpans(seg) ?? []) {
      if (!span.key?.startsWith("b:")) continue;
      const id = span.key.slice(2), set = byBeat.get(id) ?? new Set<string>();
      set.add(key); byBeat.set(id, set);
    }
  }
  for (const segs of byBeat.values()) if (segs.size > 1) counts.multiSegmentBeats++;
  for (const manager of undo) manager.destroy();
  for (const copy of all) copy.close();
  return counts;
}

test("generated moves mixed with row, heading, text and undo commands on three copies: local checks and settled accounting hold", t => {
  const totals: Record<string, number> = {};
  for (let seed = 1; seed <= SEEDS; seed++) for (const [key, value] of Object.entries(history(seed))) totals[key] = (totals[key] ?? 0) + value;
  t.diagnostic(JSON.stringify(totals));
  const total = (key: string): number => totals[key] ?? 0;
  assert.deepEqual(
    [total("twice"), total("storedTwice"), total("notDeleted"), total("lost"), total("unplaced"), total("vanished"), total("missingParts"), total("multiSegmentBeats")],
    [0, 0, 0, 0, 0, 0, 0, 0],
    JSON.stringify(totals)
  );
  assert.equal(total("shown") + total("unplaced") + total("deleted"), total("letters"));
  assert.equal(total("shownRows") + total("keptRows"), total("records"));
  assert.equal(total("visualStored"), total("visualLetters"));
  assert.ok(total("moves") > 200 && total("tiedMoves") > 10 && total("movesWithRankless") >= 10, JSON.stringify(totals));
  assert.ok(total("undos") > 20 && total("redos") > 5, JSON.stringify(totals));
  assert.ok(total("splits") > 50 && total("joins") > 20 && total("unjoins") > 5 && total("removals") > 30, JSON.stringify(totals));
  assert.ok(total("headingCreates") > 20 && total("headingRemoves") > 10, JSON.stringify(totals));
  assert.ok(total("refused") > 50 && total("unchanged") > 20, JSON.stringify(totals));
});

test("control: muting each individual write of a move fails the local check at that command", t => {
  let reached = 0, caught = 0, alreadyInGap = 0;
  const writes = new Map<Write, number>();
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    const calls: Call[] = [];
    history(seed, { calls });
    for (const call of calls.filter(entry => entry.kind === "move")) {
      reached++;
      writes.set(call.write, (writes.get(call.write) ?? 0) + 1);
      let threw = false;
      const captured: MutedMoveInfo[] = [];
      try { history(seed, { mute: call, onMutedMove: info => { captured.push(info); } }); } catch (error) {
        threw = true;
        assert.ok(error instanceof LocalCheck && error.message.startsWith(`seed ${seed}, command ${call.command}:`), `${JSON.stringify(call)}: ${String(error)}`);
        caught++;
      }
      if (!threw) {
        assert.equal(captured.length, 1, `uncaught mute had ${captured.length} records: ${JSON.stringify(call)}`);
        const [info] = captured;
        assert.ok(info, `uncaught mute had no record info: ${JSON.stringify(call)}`);
        assert.equal(info.orderMatches, true, `uncaught mute order mismatch: ${JSON.stringify({ call, info })}`);
        assert.equal(info.hasRank, true, `rankless write escaped mute check: ${JSON.stringify({ call, info })}`);
        assert.equal(info.keptRank, info.beforeRank, `uncaught mute did not keep old rank: ${JSON.stringify({ call, info })}`);
        assert.equal(isValidNativeRank(info.keptRank), true, `invalid kept rank: ${JSON.stringify({ call, info })}`);
        assert.ok(info.prevRank === null || info.prevRank < info.keptRank, `kept rank not after prev: ${JSON.stringify({ call, info })}`);
        assert.ok(info.nextRank === null || info.keptRank < info.nextRank, `kept rank not before next: ${JSON.stringify({ call, info })}`);
        alreadyInGap++;
      }
    }
  }
  t.diagnostic(`${reached} move writes muted, ${caught} caught at their command, ${alreadyInGap} kept valid rank strictly between neighbours: ${JSON.stringify(Object.fromEntries(writes))}`);
  assert.ok(caught > 40, JSON.stringify({ reached, caught, alreadyInGap, writes: Object.fromEntries(writes) }));
  assert.deepEqual([...writes.keys()], ["Map.set"]);
});

test("control: muting a rankless-neighbour write of a move is caught at that command", () => {
  const { net, all: [a, b], undo: [, undoB] } = copiesOf(structureScript({ A: "a", B: "b", C: "c", D: "d" }), [2, 3]);
  assert.ok(a && b && undoB);
  assert.deepEqual(moveNativeBlocks(a, [{ kind: "beat", id: "B" }], { kind: "beat", id: "D" }), { kind: "written" });
  assert.deepEqual(moveNativeBlocks(b, [{ kind: "beat", id: "B" }], null), { kind: "written" });
  net.settle();
  assert.ok(undoB.undo());
  net.settle();
  assert.equal(a.roots.beats.get("B")?.has("rank"), false);
  const calls: Call[] = [];
  const before = view(a), remaining = before.filter(e => e.id !== "D"), moving = before.filter(e => e.id === "D");
  const check = planMoveCheck(before, moving, remaining, 2);
  assert.equal(check.pinned.length, 1);
  const restore = intercept(0, "move", a, { calls });
  try { assert.deepEqual(moveNativeBlocks(a, [{ kind: "beat", id: "D" }], { kind: "beat", id: "C" }), { kind: "written" }); }
  finally { restore(); }
  assert.equal(calls.length, 2);
  verifyMoveRanks(0, 0, before, view(a), check);
  for (const call of calls) {
    const fresh = copiesOf(structureScript({ A: "a", B: "b", C: "c", D: "d" }), [2, 3]);
    const [fa, fb] = fresh.all, [, fundoB] = fresh.undo;
    assert.ok(fa && fb && fundoB);
    assert.deepEqual(moveNativeBlocks(fa, [{ kind: "beat", id: "B" }], { kind: "beat", id: "D" }), { kind: "written" });
    assert.deepEqual(moveNativeBlocks(fb, [{ kind: "beat", id: "B" }], null), { kind: "written" });
    fresh.net.settle();
    assert.ok(fundoB.undo());
    fresh.net.settle();
    const fbBefore = view(fa), fbRem = fbBefore.filter(e => e.id !== "D"), fbMov = fbBefore.filter(e => e.id === "D");
    const fbCheck = planMoveCheck(fbBefore, fbMov, fbRem, 2);
    const undoMute = intercept(0, "move", fa, { mute: call });
    try { moveNativeBlocks(fa, [{ kind: "beat", id: "D" }], { kind: "beat", id: "C" }); } finally { undoMute(); }
    assert.throws(() => verifyMoveRanks(0, 0, fbBefore, view(fa), fbCheck), LocalCheck);
    fundoB.destroy(); fa.close(); fb.close();
  }
  undoB.destroy(); a.close(); b.close();
});

test("control: a write slipped into any refusal fails the local check at that command", () => {
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    assert.throws(
      () => history(seed, { spoil: true }),
      (error: unknown) => error instanceof LocalCheck && /refused but the stored update changed/.test(error.message),
      `seed ${seed}`
    );
  }
});
