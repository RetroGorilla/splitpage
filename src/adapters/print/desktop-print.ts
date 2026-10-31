import type { PdfPrinter } from "../../application/export/pdf-printer.ts";
import type { DesktopPort } from "../desktop/desktop-port.ts";
import { exportDay } from "../formats/export-kit.ts";

const PDF_DATE = /\/(?:CreationDate|ModDate) ?\((D:\d{14}(?:[+-]\d{2}'\d{2}'|Z))\)/g;

export function desktopPdfPrinter(desktop: () => Pick<DesktopPort, "printToPdf"> | null): PdfPrinter {
  return {
    print: async (html, doc) => {
      const port = desktop();
      if (!port) throw new Error("The desktop is unavailable");
      return pinPdfDay(await port.printToPdf(html), exportDay(doc));
    }
  };
}

function pdfDayStamp(day: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  const offset = -day.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset);
  return "D:" + day.getFullYear() + two(day.getMonth() + 1) + two(day.getDate()) + "000000" +
    sign + two(Math.floor(minutes / 60)) + "'" + two(minutes % 60) + "'";
}

export function pinPdfDay(pdf: Uint8Array, day: Date): Uint8Array {
  const stamp = pdfDayStamp(day);
  const text = new TextDecoder("latin1").decode(pdf);
  const pinned = new Uint8Array(pdf);
  for (const match of text.matchAll(PDF_DATE)) {
    const found = match[1] ?? "";
    if (found.length !== stamp.length) continue;
    const at = (match.index ?? 0) + match[0].indexOf(found);
    for (let i = 0; i < stamp.length; i++) pinned[at + i] = stamp.charCodeAt(i);
  }
  return pinned;
}
