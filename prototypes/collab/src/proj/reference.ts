import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProjectionBag } from "./value.ts";

export const projectionRepo = fileURLToPath(new URL("../../../../", import.meta.url));

export interface ProjectionReference {
  document: ProjectionBag;
  saved: string;
}

const worker = `
import { readFileSync } from 'node:fs';
await import('./src/test/_dom.mjs');
const { migrateRows, withDocumentPorts } = await import('./src/bootstrap/document-ports.ts');
const { migrateDocument } = await import('./src/core/migrate.ts');
const { STATE_FIELDS } = await import('./src/core/merge/state-fields.ts');
const { buildSplitpageFile } = await import('./src/adapters/formats/project-file.ts');
const { parseSplitpageFile } = await import('./src/adapters/formats/splitpage-file.ts');
const values = JSON.parse(readFileSync(0, 'utf8'));
const results = values.map(value => {
  const parsed = parseSplitpageFile(typeof value === 'string' ? value : JSON.stringify(value));
  const document = withDocumentPorts(STATE_FIELDS, ports => migrateDocument(parsed, { kind: 'file' }, ports));
  return { document, saved: buildSplitpageFile({ document }, { migrateRows }) };
});
process.stdout.write(JSON.stringify(results));
process.exit(0);
`;

export function appReferences(values: readonly (ProjectionBag | string)[]): ProjectionReference[] {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", worker], {
    cwd: projectionRepo, input: JSON.stringify(values), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    timeout: 60000, windowsHide: true
  });
  if (result.status !== 0) throw new Error(`Reference serializer failed: ${result.stderr || String(result.error)}`);
  return JSON.parse(result.stdout) as ProjectionReference[];
}
