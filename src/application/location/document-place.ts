import type { DocumentLocation } from "./document-location.ts";
import type { ServerStatus } from "./server-status.ts";

export interface DocumentPlace extends Pick<DocumentLocation,
  "home" | "connection" | "fileHome" | "importHome" | "homeConn" | "serverHomeId" | "serverHomeRev" |
  "serverOf" | "stillOnServer" | "writtenOut" | "onChange"> {
  readonly arrivingOnLink: () => boolean;
  readonly serverMode: ServerStatus["mode"];
  readonly linkTurnedOff: ServerStatus["linkTurnedOff"];
  readonly sessionExpired: ServerStatus["sessionExpired"];
  readonly bookmarks: ServerStatus["bookmarks"];
  readonly bookmarkById: ServerStatus["bookmarkById"];
  readonly onServerStatusChange: ServerStatus["onChange"];
}
