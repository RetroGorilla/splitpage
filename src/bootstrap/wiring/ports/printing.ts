import type { PrintDialogPort } from "../../../application/export/print-dialog.ts";
import type { PdfPrinter } from "../../../application/export/pdf-printer.ts";
import { browserPrintDialog } from "../../../adapters/print/browser-print.ts";
import { desktopPdfPrinter } from "../../../adapters/print/desktop-print.ts";
import { desktopPort } from "../../../adapters/desktop/desktop-port.ts";

export const printDialog: PrintDialogPort = { reserve: (alive) => browserPrintDialog(window).reserve(alive) };

export const pdfPrinter: PdfPrinter = desktopPdfPrinter(desktopPort);
