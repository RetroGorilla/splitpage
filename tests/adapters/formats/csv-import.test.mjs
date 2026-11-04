import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { csvToRows } from "../../../src/adapters/formats/csv.ts";

const rows = (text) => csvToRows(text).map((r) => [r.visualText, r.audioText]);

test("legacy Scene and current Beat exports both stop before their comments appendix", () => {
  for (const heading of ["Scene", "Beat"]) {
    assert.deepEqual(rows(`${heading},Visual,Audio,Status\r\nB.1,Wide,Hello,shot\r\nComments,,,\r\n1,Comment,Words,`), [["Wide", "Hello"]]);
  }
});

test("an empty file gives no rows", () => {
  assert.deepEqual(rows(""), []);
  assert.deepEqual(rows(undefined), []);
  assert.deepEqual(rows("\n\n  \n"), []);
});

test("without a header the first two columns are visual and audio", () => {
  assert.deepEqual(rows("A,B\nC,D"), [["A", "B"], ["C", "D"]]);
});

test("a file with one cell and no newline still gives its row", () => {
  assert.deepEqual(rows("A"), [["A", ""]]);
  assert.deepEqual(rows("A,"), [["A", ""]]);
  assert.deepEqual(rows("A,B"), [["A", "B"]]);
});

test("cells are trimmed and rows with only one side filled are kept", () => {
  assert.deepEqual(rows("  A  ,  B  \nonly visual,\n,only audio\n,\n"), [["A", "B"], ["only visual", ""], ["", "only audio"]]);
});

test("a leading blank line does not hide the header", () => {
  assert.deepEqual(rows("\n\nVisual,Audio\nA,B"), [["A", "B"]]);
});

test("quotes: commas, doubled quotes and line breaks inside a cell", () => {
  assert.deepEqual(rows('"a, b","say ""hi"""'), [["a, b", "say &quot;hi&quot;"]]);
  assert.deepEqual(rows('"x""y",z'), [["x&quot;y", "z"]]);
  assert.deepEqual(rows('"one\ntwo","three\nfour\nfive"'), [["one<br>two", "three<br>four<br>five"]]);
  assert.deepEqual(rows('"one\ntwo\nthree",x'), [["one<br>two<br>three", "x"]]);
  assert.deepEqual(rows('x,"one\ntwo\nthree"'), [["x", "one<br>two<br>three"]]);
});

test("a quote that closes ends the quoted part", () => {
  assert.deepEqual(rows('"a",b,c\n"d",e,f'), [["a", "b"], ["d", "e"]]);
  assert.deepEqual(rows('"a"b,c'), [["ab", "c"]]);
});

test("cells are escaped for the document, not passed through as markup", () => {
  assert.deepEqual(rows("<b>x</b> & y,<i>z</i>"), [["&lt;b&gt;x&lt;/b&gt; &amp; y", "&lt;i&gt;z&lt;/i&gt;"]]);
});

test("a byte order mark at the start is dropped and one in the middle is kept", () => {
  assert.deepEqual(rows("﻿Visual,Audio\nA,B"), [["A", "B"]]);
  assert.deepEqual(rows("a﻿b,c"), [["a﻿b", "c"]]);
  assert.deepEqual(rows("﻿x,y"), [["x", "y"]]);
});

test("control characters are dropped, tabs and line breaks stay", () => {
  assert.deepEqual(rows("a\u0000b\u0008c\u001Fd,e"), [["abcd", "e"]]);
  assert.deepEqual(rows("a\tb,c"), [["a\tb", "c"]]);
  assert.deepEqual(rows('"a\r\nb",c'), [["a\r<br>b", "c"]]);
});

test("a carriage return outside quotes is dropped, wherever it is", () => {
  assert.deepEqual(rows("a\rb,c"), [["ab", "c"]]);
});

