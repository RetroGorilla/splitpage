import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createThemeChoice, backgroundColorFor, titleBarOverlayFor, boundsIfVisible } = require(path.join(here, "..", "window-appearance.ts"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-theme-"));
  return path.join(dir, "nested", "theme.json");
}

const display = (x, y, width, height) => ({ workArea: { x, y, width, height } });

test("with no theme file, or an unreadable or unknown one, the choice is system", () => {
  const file = tempFile();
  const choice = createThemeChoice({ filePath: () => file });
  assert.equal(choice.read(), "system");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not json");
  assert.equal(choice.read(), "system");
  fs.writeFileSync(file, JSON.stringify({ theme: "purple" }));
  assert.equal(choice.read(), "system");
});

test("a written choice is read back, creating the folder", () => {
  const file = tempFile();
  const choice = createThemeChoice({ filePath: () => file });
  choice.write("dark");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { theme: "dark" });
  assert.equal(choice.read(), "dark");
  choice.write("light");
  assert.equal(choice.read(), "light");
});

test("writing the choice already stored leaves the file alone", () => {
  const file = tempFile();
  const choice = createThemeChoice({ filePath: () => file });
  choice.write("system");
  assert.equal(fs.existsSync(file), false);
  choice.write("dark");
  fs.utimesSync(file, new Date(0), new Date(0));
  choice.write("dark");
  assert.equal(fs.statSync(file).mtimeMs, 0);
});

test("a failed write is swallowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-theme-"));
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "");
  const choice = createThemeChoice({ filePath: () => path.join(blocker, "theme.json") });
  choice.write("dark");
  assert.equal(choice.read(), "system");
});

test("window and title bar colours follow dark or light", () => {
  assert.equal(backgroundColorFor(true), "#0F0E0C");
  assert.equal(backgroundColorFor(false), "#F1F0ED");
  assert.deepEqual(titleBarOverlayFor(true, 36), { color: "#0F0E0C", symbolColor: "#ECEBE7", height: 36 });
  assert.deepEqual(titleBarOverlayFor(false, 36), { color: "#F1F0ED", symbolColor: "#171613", height: 36 });
});

test("saved bounds are kept only when they overlap a display's work area", () => {
  const displays = [display(0, 0, 1920, 1040), display(1920, 0, 1280, 1000)];
  const onFirst = { x: 100, y: 100, width: 800, height: 600 };
  const onSecond = { x: 2000, y: 50, width: 800, height: 600 };
  const straddling = { x: -700, y: 100, width: 800, height: 600 };
  const off = { x: 4000, y: 100, width: 800, height: 600 };
  const touching = { x: 3200, y: 0, width: 100, height: 100 };
  assert.equal(boundsIfVisible(onFirst, displays), onFirst);
  assert.equal(boundsIfVisible(onSecond, displays), onSecond);
  assert.equal(boundsIfVisible(straddling, displays), straddling);
  assert.equal(boundsIfVisible(off, displays), null);
  assert.equal(boundsIfVisible(touching, displays), null);
  assert.equal(boundsIfVisible(null, displays), null);
  assert.equal(boundsIfVisible({ x: "1" }, displays), null);
  assert.equal(boundsIfVisible(onFirst, []), null);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
