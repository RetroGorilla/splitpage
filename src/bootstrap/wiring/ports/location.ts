import type { ReviewFacts } from "../../../application/collaboration/review.ts";
import type { DocumentPlace } from "../../../application/location/document-place.ts";
import { arrivingOnLink } from "../../../js/13-hosted.js";
import { currentConn, currentHome, documentLocation, fileHome, homeConn, importHome, reviewBlocked, reviewMode, serverHomeId, serverStatus, stillOnServer } from "../../../legacy/location-bridge.ts";

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
