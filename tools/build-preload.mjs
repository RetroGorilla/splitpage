import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = new URL("../desktop/preload.ts", import.meta.url);
const output = new URL("../desktop/preload.js", import.meta.url);
writeFileSync(output, stripTypeScriptTypes(readFileSync(source, "utf8")));
