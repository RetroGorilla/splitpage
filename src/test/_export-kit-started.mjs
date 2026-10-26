import { exportKitStarted } from "../legacy/export-kit-bridge.ts";
import { wireExportKit } from "../bootstrap/wiring/export-kit.ts";
import { migrateRows } from "../js/02-state.js";

if (!exportKitStarted()) wireExportKit(migrateRows);
