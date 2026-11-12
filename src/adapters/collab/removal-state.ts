import { projectSharedRemovalState } from "../../core/collab/removal-state.ts";
import { sharedPreparedValue } from "./prepare-value.ts";

export function readSharedRemovalState(entries: Iterable<readonly [string, unknown]>) {
  return Object.freeze(projectSharedRemovalState([...entries].map(([id, value]) => [id, sharedPreparedValue(value)])));
}
