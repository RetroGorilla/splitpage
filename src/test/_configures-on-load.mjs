import { handTourPauseTo } from "../legacy/tour-pause.ts";
import { installExportFormats } from "../bootstrap/wiring/export-registry.ts";
import { createExportRegistry } from "../application/export/registry.ts";

handTourPauseTo({ interrupt: () => {}, offerResume: () => {} });
installExportFormats(createExportRegistry());
