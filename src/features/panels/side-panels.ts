import type { SidePanels } from "../../application/side-panels.ts";

export interface SidePanelsPorts {
  readonly ids: readonly string[];
  readonly buttons: readonly (readonly [panelId: string, buttonId: string])[];
  readonly readWidth: (id: string) => number;
  readonly holdPlace: () => void;
  readonly opening: (open: boolean) => void;
}

export function createSidePanels(document: Document, ports: SidePanelsPorts): SidePanels {
  const closedHooks = new Map<string, () => void>();
  const pages = new Map<string, () => void>();

  function shown(id: string): boolean {
    const panel = document.getElementById(id);
    return panel !== null && !panel.hidden;
  }

  function register(into: Map<string, () => void>, id: string, run: () => void): () => void {
    if (into.has(id)) throw new Error(`${id} is already registered with the panels`);
    into.set(id, run);
    return () => {
      if (into.get(id) === run) into.delete(id);
    };
  }

  function applyWidth(id: string, width: number): void {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.style.setProperty("--panel-width", width + "px");
    document.body.style.setProperty("--open-panel-width", width + "px");
  }

  function sync(): void {
    const open = ports.ids.some(shown);
    if (open !== document.body.classList.contains("panel-open")) ports.opening(open);
    document.body.classList.toggle("panel-open", open);
    for (const [panelId, buttonId] of ports.buttons) {
      const button = document.getElementById(buttonId);
      if (button) button.setAttribute("aria-pressed", shown(panelId) ? "true" : "false");
    }
  }

  function open(id: string): void {
    ports.holdPlace();
    for (const other of ports.ids) {
      if (other === id) continue;
      const panel = document.getElementById(other);
      if (panel) panel.hidden = true;
    }
    const panel = document.getElementById(id);
    if (!panel) throw new Error(`there is no side panel ${id} to open`);
    panel.hidden = false;
    applyWidth(id, ports.readWidth(id));
    sync();
  }

  function close(id: string): void {
    const page = pages.get(id);
    if (page) { page(); return; }
    if (!ports.ids.includes(id)) throw new Error(`${id} is not a side panel or a registered page`);
    const panel = document.getElementById(id);
    if (panel) panel.hidden = true;
    closedHooks.get(id)?.();
    sync();
  }

  function closeAll(): void {
    for (const id of ports.ids) {
      if (!shown(id)) continue;
      close(id);
    }
    sync();
  }

  return {
    registerPanel: (id, closed) => register(closedHooks, id, closed),
    registerPage: (id, closePage) => register(pages, id, closePage),
    open,
    close,
    closeAll,
    sync,
    applyWidth
  };
}
