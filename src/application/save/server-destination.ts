import type { SaveJob, WriterResult } from "./coordinator.ts";
import type { SaveDestination } from "./destinations.ts";
import { autoSaveWhere } from "./autosave.ts";

export interface ServerSaveRequest {
  readonly kind: string;
}

export interface ServerDestinationPorts<R extends ServerSaveRequest> {
  readonly send: (job: SaveJob<R>) => Promise<boolean>;
  readonly signedOut: () => boolean;
  readonly linkOff: () => boolean;
  readonly resumeAutoSave: () => void;
  readonly haltAutoSave: (reason: string) => void;
}

export const SERVER_DESTINATION = "server";

export const SERVER_SAVE_FAILED_HALT = "Autosave is paused — the last save to the server did not go through. Press Save to try again.";

const SENT: WriterResult = Object.freeze({ kind: "saved" });
const NOT_SENT: WriterResult = Object.freeze({ kind: "failed" });

const TO_THE_HOME = Object.freeze(["save", "auto", "autosave", "force"]);
const AUTOMATIC = Object.freeze(["auto", "autosave"]);

function onTheServer(place: unknown): boolean {
  return typeof place === "object" && place !== null && (place as { readonly kind?: unknown }).kind === "server";
}

export function createServerDestination<R extends ServerSaveRequest>(ports: ServerDestinationPorts<R>): SaveDestination<R, unknown> {
  return Object.freeze({
    id: SERVER_DESTINATION,
    takes: function (request: R, place: unknown) {
      if (request.kind === "server") return true;
      return onTheServer(place) && TO_THE_HOME.indexOf(request.kind) !== -1;
    },
    autoSaveTarget: function () {
      return autoSaveWhere({ onServer: true, signedOut: ports.signedOut(), linkOff: ports.linkOff(), file: null });
    },
    write: function (job: SaveJob<R>) {
      const kind = job.request.kind;
      const automatic = AUTOMATIC.indexOf(kind) !== -1;
      if (!automatic && kind !== "server") ports.resumeAutoSave();
      return ports.send(job).then(function (sent) {
        if (automatic && sent === false) ports.haltAutoSave(SERVER_SAVE_FAILED_HALT);
        return sent === false ? NOT_SENT : SENT;
      });
    }
  });
}
