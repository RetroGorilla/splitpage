import { createPresence } from "../application/collaboration/presence.ts";
import type { Presence, PresencePorts } from "../application/collaboration/presence.ts";
import { cleanAuthorName } from "../core/document/people.ts";
import { preferences } from "./preferences-bridge.ts";
import { currentDocument } from "./session-bridge.ts";

let started: Presence | null = null;

export function legacyPresencePorts(): PresencePorts {
  return Object.freeze({
    selfName: function () { return cleanAuthorName(preferences().commentAuthor()); },
    selfColor: function () { return preferences().myColor(); },
    documentColors: function () {
      const doc = currentDocument();
      return doc && doc.personColors;
    }
  });
}

export function startPresence(ports: PresencePorts): () => void {
  if (started) throw new Error("Presence is already started; stop it first");
  const mine = createPresence(ports);
  started = mine;
  return function () {
    if (started !== mine) return;
    started = null;
    mine.dispose();
  };
}

export function presenceStarted(): boolean {
  return started !== null;
}

export function presence(): Presence {
  if (!started) throw new Error("Presence is not started yet");
  return started;
}
