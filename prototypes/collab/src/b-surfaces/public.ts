export function publicBEvidence(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (key === "timings") return undefined;
    if (key === "paints" && Array.isArray(item)) return item.map((paint: { phase: string }) => ({ phase: paint.phase }));
    if (typeof item === "string") return item.replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g, "<local-path>");
    return item;
  });
}
import type { BSurfaceEvidence } from "./run.ts";


export function serializeBSurfaceEvidence(evidence: BSurfaceEvidence): string {
  const { traces, followup, ...metadata } = JSON.parse(publicBEvidence(evidence)) as BSurfaceEvidence;
  const cases = (values: unknown[]): string[] => values.map((value, index) => `    ${JSON.stringify(value)}${index === values.length - 1 ? "" : ","}`);
  return ["{", ...Object.entries(metadata).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`),
    '  "traces": [', ...cases(traces), "  ],", '  "followup": [', ...cases(followup), "  ]", "}", ""].join("\n");
}
