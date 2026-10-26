import { createExportKit } from "../../application/save/export-kit.ts";
import type { ExportKit, ExportAnchorBody } from "../../application/save/export-kit.ts";
import type { DocumentEntry } from "../../application/session/ports.ts";
import { exportServices } from "../../application/export/services.ts";
import type { ExportServices } from "../../application/export/services.ts";
import { randomIds, systemClock } from "../../adapters/identity/ids.ts";
import { assetPorts } from "../../adapters/formats/export-assets.ts";
import { startExportKit } from "../../legacy/export-kit-bridge.ts";
import { documentReader } from "./ports/document.ts";
import { preferenceValues } from "./ports/preferences.ts";

let owner: ExportKit | null = null;

export function exportKit(): ExportKit {
  if (!owner) throw new Error("The export kit is not started yet");
  return owner;
}

export function wireExportKit(entry: DocumentEntry): () => void {
  const made = createExportKit({
    read: documentReader.read,
    preferences: preferenceValues,
    clock: systemClock,
    ids: randomIds,
    services: () => exportServices() as ExportServices<ExportAnchorBody>,
    entry,
    assets: assetPorts,
    following: Node.DOCUMENT_POSITION_FOLLOWING
  });
  const stop = startExportKit(made);
  owner = made;
  return () => {
    stop();
    if (owner === made) owner = null;
  };
}
