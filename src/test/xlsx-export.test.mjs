import "./_dom.mjs";
import { liveDoc } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { breakdownTable } from "../js/08-production-panels.js";
import { brollTable } from "../js/08d-broll-panel.js";
import { zipRead } from "../adapters/formats/zip.ts";
import { TAG_PRINT_COLORS } from "../adapters/formats/print-colors.ts";
import { PRINT_COLORS, exportDocumentOf } from "../js/14b-export-kit.js";
import { scriptTable } from "../js/16-csv.js";
import { buildBreakdownXlsx, buildBrollXlsx, buildScriptXlsx, colName } from "../js/16b-xlsx.js";
import { LONG_DEMO } from "../js/_starters.js";

initTags();
initStatus();

const demo = () => { S.state = migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state))); return S.state; };
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

async function open(bytes) {
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK");
  const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const names = zip.names;
  const parts = {};
  for (const n of names) parts[n] = new TextDecoder().decode(await zip.get(n));
  const text = (name) => {
    assert.ok(name in parts, "part " + name);
    return parts[name];
  };
  const xml = (name) => {
    const doc = new DOMParser().parseFromString(text(name), "application/xml");
    assert.equal(doc.getElementsByTagName("parsererror").length, 0, name + " parses");
    return doc;
  };
  const sst = [...xml("xl/sharedStrings.xml").getElementsByTagNameNS(MAIN, "si")].map((si) => si.textContent);
  const wb = xml("xl/workbook.xml");
  const sheets = [...wb.getElementsByTagNameNS(MAIN, "sheet")].map((s, i) => {
    const doc = xml("xl/worksheets/sheet" + (i + 1) + ".xml");
    const rows = [...doc.getElementsByTagNameNS(MAIN, "row")].map((r) => [...r.getElementsByTagNameNS(MAIN, "c")].map((c) => {
      const v = c.getElementsByTagNameNS(MAIN, "v")[0];
      if (!v) return "";
      return c.getAttribute("t") === "s" ? sst[Number(v.textContent)] : Number(v.textContent);
    }));
    const cells = [...doc.getElementsByTagNameNS(MAIN, "c")];
    return { name: s.getAttribute("name"), rows, doc, cells };
  });
  return { names, text, xml, sheets, wb, styles: xml("xl/styles.xml") };
}

function look(book, sheet, ref) {
  const c = sheet.cells.find((x) => x.getAttribute("r") === ref);
  const xf = [...book.styles.getElementsByTagNameNS(MAIN, "cellXfs")[0].getElementsByTagNameNS(MAIN, "xf")][Number(c.getAttribute("s") || 0)];
  const font = [...book.styles.getElementsByTagNameNS(MAIN, "fonts")[0].getElementsByTagNameNS(MAIN, "font")][Number(xf.getAttribute("fontId"))];
  const fill = [...book.styles.getElementsByTagNameNS(MAIN, "fills")[0].getElementsByTagNameNS(MAIN, "fill")][Number(xf.getAttribute("fillId"))];
  const fg = fill.getElementsByTagNameNS(MAIN, "fgColor")[0];
  const al = xf.getElementsByTagNameNS(MAIN, "alignment")[0];
  return {
    bold: font.getElementsByTagNameNS(MAIN, "b").length > 0,
    color: (font.getElementsByTagNameNS(MAIN, "color")[0].getAttribute("rgb") || "").slice(2),
    fill: fg ? fg.getAttribute("rgb").slice(2) : null,
    wrap: !!al && al.getAttribute("wrapText") === "1"
  };
}

const widths = (sheet) => [...sheet.doc.getElementsByTagNameNS(MAIN, "col")].map((c) => Number(c.getAttribute("width")));
const asText = (rows) => rows.map((r) => r.map((v) => (v === "" ? "" : String(v))));
const pad = (cells, n) => cells.concat(Array(Math.max(0, n - cells.length)).fill(""));

test("colName counts like Excel", () => {
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702].map(colName), ["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
});

