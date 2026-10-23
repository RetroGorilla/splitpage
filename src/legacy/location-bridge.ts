import { createDocumentLocation } from "../application/location/document-location.ts";
import type { Connection, DocumentLocation, Home, HomeFields } from "../application/location/document-location.ts";
import { createServerStatus } from "../application/location/server-status.ts";
import type { ServerStatus, ServerStatusPorts } from "../application/location/server-status.ts";
import { showToast } from "./effects-bridge.ts";
import { VIEWING_ONLY } from "../application/collaboration/review.ts";

interface Started {
  readonly location: DocumentLocation;
  readonly status: ServerStatus;
}

let kept: Started | null = null;
let started: Started | null = null;
let check: (() => Promise<void>) | null = null;

function running(): Started {
  if (!started) throw new Error("The document location is not started yet");
  return started;
}

export function browserLocationPorts(): ServerStatusPorts {
  return {
    storage: function () {
      try { return window.localStorage; } catch (e) { return null; }
    }
  };
}

export function startLocation(ports: ServerStatusPorts = browserLocationPorts()): () => void {
  if (started) throw new Error("The document location is already started; stop it first");
  const mine: Started = kept ?? Object.freeze({ location: createDocumentLocation(), status: createServerStatus(ports) });
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
  return running().location;
}

export function serverStatus(): ServerStatus {
  return running().status;
}

export function currentHome(): Home {
  return running().location.home();
}

export function currentConn(): Connection {
  return running().location.connection();
}

export function setHome(kind: string, fields?: HomeFields | null): Home {
  return running().location.setHome(kind, fields);
}

export function amendHome(record: Home, fields: HomeFields): Home {
  return running().location.amendHome(record, fields);
}

export function fileHome(): Home | null {
  return running().location.fileHome();
}

export function importHome(): Home | null {
  return running().location.importHome();
}

export function homeConn(): Connection | null {
  return running().location.homeConn();
}

export function serverHomeId(): string | null {
  return running().location.serverHomeId();
}

export function stillOnServer(c: unknown): boolean {
  return started !== null && started.location.stillOnServer(c);
}

export function reviewMode(): boolean {
  return running().location.reviewMode();
}

export function reviewBlocked(): boolean {
  if (!reviewMode()) return false;
  showToast(VIEWING_ONLY, "warn");
  return true;
}

export function handServerCheckTo(next: () => Promise<void>): void {
  check = next;
}

export function checkServer(): Promise<void> {
  if (!check) throw new Error("Nothing checks the server yet");
  return check();
}
