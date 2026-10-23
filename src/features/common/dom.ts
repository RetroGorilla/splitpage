export function cssAttr(value: unknown): string {
  return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
