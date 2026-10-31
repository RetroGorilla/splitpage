import type { PrintDialogJob } from "../../application/export/print-dialog.ts";
import type { BrowserPdfExportPorts } from "./local-files-ports.ts";

export function exportBrowserPdf(
  ports: BrowserPdfExportPorts, kind: string, options: Readonly<Record<string, unknown>> | undefined, alive: () => boolean
): Promise<void> | null {
  const exporter = ports.formats.byId(kind);
  if (ports.desktop() || !exporter?.printPage) return null;
  const render = exporter.printPage;
  let job: PrintDialogJob | null = null;
  try {
    job = ports.printDialog.reserve(alive);
    const held = job;
    const doc = ports.exports.captureExportDocument();
    const capturedOptions = Object.freeze({ ...options, brollView: Object.freeze(ports.brollView.printView(options?.brollView)) });
    const request = ports.assets.request(doc);
    return (async () => {
      try {
        const assets = await Promise.race([
          ports.exports.loadExportAssets(request),
          held.ended.then((result) => {
            if (result === "failed") throw new Error("Print preparation timed out");
            return null;
          })
        ]);
        if (!assets) return;
        if (!alive()) { held.close(); return; }
        const html = render({ doc, options: capturedOptions, assets });
        const result = await held.print(html);
        if (alive() && result === "opened") {
          ports.notices.show("Print dialog opened. Choose Save as PDF to save a PDF.", "ok");
        }
      } catch {
        held.close();
        if (alive()) ports.notices.show("Could not prepare the print page. Please try the PDF export again.", "error");
      }
    })();
  } catch (error) {
    job?.close();
    if (alive()) ports.notices.show(error instanceof Error ? error.message : "Could not open the print page.", "error");
    return Promise.resolve();
  }
}
