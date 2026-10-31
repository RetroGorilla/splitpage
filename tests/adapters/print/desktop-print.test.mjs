import test from "node:test";
import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import { desktopPdfPrinter, pinPdfDay } from "../../../src/adapters/print/desktop-print.ts";

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);
const bytesOf = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));

function chromiumPdf(stamp) {
  return bytesOf("%PDF-1.4\n%\xd3\xeb\xe9\xe1\n1 0 obj\n<</Creator (Chromium)\n/Producer (Skia/PDF m152)\n" +
    "/CreationDate (" + stamp + ")\n/ModDate (" + stamp + ")>>\nendobj\n2 0 obj\n<</Title (D:20261031182615+00'00')>>\nendobj\n");
}

function offsetStamp(day) {
  const offset = -day.getTimezoneOffset();
  const abs = Math.abs(offset);
  return (offset < 0 ? "-" : "+") + String(Math.floor(abs / 60)).padStart(2, "0") + "'" + String(abs % 60).padStart(2, "0") + "'";
}

test("Chromium's creation and modification times become the captured day at midnight, same length, nothing else moved", () => {
  const day = new Date(2026, 9, 31);
  const printed = chromiumPdf("D:20261031182615+00'00'");
  const pinned = pinPdfDay(printed, day);
  assert.equal(pinned.length, printed.length);
  const text = latin1(pinned);
  const stamp = "D:20261031000000" + offsetStamp(day);
  assert.equal(text.split("/CreationDate (" + stamp + ")").length, 2);
  assert.equal(text.split("/ModDate (" + stamp + ")").length, 2);
  assert.ok(text.includes("/Title (D:20261031182615+00'00')"), "a date-like title is not a date entry");
  assert.ok(text.startsWith("%PDF-1.4\n%\xd3\xeb\xe9\xe1\n"), "binary header bytes survive");
  assert.equal(latin1(printed).includes("D:20261031000000"), false, "the printed bytes are not changed in place");
});

test("two prints of one capture, a few seconds apart, end up the same bytes all day", () => {
  const day = new Date(2026, 9, 31);
  const first = pinPdfDay(chromiumPdf("D:20261031182615+00'00'"), day);
  const later = pinPdfDay(chromiumPdf("D:20261101032959+00'00'"), day);
  assert.deepEqual(later, first);
});

test("a date in another form is left alone rather than shifting the file's offsets", () => {
  const printed = chromiumPdf("D:20261031182615Z");
  assert.deepEqual(pinPdfDay(printed, new Date(2026, 9, 31)), printed);
  const none = bytesOf("%PDF-1.4\n1 0 obj\n<</Producer (Skia)>>\nendobj\n");
  assert.deepEqual(pinPdfDay(none, new Date(2026, 9, 31)), none);
});

test("the printer sends the HTML to the desktop and pins the result to the capture's day", async () => {
  const sent = [];
  const printer = desktopPdfPrinter(() => ({ printToPdf: async (html) => { sent.push(html); return chromiumPdf("D:20261031235959+00'00'"); } }));
  const capturedAt = new Date(2026, 9, 31, 23, 59).toISOString();
  const pdf = await printer.print("<!doctype html><title>Script</title>", { capturedAt });
  assert.deepEqual(sent, ["<!doctype html><title>Script</title>"]);
  assert.ok(latin1(pdf).includes("/CreationDate (D:20261031000000" + offsetStamp(new Date(2026, 9, 31)) + ")"));
});

test("with no desktop bridge the printer refuses instead of printing in the browser", async () => {
  await assert.rejects(desktopPdfPrinter(() => null).print("<p>", { capturedAt: new Date().toISOString() }), /desktop is unavailable/);
});
