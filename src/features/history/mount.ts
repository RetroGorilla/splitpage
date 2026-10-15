import { createViewLifetime } from "../view-lifetime.ts";

export interface HistoryPorts {
  readonly promptForWpm: () => void;
  readonly closeHistoryPanel: () => void;
  readonly onRootClick: (event: MouseEvent) => void;
}

export function mountHistory(mount: { window: Window; ports: HistoryPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("runtime-chip"), "click", ports.promptForWpm);
  const lengthStatus = element("length-status");
  if (lengthStatus) life.listen(lengthStatus, "click", ports.promptForWpm);

  life.listen(element("history-close"), "click", ports.closeHistoryPanel);
  life.listen(element("history-panel"), "click", ports.onRootClick);
  return { dispose: life.dispose };
}
