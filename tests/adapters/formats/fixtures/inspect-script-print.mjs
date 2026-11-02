import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { log } from "node:console";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

const LAYOUT_TOLERANCE_PT = 1;
const PAPER_SAFE_BORDER_PT = 12;

function emptyHeadroom() {
  return {ink:{left:Infinity,right:Infinity,top:Infinity,bottom:Infinity},layoutOverhang:0};
}

function measureHeadroom(report) {
  const result = emptyHeadroom();
  for (const page of report.pages) for (const line of page.lines.filter((entry) => entry.text.trim())) {
    if (line.ink) {
      result.ink.left = Math.min(result.ink.left,line.ink.left);
      result.ink.right = Math.min(result.ink.right,page.width-line.ink.right);
      result.ink.top = Math.min(result.ink.top,line.ink.top);
      result.ink.bottom = Math.min(result.ink.bottom,page.height-line.ink.bottom);
    }
    const footer = line.mcid === null;
    result.layoutOverhang = Math.max(result.layoutOverhang,43.2-line.layout.left,line.layout.right-(page.width-43.2),
      (footer ? page.height-43.2 : 43.2)-line.layout.top,line.layout.bottom-(footer ? page.height : page.height-43.2));
  }
  return result;
}

function pdfTokens(source) {
  return Array.from(source.matchAll(/%[^\r\n]*|\((?:\\[\s\S]|[^\\()])*\)|<[\da-fA-F\s]*>|<<|>>|\[|\]|\/[^\s<>[\]()]+|[^\s<>[\]()]+/g), (match) => match[0])
    .filter((token) => !token.startsWith("%"));
}

function pdfValue(tokens, cursor) {
  const token = tokens[cursor.index++];
  if (token === "<<") {
    const value = {};
    while (tokens[cursor.index] !== ">>") {
      assert.ok(cursor.index < tokens.length, "Unterminated PDF dictionary");
      const key = tokens[cursor.index++];
      assert.ok(key.startsWith("/"), "Expected PDF dictionary key");
      value[key.slice(1)] = pdfValue(tokens, cursor);
    }
    cursor.index++;
    return value;
  }
  if (token === "[") {
    const value = [];
    while (tokens[cursor.index] !== "]") {
      assert.ok(cursor.index < tokens.length, "Unterminated PDF array");
      value.push(pdfValue(tokens, cursor));
    }
    cursor.index++;
    return value;
  }
  if (/^[+-]?(?:\d*\.)?\d+$/.test(token)) {
    if (/^\d+$/.test(tokens[cursor.index]) && tokens[cursor.index + 1] === "R") {
      cursor.index += 2;
      return { ref: Number(token) };
    }
    return Number(token);
  }
  return token;
}

function unicodeHex(hex) {
  const bytes = Buffer.from(hex.replace(/[<>\s]/g, ""), "hex");
  assert.equal(bytes.length % 2, 0, "Expected UTF-16BE text");
  return bytes.swap16().toString("utf16le").replace(/^\uFEFF/, "");
}

function actualText(value) {
  if (value.startsWith("<")) return unicodeHex(value);
  const text = value.slice(1,-1).replace(/\\([0-7]{1,3}|\r\n|[\s\S])/g, (_, escaped) => {
    if (/^[0-7]+$/.test(escaped)) return String.fromCharCode(parseInt(escaped,8));
    if (/^[\r\n]/.test(escaped)) return "";
    return ({n:"\n",r:"\r",t:"\t",b:"\b",f:"\f"})[escaped] ?? escaped;
  });
  return text.startsWith("\xFE\xFF") ? unicodeHex(Buffer.from(text,"latin1").toString("hex")) : text;
}

function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

