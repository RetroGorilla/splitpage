/* desktop/test/spellcheck-menu.test.mjs: the desktop context menu (#120).
 *
 * Electron never shows a context menu on its own — before #120 a right-click
 * on a misspelled word in the desktop app did nothing, since main.js had no
 * `context-menu` handler on any webContents. This is a plain text/regex read
 * of main.js, in the same spirit as ipc-table.test.mjs: requiring 'electron'
 * outside Electron fails, so main.js cannot be executed here, only read.
 * Driving a REAL native right-click and a real OS spellchecker needs a real
 * window and a real dictionary — docs/WINDOWS-CHECKS.md §3 typing check 3
 * already carries that as a by-hand check, deliberately outside what any
 * suite here can drive (DOCUMENT-MODEL.md §5: the spellchecker is one of the
 * three things left to the browser). What IS checked here is the wiring: the
 * handler exists, lives on the tab's own webContents and not the tab strip's,
 * offers `dictionarySuggestions` through `replaceMisspelling` plus "Add to
 * dictionary", and gates Cut/Copy/Paste/Select all on `editFlags` — so
 * picking a suggestion is Chromium's own text replacement, which fires the
 * same 'input' event typing does, which 21-events.js's onRootInput and
 * 12a-undo.js's noteEdit() already turn into one coalesced undo entry with no
 * further wiring (verified by reading, not exercised here — see the report).
 *
 * Prints ALL PASS and exits 0, or lists the failures and exits 1.
 *
 * Run: node desktop/test/spellcheck-menu.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, "..");
const MAIN = fs.readFileSync(path.join(desktop, "main.js"), "utf8");

/* Slices out a top-level `function name(...) { ... }` body by matching
   braces, so a check can be scoped to just that function rather than the
   whole file (a naive indexOf..indexOf could wander into a later function
   with a longer body). */
function functionBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name} found in main.js`);
  const openAt = src.indexOf("{", at);
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openAt, i + 1);
    }
  }
  throw new Error(`function ${name}: no matching closing brace found`);
}

const wireTabView = functionBody(MAIN, "wireTabView");
const createTabWindow = functionBody(MAIN, "createTabWindow");
const createTunnelWindow = functionBody(MAIN, "createTunnelWindow");

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("wireTabView (the document tab's own webContents) registers a context-menu handler", () => {
  assert.match(wireTabView, /contents\.on\(\s*"context-menu"/);
});

test("the tab strip's webContents (createTabWindow) gets no context-menu handler", () => {
  assert.doesNotMatch(createTabWindow, /context-menu/);
});

test("the tunnel window's webContents gets no context-menu handler either", () => {
  assert.doesNotMatch(createTunnelWindow, /context-menu/);
});

test("a misspelled word offers its dictionary suggestions through replaceMisspelling", () => {
  assert.match(wireTabView, /params\.misspelledWord/);
  assert.match(wireTabView, /params\.dictionarySuggestions/);
  assert.match(wireTabView, /contents\.replaceMisspelling\(/);
});

test("a misspelled word offers Add to dictionary via the webContents' own session", () => {
  assert.match(wireTabView, /addWordToSpellCheckerDictionary\(/);
  /* Scoped to the misspelled-word branch, not just anywhere in the file. */
  const menuAt = wireTabView.indexOf('"context-menu"');
  const dictAt = wireTabView.indexOf("addWordToSpellCheckerDictionary(");
  const misspelledAt = wireTabView.indexOf("misspelledWord", menuAt);
  assert.ok(misspelledAt > menuAt && dictAt > misspelledAt, "Add to dictionary sits after the misspelledWord check");
});

test("Cut/Copy/Paste/Select all are gated on params.editFlags", () => {
  for (const flag of ["canCut", "canCopy", "canPaste", "canSelectAll"]) {
    assert.match(wireTabView, new RegExp(`flags\\.${flag}`), `${flag} checked before its menu item`);
  }
  assert.match(wireTabView, /contents\.cut\(\)/);
  assert.match(wireTabView, /contents\.copy\(\)/);
  assert.match(wireTabView, /contents\.paste\(\)/);
  assert.match(wireTabView, /contents\.selectAll\(\)/);
});

test("an empty menu (nothing misspelled, nothing editable) never pops up", () => {
  assert.match(wireTabView, /if\s*\(!template\.length\)\s*return;/);
});

/* ------------------------------------------------------------------ */

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failures.push(c.name);
    console.log(`FAIL - ${c.name}\n       ${String((err && err.stack) || err).split("\n").slice(0, 6).join("\n       ")}`);
  }
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases)`);
