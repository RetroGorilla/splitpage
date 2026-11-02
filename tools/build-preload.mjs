import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

for (const name of ["preload", "tabstrip-preload", "tabstrip/tabstrip"]) {
  const source = new URL(`../desktop/${name}.ts`, import.meta.url);
  const output = new URL(`../desktop/${name}.js`, import.meta.url);
  writeFileSync(output, stripTypeScriptTypes(readFileSync(source, "utf8")));
}
