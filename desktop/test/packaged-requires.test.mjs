import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderConfig = fs.readFileSync(path.join(desktop, "electron-builder.yml"), "utf8");
const filesBlock = /^files:\r?\n((?:[ \t]+- .+\r?\n)+)/m.exec(builderConfig);
assert.ok(filesBlock, "electron-builder.yml must list its packaged files");

const packaged = new Set(filesBlock[1].split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean));
const stagedScript = fs.readFileSync(path.join(desktop, "stage.mjs"), "utf8");
let checked = 0;
let sharedChecked = 0;

for (const file of packaged) {
  assert.ok(fs.existsSync(path.join(desktop, file)), `electron-builder.yml lists ${file}, which does not exist`);
  if (!/\.(?:ts|js)$/.test(file)) continue;
  const source = fs.readFileSync(path.join(desktop, file), "utf8");
  for (const match of source.matchAll(/\brequire\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g)) {
    checked++;
    assert.ok(
      packaged.has(path.posix.normalize(match[1])),
      `${file} requires ${match[1]}, which is not in app.asar. List it in electron-builder.yml, or load shared code through SHARED_ROOT in main.ts.`
    );
  }
  for (const match of source.matchAll(/\brequire\(\s*path\.(?:join|resolve)\([^)]*\)\s*\)/g)) {
    assert.ok(!match[0].includes(".."), `${file} builds a require path that leaves app.asar: ${match[0]}. Load shared code through SHARED_ROOT in main.ts.`);
  }
  for (const match of source.matchAll(/\brequire\(\s*path\.join\(\s*SHARED_ROOT,\s*["'`]([^"'`]+)["'`]\s*\)\s*\)/g)) {
    sharedChecked++;
    assert.ok(stagedScript.includes(`"${match[1]}"`), `${file} loads shared/${match[1]}, which desktop/stage.mjs does not stage for packaged builds.`);
  }
}

assert.ok(sharedChecked > 0, "no SHARED_ROOT requires found; the pattern in this test no longer matches the source");

assert.ok(checked > 0, "no relative requires found; the pattern in this test no longer matches the source");
console.log(`packaged-requires: ${checked} relative requires stay inside app.asar`);
