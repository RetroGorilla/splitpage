import type { DocumentPlace } from "../../../application/location/document-place.ts";
import type { DocumentLocation } from "../../../application/location/document-location.ts";
import { amendHome, currentHome, documentLocation, fileHome, importHome } from "../location-owner.ts";

export const place: DocumentPlace = {
  home: () => currentHome(),
  fileHome: () => fileHome(),
  importHome: () => importHome(),
  writtenOut: () => documentLocation().writtenOut(),
  onChange: (listener) => documentLocation().onChange(listener)
};

export const homes: Pick<DocumentLocation, "home" | "amendHome"> = {
  home: () => currentHome(),
  amendHome: (record, fields) => amendHome(record, fields)
};
