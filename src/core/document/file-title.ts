export interface FileTitleState {
  readonly title: string;
  readonly titleOrigin?: unknown;
  readonly titleVersion?: unknown;
}

export interface FileTitleChange {
  readonly before: FileTitleState;
  readonly title: string;
  readonly titleOrigin: "file";
  readonly titleVersion: string | undefined;
}

export function normalizeTitleOrigin(value: unknown): "file" | "user" | undefined {
  return value === "file" || value === "user" ? value : undefined;
}

export function normalizeTitleVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^v\d+$/i.test(value) ? value.toLowerCase() : undefined;
}

export function isUntitledTitle(title: string): boolean {
  return /^(?:untitled(?: script)?)?$/i.test(title.trim());
}

export function fileTitleChange(doc: FileTitleState, filename: string, firstSave: boolean): FileTitleChange | null {
  const fromFile = doc.titleOrigin === "file";
  if (!fromFile && (!firstSave || doc.titleOrigin === "user" || !isUntitledTitle(doc.title))) return null;
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  if (/^[ _-]*v\d+$/i.test(stem)) return null;
  const version = /[ _-]+v(\d+)$/i.exec(stem);
  const title = fromFile ? doc.title : (version ? stem.slice(0, version.index) : stem).trim().slice(0, 300);
  if (!title) return null;
  const titleVersion = version ? "v" + version[1] : undefined;
  if (fromFile && title === doc.title && titleVersion === doc.titleVersion) return null;
  return {
    before: { title: doc.title, titleOrigin: doc.titleOrigin, titleVersion: doc.titleVersion },
    title,
    titleOrigin: "file",
    titleVersion
  };
}
