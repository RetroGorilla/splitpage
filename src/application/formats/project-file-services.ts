import type { DocumentOrigin } from "../../core/migrate.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";

export type MarkdownRowChoice = "table" | "keep";

export interface InertElement {
  readonly textContent: string | null;
}

export interface InertPage {
  readonly ownerDocument: { readonly getElementById: (id: string) => InertElement | null };
}

export interface ProjectFileServices {
  readonly migrateRows: (raw: unknown) => ValidatedDocument;
  readonly migrateDocument: (raw: unknown, origin: DocumentOrigin) => ValidatedDocument;
  readonly sanitizeHtml: (html: string) => string;
  readonly tagFieldOccurrences: (html: string, phrase: string, cat: string, name: string, countOnly: boolean) => { readonly hits: number; readonly html: string };
  readonly inertBody: (html: string) => InertPage;
  readonly askMarkdownRows: (blockRows: number, tableRows: number) => Promise<MarkdownRowChoice>;
}

const SERVICES: readonly (keyof ProjectFileServices)[] = ["migrateRows", "migrateDocument", "sanitizeHtml", "tagFieldOccurrences", "inertBody", "askMarkdownRows"];

let installed: ProjectFileServices | null = null;

export function installProjectFileServices(services: ProjectFileServices): () => void {
  if (installed) throw new Error("The project file services are already started; stop them first");
  const missing = SERVICES.find((name) => typeof services[name] !== "function");
  if (missing) throw new Error("The project file services have no " + missing + " function");
  const held = Object.freeze({ ...services });
  installed = held;
  return () => {
    if (installed === held) installed = null;
  };
}

export function projectFileServicesStarted(): boolean {
  return installed !== null;
}

export function projectFileServices(): ProjectFileServices {
  if (!installed) throw new Error("The project file services are not started yet");
  return installed;
}
