import { STRAY_ROW } from "../../src/native/variant.ts";
import type { MoveReplica } from "../../src/native-moves/ranks.ts";

export function missingContainers(replica: MoveReplica): string[] {
  return replica.rows().flatMap(row => row.members.flatMap(id => {
    if (id === STRAY_ROW) return [];
    return [!replica.beats.has(id) ? `${id} record` : "", !replica.visuals.has(id) ? `${id} visual` : ""].filter(Boolean);
  }));
}
