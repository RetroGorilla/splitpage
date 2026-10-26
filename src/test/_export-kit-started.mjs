import { exportKitStarted } from "../legacy/export-kit-bridge.ts";
import { wireExportKit } from "../bootstrap/wiring/export-kit.ts";
import { migrateRows } from "../legacy/document-ports.ts";

if (!exportKitStarted()) wireExportKit(migrateRows);
