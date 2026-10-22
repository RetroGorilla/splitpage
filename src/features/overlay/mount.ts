import { createViewLifetime } from "../common/view-lifetime.ts";

export interface OverlayPorts {
  readonly closeRowMenus: () => void;
  readonly selectedKeys: () => readonly string[];
  readonly clearProductionSelection: () => void;
  readonly renderProduction: () => void;
  readonly closeCommentComposer: (cancelled: boolean) => void;
  readonly closeCommentsPanel: () => void;
  readonly writerOpen: () => boolean;
  readonly paintingScreen: () => boolean;
  readonly hasTagGhost: () => boolean;
  readonly hideTagGhost: () => void;
  readonly closeWriter: () => void;
  readonly focus: (target: HTMLElement) => void;
}

export interface OverlayMount {
  readonly mountToolbar: () => void;
  readonly mountCommentsEscape: () => void;
  readonly mountWriterBar: () => void;
  readonly mountWriterFocus: () => void;
  readonly dispose: () => void;
}

export function mountOverlay(mount: { window: Window; ports: OverlayPorts }): OverlayMount {
  const win = mount.window;
  const doc = win.document;
  const ports = mount.ports;
  const life = createViewLifetime(win, () => true);
  const { listen } = life;
  const stages = new Set<string>();
  function stage(name: string, install: () => void): void {
    if (!life.active() || stages.has(name)) return;
    stages.add(name);
    install();
  }
  listen(doc, "mousedown", function (e) {
    if (!e.target?.closest?.(".row-menu-wrap")) ports.closeRowMenus();
  }, true);
  return {
    mountToolbar: () => stage("toolbar", () => {
      listen(doc.querySelector(".toolbar"), "mousedown", function (e) {
        if (e.target?.closest?.(".btn")) e.preventDefault();
      });
    }),
    mountCommentsEscape: () => stage("comments", () => {
      listen(win, "keydown", function (e) {
        if (e.key !== "Escape") return;
        if (ports.selectedKeys().length && doc.getElementById("production-panel")?.hidden === false) {
          e.preventDefault();
          ports.clearProductionSelection();
          ports.renderProduction();
          return;
        }
        if (doc.getElementById("comment-modal")?.hidden === false) ports.closeCommentComposer(true);
        else if (doc.getElementById("comments-panel")?.hidden === false) ports.closeCommentsPanel();
      });
    }),
    mountWriterBar: () => stage("writer-bar", () => {
      listen(doc.querySelector(".writer-bar"), "mousedown", function (e) {
        if (e.target?.closest?.(".wr-fmt")) e.preventDefault();
      });
    }),
    mountWriterFocus: () => stage("writer-focus", () => {
      listen(doc, "focusin", function (e) {
        if (!ports.writerOpen() || ports.paintingScreen()) return;
        const el = e.target;
        if (!el?.closest) return;
        if (el.closest("#writer")) return;
        if (el.closest(".modal-backdrop:not([hidden]), .toast")) return;
        const back = doc.querySelector<HTMLElement>("#writer-doc .wr-para") || doc.getElementById("wr-close");
        if (back) ports.focus(back);
      });
      listen(win, "keydown", function (e) {
        if (!ports.writerOpen() || e.key !== "Escape") return;
        if (ports.hasTagGhost()) { ports.hideTagGhost(); return; }
        ports.closeWriter();
      });
    }),
    dispose: life.dispose
  };
}
