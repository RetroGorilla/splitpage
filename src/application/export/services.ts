import type { Frozen, Seal } from "../../core/document/freeze.ts";
import type { ProductionReaders } from "../../core/production/ports.ts";
import type { DecodeOptions } from "../../core/text/ports.ts";
import type { Run } from "../../core/text/runs.ts";

export interface ExportServices<Body = unknown> {
  readonly cellOf: (html: unknown) => Frozen<Run[]>;
  readonly inertBody: (html: unknown) => Body;
  readonly fromHtml: (html: unknown, opts?: DecodeOptions | null) => Run[];
  readonly htmlToMarkdown: (html: unknown) => string;
  readonly htmlToPlainText: (html: unknown) => string;
  readonly productionReaders: ProductionReaders;
  readonly cacheSeal: Seal;
}

const SERVICES: readonly (keyof ExportServices)[] = ["cellOf", "inertBody", "fromHtml", "htmlToMarkdown", "htmlToPlainText", "productionReaders", "cacheSeal"];

let installed: ExportServices | null = null;

export function installExportServices(services: ExportServices): () => void {
  if (installed) throw new Error("The export services are already started; stop them first");
  const missing = SERVICES.find((name) => services[name] == null);
  if (missing) throw new Error("The export services have no " + missing);
  const held = Object.freeze({ ...services });
  installed = held;
  return () => {
    if (installed === held) installed = null;
  };
}

export function exportServicesStarted(): boolean {
  return installed !== null;
}

export function exportServices(): ExportServices {
  if (!installed) throw new Error("The export services are not started yet");
  return installed;
}
