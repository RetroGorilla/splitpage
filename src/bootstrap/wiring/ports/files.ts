import type { ExportRegistry } from "../../../application/export/registry.ts";
import type { FileDelivery } from "../../../application/files/file-delivery.ts";
import type { LastFile } from "../../../application/files/last-file.ts";
import { loadLastFileHandle } from "../../../js/00-prelude.js";
import { deliverFile } from "../../../legacy/file-delivery.ts";
import { exportFormats } from "../../../legacy/export-formats.ts";

export const exports: Pick<ExportRegistry, "card" | "cards" | "exporters" | "byAction" | "isAction" | "onChange"> = {
  card: (id) => exportFormats.card(id),
  cards: () => exportFormats.cards(),
  exporters: () => exportFormats.exporters(),
  byAction: (action) => exportFormats.byAction(action),
  isAction: (action) => exportFormats.isAction(action),
  onChange: (listener) => exportFormats.onChange(listener)
};

export const lastFile: LastFile = { load: loadLastFileHandle };

export const fileDelivery: FileDelivery = {
  deliver: (filename, data, options) => deliverFile(filename, data, options)
};
