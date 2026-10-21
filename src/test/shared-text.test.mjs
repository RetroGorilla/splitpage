import test from "node:test";
import assert from "node:assert/strict";
import { checksumText, driveFormatSize, formatVideoLength, slugify } from "../../shared/text.js";

test("driveFormatSize writes bytes, KB or MB and nothing for an empty or unreadable size", () => {
  assert.equal(driveFormatSize(0), "");
  assert.equal(driveFormatSize(undefined), "");
  assert.equal(driveFormatSize("nope"), "");
  assert.equal(driveFormatSize(1), "1 B");
  assert.equal(driveFormatSize(1023), "1023 B");
  assert.equal(driveFormatSize(1024), "1 KB");
  assert.equal(driveFormatSize(1536), "2 KB");
  assert.equal(driveFormatSize("2048"), "2 KB");
  assert.equal(driveFormatSize(1024 * 1024), "1.0 MB");
  assert.equal(driveFormatSize(5.5 * 1024 * 1024), "5.5 MB");
});

test("formatVideoLength writes m:ss or h:mm:ss, rounding to the second, and nothing for no length", () => {
  assert.equal(formatVideoLength(0), "");
  assert.equal(formatVideoLength(-3), "");
  assert.equal(formatVideoLength(NaN), "");
  assert.equal(formatVideoLength(undefined), "");
  assert.equal(formatVideoLength(5), "0:05");
  assert.equal(formatVideoLength(59.6), "1:00");
  assert.equal(formatVideoLength(75), "1:15");
  assert.equal(formatVideoLength(3599), "59:59");
  assert.equal(formatVideoLength(3600), "1:00:00");
  assert.equal(formatVideoLength(3725), "1:02:05");
});

test("slugify makes a lowercase hyphenated file stem and falls back to splitpage", () => {
  assert.equal(slugify("My Great Script!"), "my-great-script");
  assert.equal(slugify("  --Already--Slugged--  "), "already-slugged");
  assert.equal(slugify("Café 2"), "caf-2");
  assert.equal(slugify(""), "splitpage");
  assert.equal(slugify(null), "splitpage");
  assert.equal(slugify("!!!"), "splitpage");
});

test("checksumText is a stable 32-bit FNV-1a hash in hex", () => {
  assert.equal(checksumText(""), "811c9dc5");
  assert.equal(checksumText("a"), "e40c292c");
  assert.equal(checksumText("foobar"), "bf9cf968");
  assert.notEqual(checksumText("abc"), checksumText("abd"));
});
