import { exportKitStarted } from "../bootstrap/wiring/export-capture.ts";
import { wireExportKit } from "../bootstrap/wiring/export-kit.ts";
import { migrateRows } from "../legacy/document-ports.ts";

if (!exportKitStarted()) wireExportKit(migrateRows);
