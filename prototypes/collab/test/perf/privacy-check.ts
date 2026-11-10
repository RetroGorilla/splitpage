import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

// why: This projection path is fictional; whole-value hashes also pin its retained diff excerpt, naming no machine.
const syntheticProjectionValues = new Set([
  "19cab2c169d6736ee405a375da246ecb934c3130ecfb2f1ae0b01dda88786f78",
  "310b9a9dd461be6587541783b96827fd4a98ecc2d68512ceb4484af3c2f7edd1"
]);

function privacyString(value: string): string {
  if (syntheticProjectionValues.has(createHash("sha256").update(value).digest("hex"))) return "<synthetic projection fixture>";
  return value.replace(/"(?:[^"\\\r\n]|\\.)*"/g, literal => {
    let decoded: string;
    try { decoded = JSON.parse(literal) as string; } catch { return literal; }
    return syntheticProjectionValues.has(createHash("sha256").update(decoded).digest("hex")) ? "<synthetic projection fixture>" : `"${decoded}"`;
  });
}

export function privacyText(file: string, text: string): string {
  if (!file.endsWith(".json") && !file.endsWith(".splitpage")) return privacyString(text);
  const strings: string[] = [];
  JSON.parse(text, (key: string, value: unknown) => {
    strings.push(privacyString(key));
    if (typeof value === "string") strings.push(privacyString(value));
    return value;
  });
  return strings.join("\n");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function measuredMetadataSnapshot(files: string[], reportText?: string) {
  const data = files.filter(file => file.endsWith(".json")).map(file => {
    const numbers: [string, number][] = [], timestamps: [string, string][] = [], samples: [string, number[]][] = [];
    const visit = (value: unknown, path: string): void => {
      if (typeof value === "number") numbers.push([path, value]);
      else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) timestamps.push([path, value]);
      else if (Array.isArray(value)) {
        if (path.endsWith(".samples") && value.every(item => typeof item === "number")) samples.push([path, value as number[]]);
        value.forEach((item: unknown, index) => visit(item, `${path}[${index}]`));
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) visit(child, `${path}.${key}`);
      }
    };
    visit(JSON.parse(readFileSync(join(root, file), "utf8")) as unknown, "$value");
    return { file, numberCount: numbers.length, numbersSha256: digest(numbers), timestampCount: timestamps.length, timestampsSha256: digest(timestamps), sampleCount: samples.reduce((sum, [, values]) => sum + values.length, 0), samplesSha256: digest(samples) };
  });
  const text = reportText ?? readFileSync(join(root, "prototypes/collab/perf-results.md"), "utf8");
  const allRows = text.split("\n").filter(line => line.startsWith("|"));
  const comparisonRows: string[] = [];
  let comparison = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("| A p50 [range]") || line.startsWith("| Fixture / measure |") || line.startsWith("| A median [range]")) { comparison = true; continue; }
    if (!line.startsWith("|")) { comparison = false; continue; }
    if (comparison && !line.startsWith("| ---")) comparisonRows.push(line);
  }
  return { data, tableLineCount: allRows.length, tablesSha256: digest(allRows), comparisonRowCount: comparisonRows.length, comparisonRowsSha256: digest(comparisonRows) };
}
