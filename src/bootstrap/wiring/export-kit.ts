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

export function wireExportKit(entry: DocumentEntry): { readonly owner: ExportKit; readonly stop: () => void } {
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
  return { owner: made, stop: startExportKit(made) };
}
