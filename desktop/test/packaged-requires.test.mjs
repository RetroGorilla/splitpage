import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderConfig = fs.readFileSync(path.join(desktop, "electron-builder.yml"), "utf8");
const { files } = parse(builderConfig);
assert.ok(Array.isArray(files), "electron-builder.yml must list its packaged files");
const packaged = new Set(files.filter(file => typeof file === "string"));
const optional = ["relay-owner.ts", "relay-setup-window.ts"];
const collaborationStage = files.filter(file => typeof file === "object");
assert.deepEqual(collaborationStage, [{ from: ".stage/desktop-code", to: ".", filter: ["*.ts", "collaboration.json"] }]);
const stagedScript = fs.readFileSync(path.join(desktop, "stage.mjs"), "utf8");
let checked = 0;
let sharedChecked = 0;

for (const file of [...packaged, ...optional]) {
  assert.ok(fs.existsSync(path.join(desktop, file)), `electron-builder.yml lists ${file}, which does not exist`);
  if (!/\.(?:ts|js)$/.test(file)) continue;
  const source = fs.readFileSync(path.join(desktop, file), "utf8");
  for (const match of source.matchAll(/\brequire\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g)) {
    checked++;
    assert.ok(
      packaged.has(path.posix.normalize(match[1])) || (file === "main.ts" && optional.includes(path.posix.normalize(match[1]))),
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