export function readPrintedPages(bytes) {
  const source = bytes.toString("latin1");
  const objects = new Map();
  const pattern = /(\d+) 0 obj\s*/g;
  let match;
  while ((match = pattern.exec(source))) {
    const start = pattern.lastIndex;
    const end = source.indexOf("endobj", start);
    assert.ok(end >= start, "Unterminated PDF object");
    const body = source.slice(start, end);
    const streamAt = body.indexOf("stream");
    const value = pdfValue(pdfTokens(streamAt < 0 ? body : body.slice(0, streamAt)), { index: 0 });
    let stream = null;
    if (streamAt >= 0) {
      assert.equal(typeof value.Length, "number", "Expected direct stream length");
      const offset = start + streamAt + (/^stream\r\n/.test(body.slice(streamAt)) ? 8 : 7);
      const raw = bytes.subarray(offset, offset + value.Length);
      if (value.Filter === "/FlateDecode") stream = inflateSync(raw).toString("latin1");
      else if (!value.Filter) stream = raw.toString("latin1");
      pattern.lastIndex = source.indexOf("endobj", offset + value.Length) + 6;
    } else pattern.lastIndex = end + 6;
    objects.set(Number(match[1]), { value, stream });
  }
  const resolve = (value) => value?.ref ? objects.get(value.ref)?.value : value;
  const fonts = new Map();
  for (const [id, object] of objects) {
    const font = object.value;
    if (font.Type !== "/Font" || !font.ToUnicode) continue;
    const cmap = objects.get(font.ToUnicode.ref).stream;
    const chars = new Map();
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const entry of block[1].matchAll(/<([\da-fA-F]+)>\s*<([\da-fA-F]+)>/g)) chars.set(parseInt(entry[1], 16), unicodeHex(entry[2]));
    }
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const entry of block[1].matchAll(/<([\da-fA-F]+)>\s*<([\da-fA-F]+)>\s*(<([\da-fA-F]+)>|\[([^\]]*)\])/g)) {
        const first = parseInt(entry[1], 16), last = parseInt(entry[2], 16);
        const values = entry[5] ? Array.from(entry[5].matchAll(/<([\da-fA-F]+)>/g), (item) => unicodeHex(item[1])) : null;
        for (let code = first; code <= last; code++) chars.set(code, values ? values[code - first] : unicodeHex((parseInt(entry[4], 16) + code - first).toString(16).padStart(entry[4].length, "0")));
      }
    }
    const descendant = resolve(font.DescendantFonts?.[0]) || font;
    const widths = new Map();
    const entries = descendant.W || [];
    for (let index = 0; index < entries.length;) {
      const first = entries[index++], next = entries[index++];
      if (Array.isArray(next)) next.forEach((width, offset) => widths.set(first + offset, width));
      else {
        const width = entries[index++];
        for (let code = first; code <= next; code++) widths.set(code, width);
      }
    }
    font.Widths?.forEach((width, index) => widths.set(font.FirstChar + index, width * (font.FontMatrix?.[0] || 0.001) * 1000));
    const codeBytes = /begincodespacerange\s*<([\da-fA-F]+)>/.exec(cmap)[1].length / 2;
    const descriptor = resolve(descendant.FontDescriptor);
    const fontBytes = descriptor?.FontFile2 ? Buffer.from(objects.get(descriptor.FontFile2.ref).stream, "latin1") : null;
    const tables = new Map();
    if (fontBytes) for (let index = 0; index < fontBytes.readUInt16BE(4); index++) {
      const offset = 12 + index * 16;
      tables.set(fontBytes.toString("ascii", offset, offset + 4), fontBytes.readUInt32BE(offset + 8));
    }
    function glyphBounds(code) {
      if (fontBytes) {
        const head = tables.get("head"), loca = tables.get("loca"), glyf = tables.get("glyf");
        const long = fontBytes.readInt16BE(head + 50) === 1;
        const offset = long ? fontBytes.readUInt32BE(loca + code * 4) : fontBytes.readUInt16BE(loca + code * 2) * 2;
        const next = long ? fontBytes.readUInt32BE(loca + (code + 1) * 4) : fontBytes.readUInt16BE(loca + (code + 1) * 2) * 2;
        if (offset === next) return null;
        const units = fontBytes.readUInt16BE(head + 18);
        return [2, 4, 6, 8].map((index) => fontBytes.readInt16BE(glyf + offset + index) / units);
      }
      if (font.Subtype !== "/Type3") {
        assert.ok(descriptor?.FontFile3, "Expected embedded TrueType, CFF or Type3 font");
        return [0, descriptor.Descent / 1000, (widths.get(code) ?? descendant.DW) / 1000, descriptor.Ascent / 1000];
      }
      const box = font.FontBBox, matrix = font.FontMatrix;
      return [box[0] * matrix[0], box[3] * matrix[3], box[2] * matrix[0], box[1] * matrix[3]];
    }
    fonts.set(id, { chars, widths, codeBytes, glyphBounds, defaultWidth: descendant.DW ?? 1000,
      name:font.BaseFont || descriptor?.FontName || "unnamed",
      metricSource:fontBytes ? "glyf" : font.Subtype === "/Type3" ? "font bbox fallback (Type3)" : "CFF advance/ascent/descent",
      ascent:typeof descriptor.Ascent === "number" ? descriptor.Ascent / 1000 : Math.max(font.FontBBox[1]*font.FontMatrix[3],font.FontBBox[3]*font.FontMatrix[3]),
      descent:typeof descriptor.Descent === "number" ? descriptor.Descent / 1000 : Math.min(font.FontBBox[1]*font.FontMatrix[3],font.FontBBox[3]*font.FontMatrix[3]),
      layoutMetricSource:typeof descriptor.Ascent === "number" ? "advance/ascent/descent" : "advance/font bbox vertical fallback (Type3)" });
  }
  const catalog = Array.from(objects.values()).find((object) => object.value.Type === "/Catalog").value;
  const pageIds = [];
  function walkPages(ref) {
    const page = resolve(ref);
    if (page.Type === "/Page") pageIds.push(ref.ref);
    else page.Kids.forEach(walkPages);
  }
  walkPages(catalog.Pages);
  const identity = [1, 0, 0, 1, 0, 0];
  const pages = pageIds.map((pageId, pageIndex) => {
    const page = objects.get(pageId).value;
    const resources = resolve(page.Resources);
    const lines = [];
    let state = { matrix: identity, font: null, size: 0 };
    const stack = [], marked = [];
    let textMatrix = identity, lineMatrix = identity;
    const content = (Array.isArray(page.Contents) ? page.Contents : [page.Contents]).map((ref) => objects.get(ref.ref).stream).join("\n");
    const tokens = pdfTokens(content), cursor = { index: 0 }, args = [];
    while (cursor.index < tokens.length) {
      const token = tokens[cursor.index];
      if (token.startsWith("/") || token.startsWith("<") || token.startsWith("(") || token === "[" || /^[+-]?(?:\d*\.)?\d+$/.test(token)) {
        args.push(pdfValue(tokens, cursor));
        continue;
      }
      cursor.index++;
      if (token === "q") stack.push({ ...state });
      else if (token === "Q") { state = stack.pop(); assert.ok(state, "Unbalanced PDF graphics state"); }
      else if (token === "cm") state.matrix = multiply(state.matrix, args);
      else if (token === "BT") textMatrix = lineMatrix = identity;
      else if (token === "Tf") { state.font = fonts.get(resolve(resources.Font)[args[0].slice(1)].ref); state.size = args[1]; }
      else if (token === "Tm") textMatrix = lineMatrix = args.slice();
      else if (token === "Td" || token === "TD") textMatrix = lineMatrix = multiply(lineMatrix, [1, 0, 0, 1, args[0], args[1]]);
      else if (token === "BDC") marked.push({ ...args[1], emitted: false });
      else if (token === "BMC") marked.push({});
      else if (token === "EMC") marked.pop();
      else if (token === "Tj" || token === "TJ") {
        assert.ok(state.font, "Missing PDF font map");
        for (const part of token === "TJ" ? args[0] : [args[0]]) {
          if (typeof part === "number") { textMatrix = multiply(textMatrix, [1, 0, 0, 1, -part * state.size / 1000, 0]); continue; }
          assert.ok(part.startsWith("<"), "Expected Chromium hexadecimal glyph string");
          const glyphs = Buffer.from(part.slice(1, -1).replace(/\s/g, ""), "hex");
          const codes = [];
          for (let offset = 0; offset < glyphs.length; offset += state.font.codeBytes) codes.push(glyphs.readUIntBE(offset, state.font.codeBytes));
          const actual = marked.findLast((item) => item.ActualText);
          const text = actual ? (actual.emitted ? "" : actualText(actual.ActualText)) : codes.map((code) => state.font.chars.get(code) ?? "\uFFFD").join("");
          if (actual) actual.emitted = true;
          const matrix = multiply(state.matrix, textMatrix);
          const width = codes.reduce((sum, code) => sum + (state.font.widths.get(code) ?? state.font.defaultWidth), 0) * state.size / 1000;
          const layout = [[0,state.font.descent*state.size], [width,state.font.descent*state.size],
            [0,state.font.ascent*state.size], [width,state.font.ascent*state.size]].map(([x,y]) =>
            [matrix[0]*x+matrix[2]*y+matrix[4], page.MediaBox[3]-(matrix[1]*x+matrix[3]*y+matrix[5])]);
          let advance = 0;
          const corners = codes.flatMap((code) => {
            const box = state.font.glyphBounds(code);
            const points = box ? [[box[0], box[1]], [box[0], box[3]], [box[2], box[1]], [box[2], box[3]]]
              .map(([x, y]) => {
                const localX = advance + x * state.size, localY = y * state.size;
                return [matrix[0] * localX + matrix[2] * localY + matrix[4],
                  page.MediaBox[3] - (matrix[1] * localX + matrix[3] * localY + matrix[5])];
              }) : [];
            advance += (state.font.widths.get(code) ?? state.font.defaultWidth) * state.size / 1000;
            return points;
          });
          lines.push({ text, x: matrix[4], y: page.MediaBox[3] - matrix[5],
            font:state.font.name, metricSource:state.font.metricSource, layoutMetricSource:state.font.layoutMetricSource,
            width: Math.abs(matrix[0] * width), height: Math.abs(matrix[3] * state.size),
            layout: {left:Math.min(...layout.map((point) => point[0])), right:Math.max(...layout.map((point) => point[0])),
              top:Math.min(...layout.map((point) => point[1])), bottom:Math.max(...layout.map((point) => point[1]))},
            ink: corners.length ? {left:Math.min(...corners.map((point) => point[0])), right:Math.max(...corners.map((point) => point[0])),
              top:Math.min(...corners.map((point) => point[1])), bottom:Math.max(...corners.map((point) => point[1]))} : null,
            mcid: marked.findLast((item) => item.MCID !== undefined)?.MCID ?? null, notdef: codes.includes(0) });
          textMatrix = multiply(textMatrix, [1, 0, 0, 1, width, 0]);
        }
      }
      args.length = 0;
    }
    return { number: pageIndex + 1, id: pageId, width: page.MediaBox[2], height: page.MediaBox[3], lines };
  });
  const elements = [];
  function walkStructure(ref, inheritedPage = null, ancestors = []) {
    const node = resolve(ref);
    if (!node || typeof node !== "object") return;
    const page = node.Pg?.ref ?? inheritedPage;
    const element = node.Type === "/StructElem" ? { id: ref.ref, role: node.S, ancestors, marks: [] } : null;
    if (element) elements.push(element);
    const parents = element ? [...ancestors, element.id] : ancestors;
    for (const child of Array.isArray(node.K) ? node.K : [node.K]) {
      if (typeof child === "number" || child?.Type === "/MCR") {
        const mark = { page: child?.Pg?.ref ?? page, mcid: typeof child === "number" ? child : child.MCID };
        for (const id of parents) elements.find((item) => item.id === id).marks.push(mark);
      } else if (child?.ref) walkStructure(child, page, parents);
    }
  }
  walkStructure(catalog.StructTreeRoot);
  return { pages, elements };
}

