import * as Y from "yjs";

export function inspectUpdateDependencies(update: Uint8Array, vector: Uint8Array): {
  gaps: string[]; references: string[]; deletions: string[];
} {
  const decoded = Y.decodeUpdate(update);
  const clocks = Y.decodeStateVector(vector);
  const known = (client: number, clock: number): boolean => (clocks.get(client) ?? 0) > clock
    || decoded.structs.some(struct => !(struct instanceof Y.Skip)
      && struct.id.client === client && struct.id.clock <= clock && struct.id.clock + struct.length > clock);
  const gaps: string[] = [];
  const references: string[] = [];
  const deletions: string[] = [];
  for (const struct of decoded.structs) {
    const clock = clocks.get(struct.id.client) ?? 0;
    if (struct.id.clock > clock && !known(struct.id.client, struct.id.clock - 1)) {
      gaps.push(`${struct.id.client}:${clock}..${struct.id.clock}`);
    }
    if (struct instanceof Y.Item) {
      for (const [kind, id] of [["origin", struct.origin], ["rightOrigin", struct.rightOrigin],
        ["parent", struct.parent instanceof Y.ID ? struct.parent : null]] as const) {
        if (id && !known(id.client, id.clock)) references.push(`${kind}:${id.client}:${id.clock}`);
      }
    }
  }
  for (const [client, ranges] of decoded.ds.clients) {
    for (const range of ranges) {
      if (!known(client, range.clock) || !known(client, range.clock + range.len - 1)) {
        deletions.push(`${client}:${range.clock}..${range.clock + range.len}`);
      }
    }
  }
  return { gaps, references, deletions };
}
