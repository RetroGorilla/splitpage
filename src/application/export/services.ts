import type { TextServices } from "../text/services.ts";

export type ExportServices<Body = unknown> = Pick<TextServices<Body>, "cellOf" | "inertBody" | "fromHtml" | "htmlToMarkdown" | "htmlToPlainText" | "productionReaders" | "cacheSeal">;

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