test("the script's workbook: a sheet per part, each cell the .csv's", async () => {
  demo();
  const book = await open(buildScriptXlsx(liveDoc()));
  assert.deepEqual(book.sheets.map((s) => s.name), ["Script", "Comments", "Breakdown", "B-roll"]);
  for (const part of ["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "docProps/app.xml", "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/sharedStrings.xml"]) assert.ok(book.names.includes(part), part);
  assert.ok(book.text("[Content_Types].xml").includes("spreadsheetml.sheet.main+xml"));
  assert.ok(book.text("docProps/core.xml").includes("<dc:title>" + S.state.title + "</dc:title>"));
  assert.ok(/T00:00:00Z/.test(book.text("docProps/core.xml")), "stamped with the day only");

  const t = scriptTable(liveDoc());
  const script = book.sheets[0];
  assert.deepEqual(script.rows[0], t.head.concat(["Notes"]));
  const want = t.scenes.map((s) => s.cells).concat(t.summary).map((r) => pad(r, 11));
  assert.deepEqual(asText(script.rows.slice(1)), asText(want));
  assert.equal(script.rows.length, 1 + 30 + t.summary.length);
  const notes = script.cells.filter((c) => /^K\d+$/.test(c.getAttribute("r")) && c.getAttribute("r") !== "K1");
  assert.equal(notes.length, 30 + t.summary.length);
  assert.ok(notes.every((c) => !c.getElementsByTagNameNS(MAIN, "v").length && c.getAttribute("s")));

  const comments = book.sheets[1];
  assert.deepEqual(comments.rows[0], t.commentHead);
  assert.deepEqual(asText(comments.rows.slice(1)), asText(t.comments.map((c) => c.cells)));

  const bd = breakdownTable(exportDocumentOf(S.state));
  assert.deepEqual(asText(book.sheets[2].rows.slice(1)), asText(bd.rows.map((r) => r.cells)));
  assert.equal(typeof book.sheets[2].rows[1][4], "number");
  const br = brollTable(liveDoc());
  const opening = (s) => { s = String(s); return s.length <= 90 ? s : null; };
  book.sheets[3].rows.slice(1).forEach((row, i) => {
    const want = br.rows[i].cells;
    assert.deepEqual(asText([row.filter((_, c) => c !== 6)]), asText([want.filter((_, c) => c !== 6)]));
    if (opening(want[6]) !== null) assert.equal(row[6], want[6] === "" ? "" : want[6]);
    else {
      assert.ok(row[6].endsWith("…") && row[6].length <= 91, row[6]);
      assert.ok(want[6].startsWith(row[6].slice(0, -1)));
    }
  });
  assert.ok(br.rows.some((r) => r.cells[6].length > 90), "the demo has a long one to shorten");
});

test("clean to read: widths, wrapping, the heading frozen, filtered and printed on every page", async () => {
  demo();
  const book = await open(buildScriptXlsx(liveDoc()));
  const [script, comments, breakdown, broll] = book.sheets;
  assert.deepEqual(widths(script), [7, 9, 10, 8, 9, 46, 60, 32, 30, 11, 40]);
  assert.deepEqual(widths(comments), [6, 20, 18, 16, 18, 20, 36, 60]);
  assert.equal(widths(breakdown)[7], 44, "the breakdown's Notes has room");
  assert.equal(widths(broll)[8], 40, "the shot list's Note has room");
  for (const s of book.sheets) {
    const pane = s.doc.getElementsByTagNameNS(MAIN, "pane")[0];
    assert.equal(pane.getAttribute("state"), "frozen");
    assert.equal(pane.getAttribute("ySplit"), "1");
    assert.ok(s.doc.getElementsByTagNameNS(MAIN, "autoFilter")[0].getAttribute("ref").indexOf("A1:") === 0);
    const setup = s.doc.getElementsByTagNameNS(MAIN, "pageSetup")[0];
    assert.equal(setup.getAttribute("orientation"), "landscape");
    assert.equal(setup.getAttribute("fitToWidth"), "1");
    assert.equal(setup.getAttribute("fitToHeight"), "0");
  }
  assert.equal(script.doc.getElementsByTagNameNS(MAIN, "autoFilter")[0].getAttribute("ref"), "A1:K31");
  const defined = [...book.wb.getElementsByTagNameNS(MAIN, "definedName")].map((d) => d.getAttribute("name") + "@" + d.getAttribute("localSheetId") + "=" + d.textContent);
  assert.ok(defined.includes("_xlnm.Print_Titles@0='Script'!$1:$1"));
  assert.ok(defined.includes("_xlnm.Print_Titles@3='B-roll'!$1:$1"));
  assert.ok(defined.includes("_xlnm._FilterDatabase@0='Script'!$A$1:$K$31"));
  assert.deepEqual(look(book, script, "A1"), { bold: true, color: PRINT_COLORS.text, fill: PRINT_COLORS.surface2, wrap: true });
  assert.equal(look(book, script, "F1").color, PRINT_COLORS.visual);
  assert.equal(look(book, script, "G1").color, PRINT_COLORS.audio);
  assert.equal(look(book, script, "G2").wrap, true);
  const statusCell = (label) => {
    const i = script.rows.findIndex((r, n) => n > 0 && r[2] === label);
    return look(book, script, "C" + (i + 1));
  };
  assert.equal(statusCell("Shot").bold, true);
  assert.deepEqual([statusCell("Ready").color, statusCell("Ready").fill], [PRINT_COLORS.audio, PRINT_COLORS.audioSoft]);
  assert.equal(statusCell("To do").color, PRINT_COLORS.faint);
  assert.equal(look(book, script, "A32").bold, true);
  const propRow = breakdown.rows.findIndex((r, n) => n > 0 && r[0] === "Prop");
  assert.equal(look(book, breakdown, "A" + (propRow + 1)).color, TAG_PRINT_COLORS.prop);
  assert.equal(script.doc.getElementsByTagNameNS(MAIN, "sheetView")[0].getAttribute("tabSelected"), "1");
  assert.equal(broll.doc.getElementsByTagNameNS(MAIN, "sheetView")[0].getAttribute("tabSelected"), null);
});

test("the breakdown's and the shot list's own workbooks, and empty ones", async () => {
  demo();
  const bd = await open(buildBreakdownXlsx(liveDoc()));
  assert.deepEqual(bd.sheets.map((s) => s.name), ["Breakdown"]);
  assert.deepEqual(bd.sheets[0].rows[0], breakdownTable(exportDocumentOf(S.state)).head);
  const br = await open(buildBrollXlsx(liveDoc()));
  assert.deepEqual(br.sheets.map((s) => s.name), ["B-roll"]);
  assert.equal(br.sheets[0].rows.length, brollTable(liveDoc()).rows.length + 1);

  S.state = migrateRows({ schema: 2, title: "Bare", comments: [], rows: [{ id: "r1", visualText: "Wide", audioText: "Hello.", status: "todo" }] });
  const bare = await open(buildScriptXlsx(liveDoc()));
  assert.deepEqual(bare.sheets.map((s) => s.name), ["Script"], "no comments, tags or b-roll: just the script");
  assert.deepEqual((await open(buildBreakdownXlsx(liveDoc()))).sheets[0].rows[1][0], "(nothing labelled yet)");
  assert.deepEqual((await open(buildBrollXlsx(liveDoc()))).sheets[0].rows[1][0], "(no b-roll yet)");
});

test("a cell cut at Excel's limit and a shortened Cuts against never end in half an emoji (#434)", async () => {
  const grin = String.fromCodePoint(0x1F600);
  S.state = migrateRows({ schema: 2, title: "Cuts", comments: [], rows: [
    { id: "r1", visualText: '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> Pier', audioText: "x".repeat(32765) + grin + "yy", status: "todo" }
  ], brollShots: [{ id: "bs1", name: "Pier", audioRef: "x".repeat(89) + grin + "y", origin: "script" }] });
  const book = await open(buildScriptXlsx(liveDoc()));
  const script = book.sheets[0].rows[1].find((c) => typeof c === "string" && c.length > 30000);
  assert.equal(script, "x".repeat(32765) + "…");
  const broll = book.sheets.find((s) => s.name === "B-roll");
  assert.equal(broll.rows[1][6], "x".repeat(89) + "…");
  assert.ok(!book.text("xl/sharedStrings.xml").includes("�"));
});

test("awkward text survives: markup characters, line breaks, spaces at the ends, controls", async () => {
  S.state = migrateRows({ schema: 2, title: "Tom & Jerry's <cut>", comments: [], rows: [
    { id: "r1", visualText: "A &lt;b&gt; &amp; C<br>second line", audioText: "  padded  ", status: "ready" }
  ] });
  const book = await open(buildScriptXlsx(liveDoc()));
  const row = book.sheets[0].rows[1];
  assert.equal(row[5], "A <b> & C\nsecond line");
  assert.equal(row[2], "Ready");
  assert.ok(S.state.title.indexOf("Tom & Jerry's") === 0);
  assert.equal(book.xml("docProps/core.xml").getElementsByTagName("dc:title")[0].textContent, S.state.title);
});

function withClock(next, run) {
  const RealDate = globalThis.Date;
  class StubDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(next());
    }
    static now() { return next(); }
  }
  globalThis.Date = StubDate;
  try {
    return run();
  } finally {
    globalThis.Date = RealDate;
  }
}

const NOON = new Date(2030, 0, 2, 12, 0, 0).getTime();

test("two exports of one script are the same bytes", () => {
  demo();
  withClock(() => NOON, () => {
    assert.deepEqual(buildScriptXlsx(liveDoc()), buildScriptXlsx(liveDoc()));
    assert.deepEqual(buildBreakdownXlsx(liveDoc()), buildBreakdownXlsx(liveDoc()));
    assert.deepEqual(buildBrollXlsx(liveDoc()), buildBrollXlsx(liveDoc()));
  });
});

test("exports captured either side of a two-second boundary are the same bytes; the zip carries the captured day", () => {
  demo();
  let t = NOON;
  const ticking = () => { const at = t; t += 2000; return at; };
  const [a, b] = withClock(ticking, () => [buildScriptXlsx(liveDoc()), buildScriptXlsx(liveDoc())]);
  assert.deepEqual(a, b);
  const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(10, true), 0, "the entry time is midnight");
  assert.equal(view.getUint16(12, true), ((2030 - 1980) << 9) | (1 << 5) | 2, "the entry date is the captured day");
});
