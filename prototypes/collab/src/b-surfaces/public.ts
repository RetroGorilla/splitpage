export function publicBEvidence(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (key === "timings") return undefined;
    if (key === "paints" && Array.isArray(item)) return item.map((paint: { phase: string }) => ({ phase: paint.phase }));
    if (typeof item === "string") return item.replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g, "<local-path>");
    return item;
  });
}
