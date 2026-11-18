import { writeFileSync } from "node:fs";
import * as Y from "yjs";
import { NativeReplica, nativeCopy } from "../native/variant.ts";
import { random } from "./generator.ts";
import { UndoLayer } from "./layer.ts";
import type { CreationRule } from "./layer.ts";

export interface Checkpoint { readonly operations: number; readonly typed: number; readonly visible: number; readonly editing: number; readonly receiving: number; readonly fresh: number; readonly retained: number; readonly undo: number }
export interface SessionResult { readonly bound: number | null; readonly checkpoints: Checkpoint[]; readonly afterClear: number }
export interface CreationCost { readonly rule: CreationRule; readonly what: string; readonly count: number; readonly bytesPerUndone: number; readonly freshBytesPerUndone: number }

const BEATS = 30;

function rows(): { id: string; audioText: string; visualText: string }[] {
  return Array.from({ length: BEATS }, (_, index) => ({ id: `R${index + 1}`, audioText: "the opening words", visualText: "" }));
}

export function retainedCharacters(doc: Y.Doc): number {
  let total = 0;
  for (const structs of doc.store.clients.values()) for (const struct of structs) {
    if (struct instanceof Y.Item && struct.deleted && struct.content instanceof Y.ContentString) total += struct.content.str.length;
  }
  return total;
}

function freshSize(doc: Y.Doc): number {
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  const size = Y.encodeStateAsUpdate(fresh).length;
  fresh.destroy();
  return size;
}

// why: a long session of word-by-word typing with backspaces, formatting and undo, one keystroke a command, as an
// editor sends them; a second copy only receives, as every other person's copy does
export function session(operations: number, bound: number | null, every: number): SessionResult {
  const seed = new NativeReplica(900, 0, "act");
  seed.hydrate({ rows: rows() });
  const editing = nativeCopy(seed, 1), receiving = nativeCopy(seed, 2);
  let clock = 0;
  const layer = new UndoLayer(editing, { now: () => clock, bound: bound ?? Number.POSITIVE_INFINITY });
  editing.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(receiving.doc, update, "remote"); });
  const next = random(7), checkpoints: Checkpoint[] = [];
  let typed = 0, beat = "R1", at = 0;
  for (let operation = 1; operation <= operations; operation++) {
    clock += 120;
    const cell = editing.cell(beat, "audioText"), length = cell.end - cell.start, roll = next();
    if (roll < 0.02) { beat = `R${1 + Math.floor(next() * BEATS)}`; at = 0; clock += 2000; }
    else if (roll < 0.22 && at > 0) { layer.erase(beat, "audioText", at - 1, at); at--; }
    else if (roll < 0.235 && length > 4) {
      const from = Math.floor(next() * (length - 3));
      layer.command(() => { editing.format(beat, "audioText", from, from + 3, { b: next() < 0.7 ? true : null }); });
    } else if (roll < 0.25) { layer.undo(); at = Math.min(at, editing.cell(beat, "audioText").end - editing.cell(beat, "audioText").start); }
    else if (roll < 0.255) { layer.redo(); at = Math.min(at, editing.cell(beat, "audioText").end - editing.cell(beat, "audioText").start); }
    else {
      const char = next() < 0.18 ? " " : "etaoinshrdlu".charAt(Math.floor(next() * 12));
      layer.type(beat, "audioText", Math.min(at, length), char);
      at = Math.min(at, length) + 1; typed++;
    }
    if (operation % every === 0) {
      const visible = editing.blocks().reduce((sum, block) => sum + block.end - block.start, 0);
      checkpoints.push({
        operations: operation, typed, visible, editing: Y.encodeStateAsUpdate(editing.doc).length, receiving: Y.encodeStateAsUpdate(receiving.doc).length,
        fresh: freshSize(editing.doc), retained: retainedCharacters(editing.doc), undo: layer.manager.undoStack.length
      });
    }
  }
  layer.manager.clear();
  const afterClear = Y.encodeStateAsUpdate(editing.doc).length;
  editing.destroy(); receiving.destroy(); seed.destroy();
  return { bound, checkpoints, afterClear };
}

export function creationCost(rule: CreationRule, what: "record" | "split", count: number): CreationCost {
  const seed = new NativeReplica(900, 0, "act");
  seed.hydrate({ rows: [{ id: "R1", audioText: "abcdefgh".repeat(count), visualText: "" }] });
  const replica = nativeCopy(seed, 1), layer = new UndoLayer(replica, { creations: rule, now: () => 0 });
  const before = Y.encodeStateAsUpdate(replica.doc).length, freshBefore = freshSize(replica.doc);
  for (let index = 0; index < count; index++) {
    if (what === "record") layer.command(() => { layer.createRecord("tags", `T${index}`, { name: `tag ${index}`, colour: "red" }); });
    else layer.command(() => { replica.split("R1", 4, `S${index}`); });
    layer.undo();
  }
  const result: CreationCost = {
    rule, what, count, bytesPerUndone: (Y.encodeStateAsUpdate(replica.doc).length - before) / count, freshBytesPerUndone: (freshSize(replica.doc) - freshBefore) / count
  };
  replica.destroy(); seed.destroy();
  return result;
}

export interface PasteResult { readonly pasted: number; readonly editing: number; readonly fresh: number; readonly retained: number; readonly editingItems: number; readonly freshItems: number }

function items(doc: Y.Doc): number {
  let total = 0;
  for (const structs of doc.store.clients.values()) total += structs.length;
  return total;
}

// why: what history holds when large pastes are deleted: each cycle pastes a block and deletes it again
export function pastes(cycles: number, size: number): PasteResult[] {
  const seed = new NativeReplica(900, 0, "act");
  seed.hydrate({ rows: rows() });
  const replica = nativeCopy(seed, 1), layer = new UndoLayer(replica, { now: () => 0 }), result: PasteResult[] = [];
  const block = "lorem ipsum dolor sit amet ".repeat(Math.ceil(size / 27)).slice(0, size);
  for (let cycle = 1; cycle <= cycles; cycle++) {
    layer.command(() => { replica.splice("R1", "audioText", 0, 0, [{ text: block, marks: {} }]); });
    layer.command(() => { replica.splice("R1", "audioText", 0, size, []); });
    if (cycle % (cycles / 4) === 0) {
      const fresh = new Y.Doc();
      Y.applyUpdate(fresh, Y.encodeStateAsUpdate(replica.doc));
      result.push({ pasted: cycle * size, editing: Y.encodeStateAsUpdate(replica.doc).length, fresh: Y.encodeStateAsUpdate(fresh).length, retained: retainedCharacters(replica.doc), editingItems: items(replica.doc), freshItems: items(fresh) });
      fresh.destroy();
    }
  }
  replica.destroy(); seed.destroy();
  return result;
}

export function measure(): { sessions: SessionResult[]; pastes: PasteResult[]; creations: CreationCost[] } {
  return {
    sessions: [session(20_000, 200, 5_000), session(20_000, null, 5_000)],
    pastes: pastes(100, 10_000),
    creations: (["keep-always", "keep-holding"] as const).flatMap(rule => [creationCost(rule, "record", 100), creationCost(rule, "split", 100)])
  };
}

if (process.argv[1]?.endsWith("memory.ts")) {
  const result = JSON.stringify(measure(), null, 2);
  if (process.argv.includes("--write")) writeFileSync(new URL("./memory-results.json", import.meta.url), result + "\n");
  process.stdout.write(result + "\n");
}
