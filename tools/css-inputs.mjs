import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
export const cssInputs = Object.freeze(JSON.parse(readFileSync(new URL("css-inputs.json", root), "utf8")));

function readInput(path) {
  let directory = root;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    if (!readdirSync(directory).includes(part)) throw new Error("Missing or incorrectly cased CSS input: " + path);
    directory = new URL(part + (index < parts.length - 1 ? "/" : ""), directory);
  }
  return readFileSync(directory, "utf8");
}

export function appCss(inputs = cssInputs, read = readInput) {
  const seen = new Set();
  return inputs.map((path) => {
    if (!/^[\w-]+(?:\/[\w.-]+)*\.css$/.test(path) || path.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error("Invalid CSS input path: " + path);
    }
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate CSS input: " + path);
    seen.add(key);
    return read(path);
  }).join("\n");
}
