import { exportServicesStarted, installExportServices } from "../application/export/services.ts";
import { legacyExportServices } from "../bootstrap/export-services.ts";

if (!exportServicesStarted()) installExportServices(legacyExportServices());
