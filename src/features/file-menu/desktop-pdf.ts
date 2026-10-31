import type { DesktopPdfExportPorts } from "./local-files-ports.ts";

export function exportDesktopPdf(
  ports: DesktopPdfExportPorts, kind: string, options: Readonly<Record<string, unknown>> | undefined, alive: () => boolean
): Promise<void> | null {
  const exporter = ports.formats.byId(kind);
  if (!ports.desktop() || !exporter?.printPage) return null;
  const render = exporter.printPage;
  const doc = ports.exports.captureExportDocument();
  const capturedOptions = Object.freeze({ ...options, brollView: Object.freeze(ports.brollView.printView(options?.brollView)) });
  const request = ports.assets.request(doc);
  const filename = exporter.fileName(ports.baseName(), {});
  const label = kind.toUpperCase();
  return (async () => {
    let pdf: Uint8Array;
    try {
      pdf = await ports.notices.busy.withBar("Building the " + label + " file…", async () => {
        const assets = await ports.exports.loadExportAssets(request);
        if (!alive()) throw new Error("The local file menu is not started yet");
        return ports.pdfPrinter.print(render({ doc, options: capturedOptions, assets }), doc);
      });
    } catch {
      if (alive()) ports.notices.show("Could not build the " + label + " file.", "error");
      return;
    }
    if (!alive()) return;
    await ports.delivery.deliver(filename, pdf, { savedMsg: "Exported " + filename });
  })();
}
