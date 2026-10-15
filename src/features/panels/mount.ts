import { createViewLifetime } from "../view-lifetime.ts";

export interface PanelsPorts {
  readonly ids: readonly string[];
  readonly readWidth: (id: string) => number;
  readonly defaultWidth: (id: string) => number;
  readonly clampWidth: (width: number, id: string) => number;
  readonly applyWidth: (id: string, width: number) => void;
  readonly saveWidth: (id: string, width: number) => void;
}

export function mountPanels(mount: { window: Window; ports: PanelsPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  for (const id of ports.ids) {
    const panel = document.getElementById(id);
    const handle = document.getElementById(id + "-resize-handle");
    if (!panel || !handle) continue;
    ports.applyWidth(id, ports.readWidth(id));
    let drag: ReturnType<typeof createViewLifetime> | undefined;
    let startX = 0;
    let startWidth = ports.defaultWidth(id);
    function end(): void {
      drag?.dispose();
      drag = undefined;
      handle?.classList.remove("is-dragging");
      document.body.classList.remove("is-panel-resizing");
    }
    life.release(end);
    life.listen(handle, "mousedown", down);
    life.listen(handle, "touchstart", down, { passive: false });
    life.listen(handle, "dblclick", () => {
      const width = ports.defaultWidth(id);
      ports.applyWidth(id, width);
      ports.saveWidth(id, width);
    });
    function down(event: MouseEvent): void {
      end();
      drag = createViewLifetime(window);
      startX = x(event);
      startWidth = ports.readWidth(id);
      handle?.classList.add("is-dragging");
      document.body.classList.add("is-panel-resizing");
      const move = (event: MouseEvent): void => {
        if (!panel?.isConnected || !handle?.isConnected) { end(); return; }
        ports.applyWidth(id, ports.clampWidth(startWidth + startX - x(event), id));
      };
      const up = (): void => {
        end();
        if (!panel?.isConnected) return;
        const width = parseFloat(window.getComputedStyle(panel).getPropertyValue("--panel-width")) || ports.defaultWidth(id);
        ports.saveWidth(id, ports.clampWidth(width, id));
      };
      drag.listen(document, "mousemove", move);
      drag.listen(document, "mouseup", up);
      drag.listen(document, "touchmove", move, { passive: false });
      drag.listen(document, "touchend", up);
      event.preventDefault();
    }
  }
  return { dispose: life.dispose };
}

function x(event: MouseEvent): number {
  const touch = (event as unknown as TouchEvent).touches?.[0];
  return touch ? touch.clientX : event.clientX;
}
