import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./main-module.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
export const projectionManifestPath = join(REPO, "prototypes/collab/test/proj/app-reference.json");

function digest(text) {
  return { bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}

function documents(value, selection = []) {
  if (!value || typeof value !== "object") return [];
  if (!Array.isArray(value) && Array.isArray(value.rows)) return [{ selection, document: value }];
  return Object.entries(value).flatMap(([key, item]) => documents(item, [...selection, key]));
}

export function projectionReferenceInputs() {
  const result = [];
  const add = (source, selection = [], document = null) => {
    const bytes = document ? JSON.stringify(document, null, 2) : readFileSync(join(REPO, source), "utf8");
    result.push({ name: selection.length ? source.split("/").at(-1) + "/" + selection.join("/") : source.startsWith("src/test/fixtures/") || source.startsWith("prototypes/") ? source.split("/").at(-1) : source, source, selection, bytes });
  };
  for (const name of readdirSync(join(REPO, "src/test/fixtures")).filter(name => name.endsWith(".splitpage")).sort()) add(`src/test/fixtures/${name}`);
  add("src/seed-state.json");
  for (const name of readdirSync(join(REPO, "src/starters")).filter(name => name.endsWith(".json")).sort()) add(`src/starters/${name}`);
  for (const name of readdirSync(join(REPO, "src/test/fixtures/golden")).filter(name => name.startsWith("merge-") || name === "migrate-golden.json").sort()) {
    const source = `src/test/fixtures/golden/${name}`;
    for (const entry of documents(JSON.parse(readFileSync(join(REPO, source), "utf8")))) add(source, entry.selection, entry.document);
  }
  for (const name of readdirSync(join(REPO, "prototypes/collab/test/proj")).filter(name => name.endsWith(".splitpage")).sort()) add(`prototypes/collab/test/proj/${name}`);
  return result;
}

export async function generateProjectionManifest() {
  const { dom } = await import("../src/test/_dom.mjs");
  const { migrateRows, withDocumentPorts } = await import("../src/bootstrap/document-ports.ts");
  const { migrateDocument } = await import("../src/core/migrate.ts");
  const { STATE_FIELDS } = await import("../src/core/merge/state-fields.ts");
  const { buildSplitpageFile } = await import("../src/adapters/formats/project-file.ts");
  const { parseSplitpageFile } = await import("../src/adapters/formats/splitpage-file.ts");
  try {
    const fixtures = projectionReferenceInputs().map(fixture => {
      const parsed = parseSplitpageFile(fixture.bytes);
      const document = withDocumentPorts(STATE_FIELDS, ports => migrateDocument(parsed, { kind: "file" }, ports));
      const saved = buildSplitpageFile({ document }, { migrateRows });
      return { name: fixture.name, source: fixture.source, selection: fixture.selection, original: digest(fixture.bytes), document,
        appSaved: { ...digest(saved), ...(saved === fixture.bytes ? {} : { full: saved }) } };
    });
    return { version: 1, producer: "node tools/projection-reference.mjs --write", fixtures };
  } finally { dom.window.close(); }
}

export function projectionManifestText(manifest) {
  return JSON.stringify({ version: manifest.version, producer: manifest.producer }).slice(0, -1) + ',"fixtures":[\n' +
    manifest.fixtures.map(fixture => JSON.stringify(fixture)).join(",\n") + "\n]}\n";
}

export function checkProjectionManifest(expected, actual) {
  if (expected !== actual) throw new Error("projection-reference: manifest is stale; run node tools/projection-reference.mjs --write");
}

export async function runProjectionReference(args) {
  const options = [...args];
  const mode = options.shift();
  let destination = projectionManifestPath;
  if (options[0] === "--manifest" && options[1]) { destination = options[1]; options.splice(0, 2); }
  if (!["--check", "--write"].includes(mode) || options.length) throw new Error("usage: node tools/projection-reference.mjs --check|--write [--manifest path]");
  const manifest = await generateProjectionManifest();
  const text = projectionManifestText(manifest);
  if (mode === "--check") checkProjectionManifest(readFileSync(destination, "utf8"), text);
  else writeFileSync(destination, text);
  console.log(`projection-reference: ${manifest.fixtures.length} fixtures, ${mode === "--check" ? "manifest matches" : "manifest written"}`);
}

if (isMain(import.meta.url)) {
  try { await runProjectionReference(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
