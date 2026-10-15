export interface ClipboardRoutePorts<Owner, Place, Extra> {
  readonly scriptCell: (el: Element) => boolean;
  readonly reviewOnly: () => boolean;
  readonly copy: (e: ClipboardEvent, cell: Element, cut: boolean, readOnly: boolean) => boolean;
  readonly afterCut: (cell: Element) => void;
  readonly pasteScenes: (data: DataTransfer | null, cell: Element) => boolean;
  readonly pasteDraft: (cell: Element, html: string, text: string) => void;
  readonly hasMedia: (files: FileList | readonly File[] | null | undefined) => boolean;
  readonly readMedia: (files: FileList | readonly File[]) => Promise<Extra>;
  readonly capture: () => Owner;
  readonly stillOwns: (owner: Owner) => boolean;
  readonly notAdded: () => void;
  readonly placeOf: (cell: Element) => Place;
  readonly restorePlace: (cell: Element, place: Place) => void;
  readonly findCell: (rowId: string, field: string) => Element | null;
  readonly insertNow: (cell: Element, html: string, text: string, extra: Extra | null) => void;
}

export interface ClipboardRoutesMount<Owner, Place, Extra> {
  readonly window: Window;
  readonly roots: readonly Element[];
  readonly ports: ClipboardRoutePorts<Owner, Place, Extra>;
}

export interface ClipboardRoutes {
  readonly paste: (e: ClipboardEvent) => void;
  readonly insert: (cell: Element, html: string, text: string, files: FileList | readonly File[] | null | undefined) => void;
  readonly dispose: () => void;
}

type Realm = Window & typeof globalThis & { clipboardData?: DataTransfer | null };

const ROUTES = ["paste", "copy", "cut"] as const;

export function mountClipboardRoutes<Owner, Place, Extra>(mount: ClipboardRoutesMount<Owner, Place, Extra>): ClipboardRoutes {
  const ports = mount.ports;
  const realm = mount.window as Realm;
  const roots = mount.roots.slice();
  let open = true;

  function cellAround(e: Event): Element | null {
    const target = e.target;
    return target instanceof realm.Element ? target.closest(".cell-editable") : null;
  }

  function copyOrCut(e: ClipboardEvent, cut: boolean): void {
    if (!open) return;
    const cell = cellAround(e);
    if (!cell || !ports.scriptCell(cell)) return;
    const readOnly = ports.reviewOnly();
    if (!ports.copy(e, cell, cut, readOnly) || !cut || readOnly) return;
    const active = realm.document.activeElement;
    const fresh = active && active.closest ? active.closest(".cell-editable") : null;
    ports.afterCut(fresh || cell);
  }

  function insert(cell: Element, html: string, text: string, files: FileList | readonly File[] | null | undefined): void {
    if (!open) return;
    if (!files || !ports.hasMedia(files)) {
      ports.insertNow(cell, html, text, null);
      return;
    }
    const rowId = cell.getAttribute("data-id") || "";
    const field = cell.getAttribute("data-field") || "";
    const owner = ports.capture();
    const place = ports.placeOf(cell);
    void ports.readMedia(files).then(function (extra) {
      if (!open) return;
      if (!ports.stillOwns(owner)) { ports.notAdded(); return; }
      const live = cell.isConnected ? cell : ports.findCell(rowId, field);
      if (!live) return;
      if (html || text) ports.restorePlace(live, place);
      ports.insertNow(live, html, text, extra);
    });
  }

  function paste(e: ClipboardEvent): void {
    if (!open) return;
    const cell = cellAround(e);
    if (!cell) return;
    e.preventDefault();
    const data = e.clipboardData || realm.clipboardData || null;
    if (!ports.scriptCell(cell)) {
      if (data) ports.pasteDraft(cell, data.getData("text/html"), data.getData("text/plain"));
      return;
    }
    if (ports.pasteScenes(data, cell)) return;
    if (ports.reviewOnly() || !data) return;
    insert(cell, data.getData("text/html"), data.getData("text/plain"), data.files);
  }

  const handlers: Record<(typeof ROUTES)[number], (e: Event) => void> = {
    paste: function (e) { paste(e as ClipboardEvent); },
    copy: function (e) { copyOrCut(e as ClipboardEvent, false); },
    cut: function (e) { copyOrCut(e as ClipboardEvent, true); }
  };

  roots.forEach(function (root) {
    ROUTES.forEach(function (type) { root.addEventListener(type, handlers[type]); });
  });

  return {
    paste: paste,
    insert: insert,
    dispose: function () {
      if (!open) return;
      open = false;
      roots.forEach(function (root) {
        ROUTES.forEach(function (type) { root.removeEventListener(type, handlers[type]); });
      });
    }
  };
}
