import { statusValue } from "../../src/marks/commands.ts";
import { projectStatus } from "../../src/marks/projection.ts";
import { IdentityBook } from "../../src/model.ts";
import type { CollabModel } from "../../src/model.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { perfStructureView } from "../../src/perf/operations.ts";
import { IndexedStructureProjection } from "../../src/perf/lifetime/projector.ts";
import type { SchemaReplica } from "../../src/schema.ts";
import { mapValue } from "../../src/schema.ts";
import type { BeatStatusEvent } from "../../src/marks/status-resolution.ts";

export function statusReaders(replica: SchemaReplica): Record<string, string | undefined> {
  const model: CollabModel = { rows: [{ id: "R1", characters: [], status: "todo" }], carets: {}, recovery: [] };
  projectStatus(model, replica.doc);
  const indexed = new IndexedStructureProjection(replica);
  const document = { rows: [{ id: "R1", audioText: "", visualText: "" }] };
  const book = new IdentityBook();
  for (const character of replica.characters()) book.bind(`char-${character.identity.client}-${character.identity.clock}`, character.identity);
  try {
    return { command: statusValue(replica, "R1"), projection: model.rows[0]?.status,
      structure: readStructure(replica.doc, replica.candidate, book).rows[0]?.status,
      perf: perfStructureView(replica, document).groups[0]?.status,
      indexed: indexed.view(document).groups[0]?.status };
  } finally { indexed.destroy(); }
}

export function legacyStatusValue(replica: SchemaReplica, target: string): string {
  const events = [...replica.doc.getMap<BeatStatusEvent>("statusEvents")].filter(([, event]) => event.target === target);
  const parents = new Set(events.flatMap(([, event]) => event.parents));
  const frontier = events.filter(([id]) => !parents.has(id));
  if (!frontier.length) return String(mapValue(replica.doc.getMap("beats").get(target)).get("status"));
  const values = frontier.map(([id, event]) => replica.doc.getMap("retiredStatus").has(id) ? event.prior : event.value);
  return (new Set(values).size === 1 ? values[0] ?? "todo" : frontier[0]?.[1].prior ?? "todo") as string;
}

