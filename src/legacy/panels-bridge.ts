import type { SidePanels } from "../application/side-panels.ts";

let started: SidePanels | null = null;

export function startSidePanels(panels: SidePanels): () => void {
  if (started) throw new Error("The side panels are already started; stop them first");
  started = panels;
  return function () {
    if (started === panels) started = null;
  };
}

export function sidePanels(): SidePanels {
  if (!started) throw new Error("The side panels are not started yet");
  return started;
}
