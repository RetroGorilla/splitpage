import * as Y from "yjs";
import { createProjectionReplica, fromDocument, toDocument } from "./document.ts";
import { projectionReferences } from "./reference.ts";
import { differences } from "./experiment.ts";
import { records } from "./value.ts";

export function runCueProjections() {
  const references = projectionReferences();
  const results = [];
  for (const reference of references) {
    if (!records(reference.document.rows).some(row => String(row.audioText).includes("audio-cue") || String(row.visualText).includes("audio-cue"))) continue;
    for (const candidate of ["A", "B"] as const) {
      const replica = fromDocument(reference.document, candidate);
      const second = createProjectionReplica(candidate, 11);
      try {
        Y.applyUpdate(second.doc, Y.encodeStateAsUpdate(replica.doc));
        const stored = toDocument(second.doc, candidate);
        const derived = toDocument(second.doc, candidate, { deriveCue: true });
        results.push({ candidate, fixture: reference.name, stored: differences(reference.document, stored), derived: differences(reference.document, derived) });
      } finally { replica.destroy(); second.destroy(); }
    }
  }
  return results;
}
