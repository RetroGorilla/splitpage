import type { DocumentLocation } from "./document-location.ts";

export type DocumentPlace = Pick<DocumentLocation, "home" | "fileHome" | "importHome" | "writtenOut" | "onChange">;
