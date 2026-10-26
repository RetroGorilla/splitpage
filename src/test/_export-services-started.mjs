import { exportServicesStarted, installExportServices } from "../application/export/services.ts";
import { legacyExportServices } from "../bootstrap/export-services.ts";
import "./_export-kit-started.mjs";

if (!exportServicesStarted()) installExportServices(legacyExportServices());
