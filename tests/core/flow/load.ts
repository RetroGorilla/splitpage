import { createRichText } from "../../../src/adapters/richtext/richtext.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { createImageIngestion } from "../../../src/core/document/media.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { createProductionReaders } from "../../../src/core/production/readers.ts";
import type { FlowPorts } from "../../../src/core/flow/flow.ts";
import { jsdomParser } from "../../adapters/richtext/jsdom.mjs";
import { countingIds } from "../migrate-ports.ts";

export function expectedHeadingWhitespaceOnReload(input: unknown): unknown {
  const expected = JSON.parse(JSON.stringify(input)) as { sections?: { name: string }[] };
  expected.sections?.forEach(scene => { scene.name = scene.name.trim(); });
  return expected;
}

export function createFlowLoadRuntime() {
  const images = createImageIngestion(() => null);
  const ids = countingIds();
  const rich = createRichText({ DOMParser: jsdomParser(), images, ids });
  const cells = rich.createCellReader(deepFreeze, { media: true });
  const migration = { images, ids, sanitize: rich.sanitize, decode: rich.decode, videoCardHtml: rich.videoCardHtml,
    readers: createProductionReaders(cells, deepFreeze) };
  let next = 0;
  const ports: FlowPorts = { cells, newId: () => "new" + ++next, hasVisual: row => !!row.visualText || !!row.imageRef || !!row.moreImages };
  return { cells, ports, rich, load: (input: unknown) => migrateRows(JSON.parse(JSON.stringify(input)) as unknown, migration) };
}
