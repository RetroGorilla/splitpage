import test from "node:test";
import assert from "node:assert/strict";
import { imagesLeftOutText, unshownCharactersText } from "../../../src/application/export/diagnostics.ts";

test("one missing picture is reported in the singular", () => {
  assert.equal(
    imagesLeftOutText(1, "the PDF"),
    "1 image could not be included in the PDF — the picture was not available on this computer."
  );
});

test("several missing pictures are reported in the plural", () => {
  assert.equal(
    imagesLeftOutText(3, "the Word file"),
    "3 images could not be included in the Word file — the pictures were not available on this computer."
  );
});

test("zero counts as plural", () => {
  assert.equal(
    imagesLeftOutText(0, "the PDF"),
    "0 images could not be included in the PDF — the pictures were not available on this computer."
  );
});

test("characters no font can show are counted in the singular and the plural", () => {
  assert.equal(unshownCharactersText(1), "1 character can't be shown in PDF");
  assert.equal(unshownCharactersText(12), "12 characters can't be shown in PDF");
});
