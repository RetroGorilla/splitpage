export interface RowRoutePorts {
  readonly dragging: () => string | null;
  readonly setDragging: (rowId: string | null) => void;
  readonly clearMarkers: () => void;
  readonly markDrop: (row: Element, clientY: number) => void;
  readonly scroll: (clientX: number, clientY: number) => void;
  readonly stopScroll: () => void;
  readonly move: (rowId: string, targetId: string, after: boolean) => void;
  readonly add: (afterId: string | null) => void;
  readonly moveBy: (rowId: string, dir: -1 | 1) => void;
  readonly toggleMenu: (button: Element, focusFirst: boolean) => void;
  readonly armDelete: (button: Element, rowId: string) => void;
  readonly cycleStatus: (rowId: string) => void;
  readonly expandHidden: (ids: string | null) => void;
  readonly reveal: (rowId: string) => void;
  readonly gone: () => void;
}

export interface RowRoutesMount {
  readonly window: Window;
  readonly rows: Element;
  readonly ports: RowRoutePorts;
}

export interface RowRoutes {
  readonly addClick: (e: MouseEvent) => boolean;
  readonly sceneClick: (e: MouseEvent) => boolean;
  readonly menuClick: (e: MouseEvent) => boolean;
  readonly dragOver: (e: DragEvent) => boolean;
  readonly drop: (e: DragEvent) => boolean;
  readonly dispose: () => void;
}

type Realm = Window & typeof globalThis;

export function mountRowRoutes(mount: RowRoutesMount): RowRoutes {
  const ports = mount.ports;
  const realm = mount.window as Realm;
  const doc = realm.document;
  let open = true;

  function closest(e: Event, selector: string): Element | null {
    const target = e.target;
    return target instanceof realm.Element ? target.closest(selector) : null;
  }

  function idOf(el: Element): string {
    return el.getAttribute("data-id") || "";
  }

  function rowIn(rowId: string): HTMLElement | null {
    const rows = mount.rows.querySelectorAll(".row");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row instanceof realm.HTMLElement && row.getAttribute("data-id") === rowId) return row;
    }
    return null;
  }

  function jumpTo(rowId: string): void {
    ports.reveal(rowId);
    const row = rowIn(rowId);
    if (!row) { ports.gone(); return; }
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.remove("just-merged");
    void row.offsetWidth;
    row.classList.add("just-merged");
  }

  function onDragStart(e: Event): void {
    const row = closest(e, ".row");
    if (!row || !row.getAttribute("draggable")) return;
    const rowId = idOf(row);
    ports.setDragging(rowId);
    row.classList.add("is-dragging");
    const data = (e as DragEvent).dataTransfer;
    try {
      if (data) {
        data.effectAllowed = "move";
        data.setData("text/plain", rowId);
      }
    } catch {
      return;
    }
  }

  function onDragEnd(): void {
    ports.setDragging(null);
    ports.clearMarkers();
  }

  function onMouseUp(): void {
    if (!ports.dragging()) ports.clearMarkers();
  }

  function onWindowDragOver(e: Event): void {
    if (!ports.dragging()) return;
    if (closest(e, "#rundown:not(.is-min)")) { ports.stopScroll(); return; }
    const d = e as DragEvent;
    ports.scroll(d.clientX, d.clientY);
  }

  function dropEffect(e: DragEvent): void {
    try {
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    } catch {
      return;
    }
  }

  mount.rows.addEventListener("dragstart", onDragStart);
  mount.rows.addEventListener("dragend", onDragEnd);
  doc.addEventListener("mouseup", onMouseUp);
  realm.addEventListener("dragover", onWindowDragOver);

  return {
    addClick(e: MouseEvent): boolean {
      if (!open) return false;
      if (!closest(e, '[data-action="add-row"]')) return false;
      ports.add(null);
      return true;
    },
    sceneClick(e: MouseEvent): boolean {
      if (!open) return false;
      const status = closest(e, '[data-action="cycle-status"]');
      if (status) { ports.cycleStatus(idOf(status)); return true; }
      const lamp = closest(e, ".row .status-btn.is-static");
      if (lamp && mount.rows.contains(lamp)) {
        const row = lamp.closest(".row");
        if (row) { ports.cycleStatus(idOf(row)); return true; }
      }
      const strip = closest(e, '[data-action="expand-hidden-shot"]');
      if (strip) { ports.expandHidden(strip.getAttribute("data-ids")); return true; }
      const jump = closest(e, '[data-action="jump-row"]');
      if (jump) { jumpTo(jump.getAttribute("data-row") || ""); return true; }
      return false;
    },
    menuClick(e: MouseEvent): boolean {
      if (!open) return false;
      const menu = closest(e, '[data-action="row-menu"]');
      if (menu) { ports.toggleMenu(menu, e.detail === 0); return true; }
      const up = closest(e, '[data-action="move-up"]');
      if (up) { ports.moveBy(idOf(up), -1); return true; }
      const down = closest(e, '[data-action="move-down"]');
      if (down) { ports.moveBy(idOf(down), 1); return true; }
      const below = closest(e, '[data-action="insert-below"]');
      if (below) { ports.add(idOf(below)); return true; }
      const del = closest(e, '[data-action="delete-row"]');
      if (del) { ports.armDelete(del, idOf(del)); return true; }
      return false;
    },
    dragOver(e: DragEvent): boolean {
      if (!open) return false;
      const moving = ports.dragging();
      if (!moving) return false;
      const row = closest(e, ".row");
      if (!row || idOf(row) === moving) return true;
      e.preventDefault();
      dropEffect(e);
      ports.markDrop(row, e.clientY);
      return true;
    },
    drop(e: DragEvent): boolean {
      if (!open) return false;
      const moving = ports.dragging();
      if (!moving) return false;
      const row = closest(e, ".row");
      if (!row) return true;
      e.preventDefault();
      const after = row.classList.contains("drop-after");
      ports.setDragging(null);
      ports.clearMarkers();
      ports.move(moving, idOf(row), after);
      return true;
    },
    dispose(): void {
      if (!open) return;
      open = false;
      mount.rows.removeEventListener("dragstart", onDragStart);
      mount.rows.removeEventListener("dragend", onDragEnd);
      doc.removeEventListener("mouseup", onMouseUp);
      realm.removeEventListener("dragover", onWindowDragOver);
      if (!ports.dragging()) return;
      ports.setDragging(null);
      ports.clearMarkers();
      ports.stopScroll();
    }
  };
}
