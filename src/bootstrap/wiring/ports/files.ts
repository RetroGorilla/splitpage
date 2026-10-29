import type { ExportRegistry } from "../../../application/export/registry.ts";
import type { FileDelivery } from "../../../application/files/file-delivery.ts";
import type { LastFile } from "../../../application/files/last-file.ts";
import { loadLastFileHandle } from "../../../adapters/files/last-file.ts";
import { deliverBytes } from "../../../adapters/files/deliver.ts";
import { exportFormats } from "../export-registry.ts";
import { notices } from "./effects.ts";

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
  deliver: async (filename, data, options) => {
    const delivered = await deliverBytes(filename, data);
    if (delivered === "saved") notices.show((options && options.savedMsg) || ("Saved " + filename), "ok");
    else if (delivered === "failed") notices.show("Could not save the file. Please try again.", "error");
    return delivered === "saved";
  }
};
