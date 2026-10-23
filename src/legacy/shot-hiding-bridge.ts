import { createShotHiding } from "../application/shot-hiding.ts";
import type { ShotHiding, ShotHidingPorts } from "../application/shot-hiding.ts";
import type { TimerPort } from "../application/session/ports.ts";
import { preferences, viewFlags } from "./preferences-bridge.ts";
import { currentDocument } from "./session-bridge.ts";

let started: ShotHiding | null = null;

export function legacyShotHidingPorts(timers: Pick<TimerPort, "start" | "stop">): ShotHidingPorts {
  return Object.freeze({
    flags: Object.freeze({
      hideShot: function () { return viewFlags().hideShot(); },
      setHideShot: function (on: boolean) { viewFlags().setHideShot(on); }
    }),
    remember: function (on: boolean) { preferences().setHideShot(on); },
    rows: function () {
      const doc = currentDocument();
      return doc ? doc.rows : null;
    },
    timers: timers
  });
}

export function startShotHiding(ports: ShotHidingPorts): () => void {
  if (started) throw new Error("Shot hiding is already started; stop it first");
  const mine = createShotHiding(ports);
  started = mine;
  return function () {
    if (started !== mine) return;
    started = null;
    mine.dispose();
  };
}

export function shotHidingStarted(): boolean {
  return started !== null;
}

export function shotHiding(): ShotHiding {
  if (!started) throw new Error("Shot hiding is not started yet");
  return started;
}
