export type SplitpageFile = { rows: unknown[]; [key: string]: unknown };

export function parseSplitpageFile(text: string): SplitpageFile {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as { rows?: unknown }).rows)) {
    throw new Error("not-a-splitpage-file");
  }
  return parsed as SplitpageFile;
}
