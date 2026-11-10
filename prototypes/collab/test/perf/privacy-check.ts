import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function measuredMetadataSnapshot(files: string[]) {
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
  const text = readFileSync(join(root, "prototypes/collab/perf-results.md"), "utf8");
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
