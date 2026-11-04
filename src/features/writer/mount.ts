import type { ButtonActions } from "../../application/actions.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";
import { WRITER_SIZE_MAX, WRITER_SIZE_MIN } from "../../application/preferences/preferences.ts";

export type WriterOpenPorts = Pick<ButtonActions, "runFromButton">;

export function mountWriterOpen(mount: { window: Window; ports: WriterOpenPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("btn-write"), "click", function () { ports.runFromButton("write"); });
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

  // why: the slider holds whole sizes, so a pinch's small steps are kept here until they add up to one.
  let exact: number | null = null;
  life.listen(element("writer"), "wheel", function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const current = Number(element("wr-size").value);
    if (exact === null || Math.round(exact) !== current) exact = current;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33;
    else if (e.deltaMode === 2) dy *= 600;
    dy = Math.max(-300, Math.min(300, dy));
    exact = Math.min(WRITER_SIZE_MAX, Math.max(WRITER_SIZE_MIN, exact * Math.exp(-dy * 0.001)));
    const next = Math.round(exact);
    if (next === current) return;
    const hold = e.target.closest<HTMLElement>(".wr-block, .section-header");
    const rect = hold?.getBoundingClientRect();
    const frac = rect && rect.height ? (e.clientY - rect.top) / rect.height : 0;
    ports.applyWriterSize(next, true);
    if (!hold || !rect || !hold.isConnected) return;
    const now = hold.getBoundingClientRect();
    element("writer-scroll").scrollTop += now.top + frac * now.height - e.clientY;
  }, { passive: false });
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
