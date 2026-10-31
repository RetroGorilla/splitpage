import type { PrintDialogPort } from "../../../application/export/print-dialog.ts";
import { browserPrintDialog } from "../../../adapters/print/browser-print.ts";

export const printDialog: PrintDialogPort = { reserve: (alive) => browserPrintDialog(window).reserve(alive) };
