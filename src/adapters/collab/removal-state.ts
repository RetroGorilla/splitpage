import { projectSharedRemovalState } from "../../core/collab/removal-state.ts";
import { sharedPreparedValue } from "./prepare-value.ts";

const headingRemovalPrefix = "removal:";

export function readSharedRemovalState(entries: Iterable<readonly [string, unknown]>) {
  return Object.freeze(projectSharedRemovalState([...entries].map(([id, value]) => [id, sharedPreparedValue(value)])));
}

export function sharedHeadingRemovalField(removal: string): string { return headingRemovalPrefix + removal; }

export function readSharedHeadingRemovalState(keys: Iterable<string>, read: (key: string) => unknown) {
  const entries: [string, unknown][] = [];
  for (const key of keys) if (key.startsWith(headingRemovalPrefix)) entries.push([key.slice(headingRemovalPrefix.length), read(key)]);
  return readSharedRemovalState(entries);
}
