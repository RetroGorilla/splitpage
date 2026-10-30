import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import { zipRead } from "../../../src/adapters/formats/zip.ts";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function column(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readWorkbook(bytes) {
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK");
  const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const parts = {};
  for (const name of zip.names) parts[name] = new TextDecoder().decode(await zip.get(name));
  const xml = (name) => {
    assert.ok(name in parts, "part " + name);
    const doc = new globalThis.DOMParser().parseFromString(parts[name], "application/xml");
    assert.equal(doc.getElementsByTagName("parsererror").length, 0, name + " parses");
    return doc;
  };
  const shared = [...xml("xl/sharedStrings.xml").getElementsByTagNameNS(MAIN, "si")].map((si) => si.textContent);
  const sheets = [...xml("xl/workbook.xml").getElementsByTagNameNS(MAIN, "sheet")].map((sheet, i) => {
    const rows = [...xml("xl/worksheets/sheet" + (i + 1) + ".xml").getElementsByTagNameNS(MAIN, "row")].map((row) => {
      const cells = [];
      for (const c of row.getElementsByTagNameNS(MAIN, "c")) {
        const v = c.getElementsByTagNameNS(MAIN, "v")[0];
        cells[column(c.getAttribute("r"))] = !v ? "" : c.getAttribute("t") === "s" ? shared[Number(v.textContent)] : Number(v.textContent);
      }
      return Array.from(cells, (cell) => (cell === undefined ? "" : cell));
    });
    return { name: sheet.getAttribute("name"), rows };
  });
  return { names: zip.names, text: (name) => parts[name], xml, sheets };
}

export function sheetNamed(book, name) {
  const sheet = book.sheets.find((s) => s.name === name);
  assert.ok(sheet, "sheet " + name);
  return sheet;
}

export function recordsOf(sheet) {
  const [head, ...rows] = sheet.rows;
  return rows.map((row) => Object.fromEntries(head.map((h, i) => [h, row[i] === undefined ? "" : row[i]])));
}
