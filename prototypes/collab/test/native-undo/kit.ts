import { World, marked, rowsOf } from "../../src/native-undo/harness.ts";
import type { WorldOptions, WorldRow } from "../../src/native-undo/harness.ts";
import { readRecords } from "../../src/native-undo/layer.ts";

export const ROWS: readonly WorldRow[] = [{ id: "R1", audioText: "abcd", visualText: "vw" }, { id: "R2", audioText: "efg" }];

export function world(rows: readonly WorldRow[] = ROWS, options: WorldOptions = {}): World {
  return new World(rows, options);
}

// why: what a person sees on one copy: rows, then anything listed for recovery
export function seen(world: World, name = "A"): string[] {
  const replica = world.copy(name).replica;
  return [...rowsOf(replica), ...replica.recovery().map(item => `recovery ${item.beat}: ${item.kept}${item.unseen.length ? ` (unseen ${item.unseen.join(",")})` : ""}${item.visual ? ` / ${item.visual}` : ""}`)];
}

export function records(world: World, name = "A"): Record<string, unknown> {
  return readRecords(world.copy(name).replica);
}

// why: every checked step ends with all updates delivered, all copies and a late joiner agreeing with the model
export function settled(world: World, label: string): string[] {
  world.settle();
  world.check(label);
  return seen(world);
}

// why: a beat's narration with its marks, shown whether or not the beat is removed
export function narration(world: World, beat: string, name = "A"): string {
  return marked(world.copy(name).replica.block(beat).delta);
}

export function field(world: World, beat: string, key: string, name = "A"): unknown {
  return world.copy(name).replica.beats.get(beat)?.get(key);
}

export function stacks(world: World, name: string): [number, number] {
  const manager = world.copy(name).layer.manager;
  return [manager.undoStack.length, manager.redoStack.length];
}