test("Windows line endings read the same as Unix ones", () => {
  assert.deepEqual(rows("Visual,Audio\r\nA,B\r\nC,D\r\n"), [["A", "B"], ["C", "D"]]);
});

test("a header names the columns, wherever they are", () => {
  assert.deepEqual(rows("Notes,Visual,Audio\nx,V,A\ny,W,B"), [["V", "A"], ["W", "B"]]);
  assert.deepEqual(rows("Audio,Notes,Visual\nA,x,V"), [["V", "A"]]);
  assert.deepEqual(rows(" Visual , Audio \nV,A"), [["V", "A"]]);
  assert.deepEqual(rows("VISUAL,AUDIO\nV,A"), [["V", "A"]]);
});

test("every accepted visual heading is recognised, in the singular and the plural", () => {
  for (const word of ["visual", "video", "picture", "image", "shot", "action"]) {
    for (const head of [word, word + "s", word.toUpperCase()]) {
      assert.deepEqual(rows(`Notes,${head},Audio\nx,V,A`), [["V", "A"]], head);
    }
  }
});

test("every accepted audio heading is recognised, in the singular and the plural", () => {
  for (const word of ["audio", "voice", "vo", "narration", "dialogue", "script", "line"]) {
    for (const head of [word, word + "s", word.toUpperCase()]) {
      assert.deepEqual(rows(`Notes,Visual,${head}\nx,V,A`), [["V", "A"]], head);
    }
  }
  assert.deepEqual(rows("Notes,Visual,Voice over\nx,V,A"), [["V", "A"]]);
});

test("a heading that only contains a keyword is not that column", () => {
  assert.deepEqual(rows("x,Picture notes,Audio\nV,A,B"), [["V", "A"]]);
  assert.deepEqual(rows("x,Stock picture,Audio\nV,A,B"), [["V", "A"]]);
  assert.deepEqual(rows("x,Visual,Voiceover\nV,A,B"), [["V", "A"]]);
  assert.deepEqual(rows("x,Visual,Background audio\nV,A,B"), [["V", "A"]]);
});

test("a header with only one recognised column is still skipped, and the default columns apply", () => {
  assert.deepEqual(rows("Audio,Notes\nA,B"), [["A", "B"]]);
  assert.deepEqual(rows("Picture,Notes\nA,B"), [["A", "B"]]);
  assert.deepEqual(rows("Picture,Notes\nA,B\nC,D"), [["A", "B"], ["C", "D"]]);
  assert.deepEqual(rows("Notes,Picture\nA,B"), [["A", "B"]]);
});

test("a header made of an index word is skipped", () => {
  for (const word of ["Scene", "No", "No.", "#", "Number", "Index", "NUMBER"]) {
    assert.deepEqual(rows(`${word},Notes\nA,B`), [["A", "B"]], word);
  }
});

test("a cell that only ends in an index word does not make a header", () => {
  assert.deepEqual(rows("Table index,Notes\nA,B"), [["Table index", "Notes"], ["A", "B"]]);
  assert.deepEqual(rows("Scenery,Notes\nA,B"), [["Scenery", "Notes"], ["A", "B"]]);
});

test("a first column of numbers is an index, so the next two columns are visual and audio", () => {
  assert.deepEqual(rows("1,v1,a1\n2,v2,a2"), [["v1", "a1"], ["v2", "a2"]]);
  assert.deepEqual(rows("1A,v1,a1\n1b,v2,a2"), [["v1", "a1"], ["v2", "a2"]]);
  assert.deepEqual(rows("1234,v1,a1"), [["v1", "a1"]]);
  assert.deepEqual(rows("12345,v1,a1"), [["12345", "v1"]]);
  assert.deepEqual(rows("a1,v1,a1"), [["a1", "v1"]]);
  assert.deepEqual(rows("1,v1,a1\n,v2,a2\n3,v3,a3"), [["v1", "a1"], ["v2", "a2"], ["v3", "a3"]]);
});

