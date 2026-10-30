import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

const [input, output, name] = process.argv.slice(2);
if (!input || !output || !/^[A-Z][A-Z0-9_]*$/.test(name || "")) {
  console.error("usage: node tools/pdf-font-module.mjs <font.ttf> <out.ts> <EXPORT_NAME>");
  process.exit(1);
}
const packed = deflateRawSync(readFileSync(input), { level: 9 }).toString("base64");
writeFileSync(output, "export const " + name + " =\n  \"" + packed + "\";\n");
console.log(output + ": " + packed.length + " characters");
