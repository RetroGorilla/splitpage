import type { ExportRegistry } from "../../../application/export/registry.ts";
import type { FileDelivery } from "../../../application/files/file-delivery.ts";
import type { LastFile } from "../../../application/files/last-file.ts";
import { loadLastFileHandle } from "../../../adapters/files/last-file.ts";
import { deliverFile } from "../../../legacy/file-delivery.ts";
import { exportFormats } from "../export-registry.ts";

export const exports: Pick<ExportRegistry, "card" | "cards" | "exporters" | "byId" | "byAction" | "isAction" | "onChange"> = {
  card: (id) => exportFormats.card(id),
  cards: () => exportFormats.cards(),
  exporters: () => exportFormats.exporters(),
  byId: (kind) => exportFormats.byId(kind),
  byAction: (action) => exportFormats.byAction(action),
  isAction: (action) => exportFormats.isAction(action),
  onChange: (listener) => exportFormats.onChange(listener)
};

export const lastFile: LastFile = { load: loadLastFileHandle };

export const fileDelivery: FileDelivery = {
  deliver: (filename, data, options) => deliverFile(filename, data, options)
};
