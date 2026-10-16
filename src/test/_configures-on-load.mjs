import { handTourPauseTo } from "../legacy/tour-pause.ts";
import { installExportFormats } from "../legacy/export-formats.ts";
import { createExportRegistry } from "../application/export/registry.ts";

handTourPauseTo({ interrupt: () => {}, offerResume: () => {} });
installExportFormats(createExportRegistry());
