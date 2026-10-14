export interface WrittenMarks {
  readonly rev?: unknown;
  readonly lastEditedBy?: unknown;
}

function editorNamed(name: unknown): boolean {
  return typeof name === "string" && name.trim() !== "";
}

export function neverWrittenOut(doc: WrittenMarks | null | undefined): boolean {
  if (!doc || typeof doc !== "object") return true;
  return !doc.rev && !editorNamed(doc.lastEditedBy);
}
