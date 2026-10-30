import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cssDurationMs } from "../../../src/features/common/css-duration.ts";

function withRootStyle(css: string, run: () => void): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  try { run(); } finally { style.remove(); }
}

test("cssDurationMs: reads millisecond and second custom properties as milliseconds", () => {
  withRootStyle(":root { --fast: 180ms; --slow: 1.5s; --padded:   250ms ; }", () => {
    assert.equal(cssDurationMs(window, "--fast", 99), 180);
    assert.equal(cssDurationMs(window, "--slow", 99), 1500);
    assert.equal(cssDurationMs(window, "--padded", 99), 250);
  });
});

test("cssDurationMs: returns the fallback for missing and unparseable values", () => {
  withRootStyle(":root { --word: soon; }", () => {
    assert.equal(cssDurationMs(window, "--missing", 42), 42);
    assert.equal(cssDurationMs(window, "--word", 7), 7);
  });
});

test("cssDurationMs: returns the fallback when the window cannot be queried", () => {
  const broken = { document: window.document, getComputedStyle() { throw new Error("no style"); } } as unknown as Window;
  assert.equal(cssDurationMs(broken, "--fast", 33), 33);
});
