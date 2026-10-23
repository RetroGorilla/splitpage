import { createViewLifetime } from "../common/view-lifetime.ts";
import { listenWriterStats } from "./display.ts";

export interface WriterOpenPorts {
  readonly runFromButton: (id: string) => void;
}

export function mountWriterOpen(mount: { window: Window; ports: WriterOpenPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("btn-write"), "click", function () { ports.runFromButton("write"); });
  life.release(listenWriterStats());
  return { dispose: life.dispose };
}

export interface WriterNavigationPorts {
  readonly jumpFromWriterToRow: (id: string | null) => void;
  readonly expandHiddenShotStrip: (ids: string | null) => void;
  readonly saveFromButton: () => void;
  readonly applyWriterSize: (size: number, persist: boolean) => void;
}

export function mountWriterNavigation(mount: { window: Window; ports: WriterNavigationPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("writer-doc"), "click", function (e) {
    const gutter = e.target.closest('[data-action="writer-jump"]');
    if (gutter) { ports.jumpFromWriterToRow(gutter.getAttribute("data-row")); return; }
    const expandShotBtn = e.target.closest('[data-action="expand-hidden-shot"]');
    if (expandShotBtn) ports.expandHiddenShotStrip(expandShotBtn.getAttribute("data-ids"));
  });

  life.listen(element("wr-save"), "click", ports.saveFromButton);

  life.listen(element("wr-size"), "input", function (e) {
    ports.applyWriterSize(parseInt(e.target.value, 10), true);
  });
  return { dispose: life.dispose };
}

export interface WriterClosePorts {
  readonly closeWriter: () => void;
}

export function mountWriterClose(mount: { window: Window; ports: WriterClosePorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("wr-close"), "click", function () { ports.closeWriter(); });
  return { dispose: life.dispose };
}
