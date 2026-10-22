import { createViewLifetime } from "../common/view-lifetime.ts";

type BrollEvent = Event & { readonly target: HTMLElement & { value: string }; readonly key: string };

export interface BrollPorts {
  readonly click: (event: BrollEvent, root: HTMLElement) => void;
  readonly change: (event: BrollEvent) => void;
  readonly focusout: (event: BrollEvent) => void;
  readonly keydown: (event: BrollEvent, root: HTMLElement) => void;
  readonly input: (event: BrollEvent) => void;
  readonly add: () => void;
  readonly closePanel: () => void;
  readonly openPanel: () => void;
  readonly closePage: () => void;
  readonly pageOpen: () => boolean;
  readonly setPageGroup: (value: string) => void;
  readonly menusOpen: () => boolean;
  readonly closeMenus: () => void;
  readonly hasSelection: () => boolean;
  readonly clearSelection: () => void;
  readonly render: () => void;
  readonly reset: () => void;
}

export function mountBroll(mount: { window: Window; ports: BrollPorts }): { dispose: () => void } {
  const win = mount.window;
  const doc = win.document;
  const ports = mount.ports;
  const panel = doc.getElementById("broll-panel");
  const page = doc.getElementById("broll-page");
  function current(target: HTMLElement): boolean {
    return doc.getElementById(target.id) === target;
  }
  const life = createViewLifetime<BrollEvent>(win, (target) =>
    !!panel && current(panel) && (target === win || target === doc || current(target as HTMLElement)));
  const { listen } = life;
  function rootListeners(root: HTMLElement): void {
    listen(root, "click", (event) => ports.click(event, root));
    listen(root, "change", ports.change);
    listen(root, "focusout", ports.focusout);
    listen(root, "keydown", (event) => ports.keydown(event, root));
    listen(root, "input", ports.input);
  }
  if (panel) {
    rootListeners(panel);
    if (page) {
      rootListeners(page);
      listen(page, "change", (event) => {
        if (event.target.id === "broll-page-group") ports.setPageGroup(event.target.value);
      });
      listen(page, "keydown", (event) => {
        if (event.key === "Enter" && event.target.classList && event.target.classList.contains("broll-page-note")) {
          event.preventDefault();
          event.target.blur();
        }
      });
      listen(win, "keydown", (event) => {
        if (!current(page) || event.key !== "Escape" || !ports.pageOpen() || event.defaultPrevented) return;
        if (doc.querySelector(".modal-backdrop:not([hidden])")) return;
        event.preventDefault();
        ports.closePage();
      });
      listen(doc, "focusin", (event) => {
        if (!current(page) || !ports.pageOpen()) return;
        const el = event.target;
        if (!el || !el.closest || el.closest("#broll-page")) return;
        if (el.closest(".modal-backdrop:not([hidden]), .toast")) return;
        doc.getElementById("broll-page-close")?.focus();
      });
    }
    listen(doc.getElementById("broll-add-save"), "click", ports.add);
    listen(doc.getElementById("broll-close"), "click", ports.closePanel);
    listen(doc.getElementById("btn-broll"), "click", ports.openPanel);
    listen(doc, "mousedown", (event) => {
      if (!ports.menusOpen()) return;
      if (event.target.closest && event.target.closest('.broll-menu, .broll-group-btn, [data-action="broll-menu"]')) return;
      ports.closeMenus();
      ports.render();
    });
    listen(win, "keydown", (event) => {
      if (event.key !== "Escape" || !ports.hasSelection()) return;
      const p = doc.getElementById("broll-panel");
      if (!p || p.hidden || p.contains(event.target)) return;
      ports.clearSelection();
      ports.render();
    });
  }
  return {
    dispose(): void {
      if (!life.active()) return;
      life.dispose();
      ports.reset();
    }
  };
}
