import { createDocumentLocation } from "../../application/location/document-location.ts";
import type { DocumentLocation, Home, HomeFields } from "../../application/location/document-location.ts";

let kept: DocumentLocation | null = null;
let started: DocumentLocation | null = null;

function running(): DocumentLocation {
  if (!started) throw new Error("The document location is not started yet");
  return started;
}

export function startLocation(): () => void {
  if (started) throw new Error("The document location is already started; stop it first");
  const mine: DocumentLocation = kept ?? createDocumentLocation();
  kept = mine;
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function locationStarted(): boolean {
  return started !== null;
}

export function documentLocation(): DocumentLocation {
  return running();
}

export function currentHome(): Home {
  return running().home();
}

export function setHome(kind: string, fields?: HomeFields | null): Home {
  return running().setHome(kind, fields);
}

export function amendHome(record: Home, fields: HomeFields): Home {
  return running().amendHome(record, fields);
}

export function fileHome(): Home | null {
  return running().fileHome();
}

export function importHome(): Home | null {
  return running().importHome();
}
