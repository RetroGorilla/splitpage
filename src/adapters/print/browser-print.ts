import type { PrintDialogJob, PrintDialogPort, PrintDialogResult } from "../../application/export/print-dialog.ts";

export function browserPrintDialog(host: Window): PrintDialogPort {
  return { reserve: (alive) => reserve(host, alive) };
}

function reserve(host: Window, alive: () => boolean): PrintDialogJob {
  const popup = host.open("", "_blank", "popup");
  if (!popup) throw new Error("Allow pop-ups for Splitpage, then try the PDF export again.");
  popup.opener = null;
  popup.document.title = "Preparing PDF — Splitpage";
  popup.document.body.textContent = "Preparing the print page…";
  const controller = new AbortController();
  let finished = false;
  let timedOut = false;
  let end: (result: "closed" | "failed") => void = () => {};
  const ended = new Promise<"closed" | "failed">((resolve) => { end = resolve; });
  const close = (): void => {
    if (finished) return;
    finished = true;
    end(timedOut ? "failed" : "closed");
    controller.abort();
    host.clearInterval(watch);
    host.clearTimeout(deadline);
    host.removeEventListener("pagehide", close);
    popup.removeEventListener("afterprint", close);
    if (!popup.closed) popup.close();
  };
  const watch = host.setInterval(() => { if (popup.closed || !alive()) close(); }, 250);
  const deadline = host.setTimeout(() => { timedOut = true; close(); }, 60000);
  host.addEventListener("pagehide", close);

  const print = async (html: string): Promise<PrintDialogResult> => {
    if (timedOut) throw new Error("Print preparation timed out. Please try again.");
    if (finished || popup.closed || !alive()) { close(); return "closed"; }
    try {
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      popup.addEventListener("afterprint", close);
      const ready = Promise.all([
        popup.document.fonts?.ready,
        ...Array.from(popup.document.images, async (img) => {
          await img.decode();
          if (!img.naturalWidth) throw new Error("A picture could not be prepared for printing.");
        })
      ]);
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => { reject(new Error("Print preparation ended before the page was ready.")); };
        controller.signal.addEventListener("abort", aborted, { once: true });
        ready.then(() => { controller.signal.removeEventListener("abort", aborted); resolve(); },
          (error: unknown) => { controller.signal.removeEventListener("abort", aborted); reject(error); });
      });
      if (finished || popup.closed || !alive()) { close(); return "closed"; }
      host.clearTimeout(deadline);
      popup.focus();
      popup.print();
      return "opened";
    } catch (error) {
      const cancelled = finished;
      close();
      if (cancelled && !timedOut) return "closed";
      throw error;
    }
  };

  return { print, close, ended };
}
