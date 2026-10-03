import type { ValidatedDocument } from "./document/validated.ts";
import { mergeStateFields } from "./merge/states.ts";
import type { MergePorts, StateMerge } from "./merge/states.ts";
import { migrateRows } from "./migrate.ts";
import type { MigratePorts } from "./migrate.ts";

export interface MergeStatesPorts extends MergePorts {
  migrate: Omit<MigratePorts, "fields">;
}

export interface MergedStates extends StateMerge {
  merged: ValidatedDocument;
}

export function mergeStates(
  base: ValidatedDocument | null | undefined,
  mine: ValidatedDocument,
  theirs: ValidatedDocument,
  ports: MergeStatesPorts
): MergedStates {
  const r = mergeStateFields(base, mine, theirs, ports);
  const migrate: MigratePorts = Object.assign({}, ports.migrate, { fields: ports.fields });
  return {
    merged: migrateRows(r.merged, migrate),
    conflicts: r.conflicts,
    stats: r.stats
  };
}