export function checkPrintedRows(report, rows) {
  const printedRows = report.elements.filter((element) => element.role === "/TR");
  assert.equal(printedRows.length, rows.length, "Every fixture row must have a PDF structure row");
  const oversized = [];
  for (const [index, row] of printedRows.entries()) {
    if (rows[index].header) continue;
    const pages = report.pages.filter((page) => row.marks.some((mark) => mark.page === page.id));
    assert.ok(pages.length, `Row ${index + 1} is missing from the PDF`);
    const available = Math.min(...pages.map((page) => page.height - 86.4));
    if (rows[index].height * 0.75 > available) {
      oversized.push(`row ${index + 1}: ${(rows[index].height * 0.75).toFixed(1)}pt exceeds ${available.toFixed(1)}pt`);
      continue;
    }
    assert.equal(pages.length, 1,
      `No split rows: row ${index + 1} (${rows[index].text.slice(0, 90)}) is ${(rows[index].height * 0.75).toFixed(1)}pt tall but spans pages ${pages.map((page) => page.number).join(", ")}`);
  }
  return oversized;
}

function elementLines(report, element) {
  const seen = new Set();
  return element.marks.flatMap((mark) => {
    const key = `${mark.page}:${mark.mcid}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const page = report.pages.find((entry) => entry.id === mark.page);
    return page ? page.lines.filter((line) => line.mcid === mark.mcid && line.text.trim())
      .map((line) => ({ ...line, page: page.number })) : [];
  });
}

function compactText(text) {
  return text.normalize("NFKC").replace(/\s/gu, "").replace(/\u200b|\u200e|\u200f|\ufe0f/gu, "");
}

function logicalText(lines) {
  const result = [];
  let rtl = [];
  const flush = () => {
    result.push(rtl.sort((a, b) => b.x - a.x).map((line) => line.text).join(""));
    rtl = [];
  };
  for (const line of lines) {
    if (/^[\u0600-\u06ff\s]+$/u.test(line.text.normalize("NFKC")) && line.text.trim()) {
      if (rtl.length && (line.page !== rtl[0].page || Math.abs(line.y - rtl[0].y) > 1)) flush();
      rtl.push(line);
    } else {
      flush();
      result.push(line.text);
    }
  }
  flush();
  return result.join("");
}

export function checkPrintedLayout(report, model, only = null) {
  const rows = report.elements.filter((element) => element.role === "/TR");
  const parents = new Set(report.elements.flatMap((element) => element.ancestors));
  const leaves = report.elements.filter((element) => !parents.has(element.id));
  const check = (rule, operation) => { if (!only || only.split("-")[0] === rule) operation(); };
  let oversized = [];
  check("a", () => {
    const headings = report.elements.filter((element) => /^\/H[1-6]$/.test(element.role));
    assert.equal(headings.length, model.headings.length, "a: every section heading is tagged");
    for (const heading of headings) {
      const lines = elementLines(report, heading);
      assert.ok(lines.length, "a: heading text is present");
      const lastIndex = Math.max(...report.elements.flatMap((element, index) =>
        element.id === heading.id || element.ancestors.includes(heading.id) ? [index] : []));
      const next = report.elements.slice(lastIndex + 1).find((element) => !parents.has(element.id) && elementLines(report, element).length);
      if (next) assert.equal(elementLines(report, next)[0].page, lines.at(-1).page,
        `a: stranded heading ${lines.map((line) => line.text).join("")} on page ${lines.at(-1).page}`);
    }
    for (const [index, row] of rows.entries()) {
      if (model.rows[index].group) {
        assert.ok(rows[index + 1], "a: group has an introduced row");
        assert.equal(elementLines(report, row).at(-1)?.page, elementLines(report, rows[index + 1])[0]?.page,
          `a: stranded list group ${model.rows[index].text} at row ${index + 1}`);
      }
      if (model.rows[index].scene) {
        const cells = report.elements.filter((element) => element.role === "/TD" && element.ancestors.at(-1) === row.id);
        const introduced = cells.slice(1, 3).flatMap((cell) => elementLines(report, cell)).sort((a, b) => a.page - b.page || a.y - b.y);
        if (introduced.length) assert.equal(elementLines(report, cells[0])[0]?.page, introduced[0].page,
          `a: stranded scene heading at row ${index + 1}`);
      }
    }
  });
  check("b", () => { oversized = checkPrintedRows(report, model.rows); });
  check("c", () => {
    for (const table of model.tables) {
      const bodyPages = new Set(table.body.flatMap((index) => elementLines(report, rows[index]).map((line) => line.page)));
      for (const number of bodyPages) {
        const header = table.head.flatMap((index) => elementLines(report, rows[index]).filter((line) => line.page === number));
        assert.equal(compactText(header.map((line) => line.text).join("")), compactText(table.text),
          `c: missing repeated table header on page ${number}`);
      }
    }
  });
  check("d", () => {
    for (const page of report.pages) for (const line of page.lines.filter((entry) => entry.text.trim())) {
      const footer = line.mcid === null;
      const top = footer ? page.height - 43.2 : 43.2;
      const bottom = footer ? page.height : page.height - 43.2;
      function inside(box, rect, tolerance) {
        return !box || box.left >= rect[0]-tolerance && box.right <= rect[1]+tolerance && box.top >= rect[2]-tolerance && box.bottom <= rect[3]+tolerance;
      }
      function diagnostic(half, box, rect, metrics) {
        return `d: ${half} overflow; text=${JSON.stringify(line.text)}; fixture=${model.fixture || "unknown"}; page=${page.number}; ` +
          `box(x0,x1,y0,y1)=${JSON.stringify(box && [box.left,box.right,box.top,box.bottom])}; ` +
          `allowed ${half === "ink" ? "paper-safe border" : footer ? "footer margin box" : "content area"}(x0,x1,y0,y1)=${JSON.stringify(rect)}; ` +
          `tolerance=${half === "layout" ? LAYOUT_TOLERANCE_PT : 0}pt; font=${line.font}; metrics=${metrics}`;
      }
      const content = [43.2,page.width-43.2,top,bottom];
      const paper = [PAPER_SAFE_BORDER_PT,page.width-PAPER_SAFE_BORDER_PT,PAPER_SAFE_BORDER_PT,page.height-PAPER_SAFE_BORDER_PT];
      if (only !== "d-ink") assert.ok(inside(line.layout, content, LAYOUT_TOLERANCE_PT), diagnostic("layout", line.layout, content, line.layoutMetricSource));
      if (only !== "d-layout") assert.ok(inside(line.ink, paper, 0), diagnostic("ink", line.ink, paper, line.metricSource));
    }
  });
  check("e", () => {
    for (const page of report.pages) for (const line of page.lines) {
      assert.ok(!line.notdef && !line.text.includes(String.fromCharCode(0)) && !line.text.includes("\uFFFD"), `e: missing glyph on page ${page.number}; font=${line.font}; text=${JSON.stringify(line.text)}`);
    }
    const text = leaves.map((element) => {
      let lines = elementLines(report, element);
      if (element.ancestors.some((id) => report.elements.find((entry) => entry.id === id)?.role === "/TH")) {
        lines = lines.filter((line) => line.page === lines[0]?.page);
      }
      return logicalText(lines);
    }).join("");
    const expected = compactText(model.text), actual = compactText(text);
    let mismatch = 0;
    while (mismatch < expected.length && expected[mismatch] === actual[mismatch]) mismatch++;
    assert.equal(actual, expected, `e: fixture text differs at character ${mismatch}`);
  });
  check("f", () => {
    for (const page of report.pages) {
      const footer = page.lines.filter((line) => line.mcid === null);
      const pageNumber = footer.filter((line) => line.x > page.width * 0.65).map((line) => line.text).join("");
      const title = logicalText(footer.filter((line) => line.x <= page.width * 0.65));
      assert.equal(compactText(pageNumber), compactText(`Page ${page.number} of ${report.pages.length}`), `f: footer counter on page ${page.number}`);
      assert.equal(compactText(title), compactText(model.title), `f: running title on page ${page.number}`);
    }
  });
  check("g", () => {
    const orientation = new Map();
    function record(element, landscape) {
      for (const mark of element.marks) {
        if (orientation.has(mark.page)) assert.equal(orientation.get(mark.page), landscape, "g: sections with different orientations share a page");
        orientation.set(mark.page, landscape);
      }
    }
    rows.forEach((row, index) => record(row, model.rows[index].landscape));
    report.elements.filter((element) => /^\/H[1-6]$/.test(element.role))
      .forEach((heading, index) => record(heading, model.headings[index].landscape));
    for (const page of report.pages) {
      const portrait = page.width === 612 && page.height === 792;
      const landscape = page.width === 792 && page.height === 612;
      const expected = orientation.get(page.id) ?? model.orientation === "landscape";
      assert.ok(expected ? landscape : portrait,
        `g: incorrect page size or orientation on page ${page.number}: ${page.width}x${page.height}`);
    }
    if (model.orientation === "mixed") {
      assert.ok(report.pages.some((page) => page.width === 612) && report.pages.some((page) => page.width === 792), "g: mixed script retains portrait and landscape pages");
    }
  });
  return oversized;
}

function chromiumExecutable() {
  if (process.env.SPLITPAGE_CHROME) return process.env.SPLITPAGE_CHROME;
  if (process.platform === "win32") return join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe");
  const cache = process.env.RUNNER_TOOL_CACHE && join(process.env.RUNNER_TOOL_CACHE, "splitpage-playwright");
  function findChrome(directory, depth) {
    if (!existsSync(directory)) return null;
    for (const name of readdirSync(directory).sort().reverse()) {
      const path = join(directory, name);
      if (name === "chrome" && statSync(path).isFile()) return path;
      if (depth > 0 && statSync(path).isDirectory()) {
        const found = findChrome(path, depth - 1);
        if (found) return found;
      }
    }
    return null;
  }
  const pinned = cache && process.env.PLAYWRIGHT_VERSION && findChrome(join(cache, process.env.PLAYWRIGHT_VERSION), 3);
  const cached = pinned || cache && findChrome(cache, 4);
  if (cached) return cached;
  try { return execFileSync("sh", ["-c", "command -v google-chrome || command -v chrome"], {encoding:"utf8"}).trim(); }
  catch { throw new Error("Set SPLITPAGE_CHROME to an installed Chromium executable"); }
}

export async function inspectPrintedFixtures(options = {}) {

const out = options.out ?? process.argv[2];
const lists = options.lists ?? process.argv.includes("--lists");
assert.ok(out, "Pass an output directory");
mkdirSync(out, { recursive: true });
log("Printed PDF artifacts: " + out);
const chrome = chromiumExecutable();
assert.ok(existsSync(chrome), "Set SPLITPAGE_CHROME to a Chromium executable");
const browser = spawn(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
  ...(process.env.SPLITPAGE_CHROME_ARGS || "").split(/\s+/).filter(Boolean),
  "--remote-debugging-port=" + (process.env.PRINT_CDP_PORT || "0"), "--user-data-dir=" + join(out, "profile"), "about:blank"],
{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let ws;
const pending = new Map();
let id = 0;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chromium endpoint timed out")), 30000);
    browser.once("error", reject);
    browser.stderr.on("data", (data) => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(String(data));
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const targetList = endpoint.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*/, "/json/list");
  const deadline = Date.now() + 10000;
  let page;
  while (!page && Date.now() < deadline) {
    let targets;
    try {
      targets = await (await globalThis.fetch(targetList, {
        signal:globalThis.AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      })).json();
    } catch (error) {
      if (error.name === "TimeoutError") break;
      throw error;
    }
    page = targets.find((target) => target.type === "page");
    if (!page) await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  assert.ok(page, "No Chromium page target");
  ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  await once(ws, "open");
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + " timed out")); }, 30000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { media: "print" });
  await send("Emulation.setDeviceMetricsOverride", { width: 701, height: 940, deviceScaleFactor: 1, mobile: false });
  let checks = 0;
  const records = [];
  const headroom = emptyHeadroom();
  const cases = options.cases || (lists ? ["prop-rich", "gear-rich", "shots-rich", "script-rich", "prop-empty", "gear-empty", "shots-empty", "script-empty",
    "prop-long", "gear-long", "shots-long", "script-long", "flagged-location", "shot-person", "unshot-scene"] : ["rich", "empty", "long"]);
  async function captureModel() {
    return evaluate(`(() => {
      const allRows = Array.from(document.querySelectorAll('tr'));
      const rows = allRows.map(row => {
        const main = document.querySelector('main');
        main.style.width = row.closest('.shot-list') ? '9.8in' : '7.3in';
        const value = {header:!!row.closest('thead'), landscape:!!row.closest('.shot-list'), group:row.classList.contains('list-group'), scene:!!row.querySelector('.scene-number'), height:row.getBoundingClientRect().height, text:row.textContent.trim()};
        main.style.removeProperty('width');
        return value;
      });
      const shot = !!document.querySelector('.shot-list');
      const orientation = shot ? (document.querySelectorAll('main > section').length > 1 ? 'mixed' : 'landscape') : 'portrait';
      return {rows, orientation, title:document.title, text:document.querySelector('main').textContent,
        headings:Array.from(document.querySelectorAll('h1,h2,h3'), e=>({text:e.textContent,landscape:!!e.closest('section').querySelector('.shot-list')})),
        tables:Array.from(document.querySelectorAll('table'), table=>({
          head:Array.from(table.querySelectorAll('thead tr'), row=>allRows.indexOf(row)),
          body:Array.from(table.querySelectorAll('tr:not(thead tr)'), row=>allRows.indexOf(row)),
          text:table.querySelector('thead').textContent
        }))};
    })()`);
  }
  async function load(kind) {
    const path = fileURLToPath(new globalThis.URL(`_${lists ? "list" : "script"}-print-${kind}.html`, import.meta.url));
    await send("Page.navigate", { url: pathToFileURL(path).href });
    await evaluate(`new Promise(resolve => { const ready = async () => { await document.fonts.ready; await Promise.all(Array.from(document.images, i => i.decode())); resolve(true); }; if (document.readyState === 'complete') ready(); else addEventListener('load', ready, {once:true}); })`);
  }
  for (const kind of cases) {
    await load(kind);
    const result = await evaluate(`({print:matchMedia('print').matches,width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,cells:Array.from(document.querySelectorAll('td')).every(e=>e.scrollWidth<=e.clientWidth+1),images:Array.from(document.images).every(e=>e.naturalWidth>0&&e.getBoundingClientRect().width<=e.parentElement.getBoundingClientRect().width),text:document.querySelector('main').textContent})`);
    assert.equal(result.print, true); checks++;
    assert.equal(result.scroll, result.width); checks++;
    assert.equal(result.cells, true); checks++;
    assert.equal(result.images, true); checks++;
    if (!lists && kind.endsWith("long")) {
      assert.match(result.text, /Visual line 179/); checks++;
      assert.match(result.text, /Audio line 159/); checks++;
      assert.match(result.text, /Scene 18 audio/); checks++;
    }
    if (lists) {
      if (kind.endsWith("long")) {
        if (kind.startsWith("prop") || kind.startsWith("script")) { assert.match(result.text, /Packing note line 99/); checks++; }
        if (kind.startsWith("shots") || kind.startsWith("script")) { assert.match(result.text, /Shot description line 109/); checks++; }
        if (kind.startsWith("gear")) { assert.match(result.text, /Spare 089/); checks++; }
      }
      if (kind === "script-rich" || kind === "script-long") {
        assert.match(result.text, /End reply/); checks++;
        const order = await evaluate("Array.from(document.querySelectorAll('section'), e => e.id)");
        assert.deepEqual(order, ["script", "production-breakdown", "broll-shot-list", "comments"]); checks++;
      }
      const layout = await evaluate("({heads:Array.from(document.querySelectorAll('thead'), e=>getComputedStyle(e).display),landscape:!!document.querySelector('.shot-list')&&getComputedStyle(document.querySelector('#broll-shot-list')).page,boxes:document.querySelectorAll('.list-checkbox').length})");
      assert.ok(layout.heads.every((display) => display === "table-header-group")); checks++;
      if (kind.startsWith("shots") || kind === "script-rich" || kind === "script-long") { assert.equal(layout.landscape, "shot-list"); checks++; }
    }
    const pdf = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true, generateTaggedPDF: true });
    const bytes = Buffer.from(pdf.data, "base64");
    const pages = (bytes.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
    assert.ok(lists ? (kind.endsWith("long") ? pages >= 2 : pages >= 1) : kind.endsWith("long") ? pages >= 5 : pages === (kind === "empty" ? 1 : 2), `${kind}: ${pages} pages`); checks++;
    if (lists && (kind.startsWith("shots") || kind.startsWith("script") && !kind.endsWith("empty"))) {
      assert.match(bytes.toString("latin1"), /\/MediaBox \[0 0 792 612\]/); checks++;
    }
    if (lists && kind.startsWith("script")) { assert.match(bytes.toString("latin1"), /\/MediaBox \[0 0 612 792\]/); checks++; }
    writeFileSync(join(out, kind + ".pdf"), bytes);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(out, kind + ".png"), Buffer.from(shot.data, "base64"));
    const report = readPrintedPages(bytes);
    writeFileSync(join(out, kind + "-pages.json"), JSON.stringify(report, null, 2));
    const model = await captureModel();
    model.fixture = `${lists ? "list" : "script"}/${kind}`;
    writeFileSync(join(out, kind + "-model.json"), JSON.stringify(model, null, 2));
    const measured = measureHeadroom(report);
    for (const edge of ["left","right","top","bottom"]) headroom.ink[edge] = Math.min(headroom.ink[edge],measured.ink[edge]);
    headroom.layoutOverhang = Math.max(headroom.layoutOverhang,measured.layoutOverhang);
    let oversized;
    try {
      oversized = checkPrintedLayout(report, model); checks += 7;
    } catch (error) {
      error.message = `${kind}: ${error.message}`;
      writeFileSync(join(out, "summary.txt"), records.join("\n") + `\nSTOP: ${error.message}\n`);
      throw error;
    }
    records.push(...oversized.map((row) => `${kind}: oversized ${row}; splitting permitted`));
    records.push(`${kind}: ${pages} printed pages; print media, cell wrapping, image bounds and horizontal clipping passed`);
  }
  if (options.probes || process.argv.includes("--probes")) {
    const probes = [
      {rule:"a", kind:lists ? "prop-empty" : "empty", css:"main > section > h1 { break-after:auto; } main > section > h1 + p { break-before:page; }"},
      ...(lists ? [{rule:"b", kind:"prop-rich", splitRow:true, css:"tr { break-inside:auto; }"},
        {rule:"c", kind:"gear-long", css:"thead { display:table-row-group; }"}] : []),
      {rule:"d", kind:lists ? "prop-rich" : "rich", css:"main { transform:translateX(-60pt); }"},
      {rule:"d", part:"d-layout", kind:lists ? "prop-rich" : "rich", css:`@page { @bottom-right { content:"${"W".repeat(200)}"; } }`},
      {rule:"d", part:"d-ink", kind:lists ? "prop-rich" : "rich", css:'@page { @bottom-right { content:"X"; vertical-align:bottom; } }'},
      {rule:"e", kind:lists ? "prop-rich" : "rich", remove:true},
      {rule:"e", kind:lists ? "prop-rich" : "rich", missingGlyph:true},
      {rule:"f", kind:lists ? "prop-rich" : "rich", css:'@page { @bottom-right { content:"Page 9 of 9"; } }'},
      {rule:"f", kind:lists ? "prop-rich" : "rich", css:"@page { @bottom-left { content:none; } }"},
      {rule:"g", kind:lists ? "prop-empty" : "empty", css:"@page { size:A4; }"}
    ];
    for (const [index, probe] of probes.entries()) {
      await load(probe.kind);
      if (probe.splitRow) await evaluate(`(() => {
        document.querySelector('main').innerHTML = '<section><p style="height:400pt;margin:0">Row split spacer</p><table><thead><tr><th>Probe header</th></tr></thead><tbody><tr><td><div class="print-text">' + Array.from({length:30},(_,i)=>'Probe line '+i).join('<br>') + '</div></td></tr></tbody></table></section>';
        return true;
      })()`);
      const model = await captureModel();
      model.fixture = `probe-${probe.rule}/${probe.kind}`;
      if (probe.css) await evaluate(`(() => {const style=document.createElement('style');style.textContent=${JSON.stringify(probe.css)};document.head.append(style);return true;})()`);
      if (probe.remove) await evaluate("document.querySelector('h1').textContent = 'Missing fixture title'");
      if (probe.missingGlyph) await evaluate("document.querySelector('h1').append(String.fromCodePoint(0x10ffff))");
      const pdf = await send("Page.printToPDF", {preferCSSPageSize:true, printBackground:true, generateTaggedPDF:true});
      const bytes = Buffer.from(pdf.data, "base64");
      const report = readPrintedPages(bytes);
      writeFileSync(join(out, `probe-${probe.rule}-${index}.pdf`), bytes);
      let failure;
      assert.throws(() => {
        try { checkPrintedLayout(report, model, probe.part || probe.rule); }
        catch (error) { failure = error.message.replace(/\s+/g, " ").slice(0, 300); throw error; }
      }, {message:new RegExp(`^${probe.rule === "b" ? "No split rows:" : probe.rule + ":"}${probe.part ? " " + probe.part.split("-")[1] : ""}`)}, `Probe ${probe.part || probe.rule} must fail its own rule`);
      await load(probe.kind);
      const restored = await send("Page.printToPDF", {preferCSSPageSize:true, printBackground:true, generateTaggedPDF:true});
      const restoredModel = await captureModel();
      restoredModel.fixture = `restored/${probe.kind}`;
      checkPrintedLayout(readPrintedPages(Buffer.from(restored.data, "base64")), restoredModel);
      records.push(`probe ${probe.part || probe.rule}: ${probe.kind}; ${probe.css || (probe.remove ? "remove title text" : "insert unsupported glyph")}; ${failure}; restored fixture passed`);
      checks++;
    }
  }
  writeFileSync(join(out, "summary.txt"), records.join("\n") + `\n${checks}/${checks} checks passed\n`);
  log(records.join("\n"));
  log(`${checks}/${checks} checks passed`);
  log("Printed PDF headroom: " + JSON.stringify(headroom));
  return {checks, fixtures:cases.length, records, headroom};
} finally {
  ws?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  if (browser.exitCode === null) {
    if (process.platform === "win32") {
      const kill = spawn("taskkill", ["/T", "/F", "/PID", String(browser.pid)], { stdio: "ignore", windowsHide: true });
      await once(kill, "exit");
    } else browser.kill("SIGKILL");
    if (browser.exitCode === null) await once(browser, "exit");
  }
}

}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await inspectPrintedFixtures();
