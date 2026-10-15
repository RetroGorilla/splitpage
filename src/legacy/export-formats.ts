import type { ExportRegistry } from "../application/export/registry.ts";

let installed: ExportRegistry | null = null;

function registry(): ExportRegistry {
  if (!installed) throw new Error("The export registry is not started yet");
  return installed;
}

export function installExportFormats(formats: ExportRegistry): () => void {
  if (installed) throw new Error("The export registry is already started; stop it first");
  installed = formats;
  return () => {
    if (installed === formats) installed = null;
  };
}

export const exportFormats: ExportRegistry = {
  defineCard: (card) => registry().defineCard(card),
  register: (exporter) => registry().register(exporter),
  card: (id) => registry().card(id),
  cards: () => registry().cards(),
  exporters: () => registry().exporters(),
  byId: (id) => registry().byId(id),
  byAction: (action) => registry().byAction(action),
  isAction: (action) => registry().isAction(action),
  onChange: (listener) => registry().onChange(listener)
};
