import { createMonitoredSharedDocument } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { readSharedDocumentFieldProjection } from "../../../src/adapters/collab/project.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";

export function withProjectedFixture<T>(document: ValidatedDocument, read: (projected: Readonly<Record<string, unknown>>) => T): T {
  const handle = createMonitoredSharedDocument();
  try { hydrateSharedDocument(handle, document); const projected = readSharedDocumentFieldProjection(handle); return read({ ...projected.document, sections: projected.sections }); }
  finally { destroySharedDocument(handle); }
}