test("an all-empty first column is not an index", () => {
  assert.deepEqual(rows(",v1,a1\n,v2,a2"), [["", "v1"], ["", "v2"]]);
});

test("only the first eight filled cells of the first column are checked", () => {
  const numbered = (n) => Array.from({ length: n }, (_, i) => `${i + 1},v${i + 1},a${i + 1}`);
  assert.deepEqual(rows([...numbered(8), "x,v9,a9"].join("\n")).slice(0, 2), [["v1", "a1"], ["v2", "a2"]]);
  assert.deepEqual(rows([...numbered(7), "x,v8,a8"].join("\n")).slice(0, 2), [["1", "v1"], ["2", "v2"]]);
});

test("with a header the index check starts below it", () => {
  assert.deepEqual(rows("No.,Picture,Words\n1,v1,a1\n2,v2,a2"), [["v1", "a1"], ["v2", "a2"]]);
  assert.deepEqual(rows("No.,Words\n1,v1\n2,v2"), [["v1", ""], ["v2", ""]]);
});

test("a two-column index file has no audio, even when later rows have more cells", () => {
  assert.deepEqual(rows("1,v1\n2,v2,extra"), [["v1", ""], ["v2", ""]]);
  assert.deepEqual(rows("1,v1\n2,v2"), [["v1", ""], ["v2", ""]]);
});

test("index columns are found by the first column, not another", () => {
  assert.deepEqual(rows("v1,1,a1\nv2,2,a2"), [["v1", "1"], ["v2", "2"]]);
});

test("a single-column file reads the cell as the visual", () => {
  assert.deepEqual(rows("A\nB"), [["A", ""], ["B", ""]]);
});

test("our own export reads back and stops at the Comments section", () => {
  const text = [
    "Scene,Start,Status,Read,Read set by hand,Visual,Audio,Tags,B-roll,Open comments",
    "01,00:00,To do,0:10,,V1,A1,,,",
    "02,00:10,To do,0:10,,V2,A2,,,",
    "",
    "Comments",
    "No.,Location,Status,Assigned to,Author,Date,Quoted text,Comment",
    "1,Scene 01 · Audio,Open,,Jo,Sep 20,q,Nice"
  ].join("\r\n");
  assert.deepEqual(rows(text), [["V1", "A1"], ["V2", "A2"]]);
  assert.deepEqual(rows(text.replace("\r\nComments\r\n", "\r\n Comments \r\n")), [["V1", "A1"], ["V2", "A2"]]);
  assert.deepEqual(rows(text.replace("\r\nComments\r\n", "\r\nComments, , ,\r\n")), [["V1", "A1"], ["V2", "A2"]]);
});

test("the Comments heading only ends the script when the header is our own export", () => {
  const without = (head) => rows(head + "\n01,todo,x1\nComments\n02,todo,x2");
  assert.deepEqual(without("Scene,Status,Audio,Notes"), [["01", "todo"], ["Comments", ""], ["02", "todo"]]);
  assert.deepEqual(without("Scene,Status,Visual,Notes"), [["01", "todo"], ["Comments", ""], ["02", "todo"]]);
});

test("with our own header a Comments row with other cells filled stays in the script", () => {
  const head = "Scene,Status,Visual,Audio\n01,todo,V1,A1\n";
  assert.deepEqual(rows(head + "Comments,x,V2,A2\n03,todo,V3,A3"), [["V1", "A1"], ["V2", "A2"], ["V3", "A3"]]);
  assert.deepEqual(rows(head + "Comments, , , \n03,todo,V3,A3"), [["V1", "A1"]]);
});

test("a named visual column with no named audio column falls back to the default columns", () => {
  assert.deepEqual(rows("Picture,Notes,Other\nA,B,C"), [["A", "B"]]);
});

test("the three-column index form takes columns 2 and 3, not 3 and 2", () => {
  assert.deepEqual(rows("1,v,a"), [["v", "a"]]);
});
