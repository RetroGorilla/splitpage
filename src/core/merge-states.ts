import { mergeStateFields } from "./merge/states.ts";
import type { MergeDoc, MergePorts, StateMerge } from "./merge/states.ts";
import { migrateRows } from "./migrate.ts";
import type { MigratePorts } from "./migrate.ts";

export interface MergeStatesPorts extends MergePorts {
  migrate: Omit<MigratePorts, "fields">;
}

export function mergeStates(base: MergeDoc | null | undefined, mine: MergeDoc, theirs: MergeDoc, ports: MergeStatesPorts): StateMerge {
  const r = mergeStateFields(base, mine, theirs, ports);
  const migrate: MigratePorts = Object.assign({}, ports.migrate, { fields: ports.fields });
  return {
    merged: migrateRows(r.merged, migrate),
    conflicts: r.conflicts,
    stats: r.stats
  };
}
