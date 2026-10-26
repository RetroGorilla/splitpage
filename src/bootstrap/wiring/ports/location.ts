import type { ServerStatus } from "../../../application/location/server-status.ts";
import type { ReviewFacts } from "../../../application/collaboration/review.ts";
import type { DocumentPlace } from "../../../application/location/document-place.ts";
import type { DocumentLocation } from "../../../application/location/document-location.ts";
import { arrivingOnLink } from "../../../js/13-hosted.js";
import { amendHome, currentConn, currentHome, documentLocation, fileHome, homeConn, importHome, reviewBlocked, reviewMode, serverHomeId, serverStatus, stillOnServer } from "../../../legacy/location-bridge.ts";

export const place: DocumentPlace = {
  home: () => currentHome(),
  connection: () => currentConn(),
  fileHome: () => fileHome(),
  importHome: () => importHome(),
  homeConn: () => homeConn(),
  serverHomeId: () => serverHomeId(),
  serverHomeRev: () => documentLocation().serverHomeRev(),
  serverOf: (connection) => documentLocation().serverOf(connection),
  stillOnServer: (connection) => stillOnServer(connection),
  writtenOut: () => documentLocation().writtenOut(),
  onChange: (listener) => documentLocation().onChange(listener),
  arrivingOnLink: () => arrivingOnLink(),
  serverMode: () => serverStatus().mode(),
  linkTurnedOff: () => serverStatus().linkTurnedOff(),
  sessionExpired: () => serverStatus().sessionExpired(),
  bookmarks: () => serverStatus().bookmarks(),
  bookmarkById: (id) => serverStatus().bookmarkById(id),
  onServerStatusChange: (listener) => serverStatus().onChange(listener)
};

export const review: ReviewFacts = { reviewing: reviewMode, refuseInReview: reviewBlocked };

export const homes: Pick<DocumentLocation, "home" | "amendHome" | "homeConn"> = {
  home: () => currentHome(),
  amendHome: (record, fields) => amendHome(record, fields),
  homeConn: () => homeConn()
};

export const bookmarks: Pick<ServerStatus, "loadBookmarks" | "bookmarks" | "addBookmarks"> = {
  loadBookmarks: () => serverStatus().loadBookmarks(),
  bookmarks: () => serverStatus().bookmarks(),
  addBookmarks: (added) => serverStatus().addBookmarks(added)
};
