import { createViewLifetime } from "../common/view-lifetime.ts";

export interface AppearancePorts {
  readonly theme: () => string;
  readonly tagIcons: () => boolean;
  readonly nameOf: (key: string) => string | null;
}

interface DesktopTheme {
  readonly setTheme?: (mode: string) => void;
}

export function applyTheme(window: Window, mode: string): void {
  const root = window.document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  const bridge = (window as Window & { splitpageDesktop?: DesktopTheme | null }).splitpageDesktop;
  if (bridge && typeof bridge.setTheme === "function") {
    try { bridge.setTheme(mode); } catch (e) { }
  }
}

export function applyTagIcons(window: Window, on: boolean): void {
  const root = window.document.documentElement;
  if (on) root.setAttribute("data-tag-icons", "");
  else root.removeAttribute("data-tag-icons");
}

export function mountAppearance(mount: { window: Window; ports: AppearancePorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const life = createViewLifetime(window);
  applyTheme(window, ports.theme());
  applyTagIcons(window, ports.tagIcons());
  life.listen(window, "storage", function (e) {
    const key = (e as unknown as StorageEvent).key;
    const name = key === null ? null : ports.nameOf(key);
    if (name === "theme") applyTheme(window, ports.theme());
    if (name === "tagIcons") applyTagIcons(window, ports.tagIcons());
  });
  return { dispose: life.dispose };
}
