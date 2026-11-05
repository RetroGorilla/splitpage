interface ClipboardRoutePorts<Owner, Place, Extra> {
  readonly scriptCell: (el: Element) => boolean;
  readonly copy: (e: ClipboardEvent, cell: Element, cut: boolean) => boolean;
  readonly afterCut: (cell: Element) => void;
  readonly pasteBeats: (data: DataTransfer | null, cell: Element) => boolean;
  readonly pasteDraft: (cell: Element, html: string, text: string) => void;
  readonly hasMedia: (files: FileList | readonly File[] | null | undefined, html: string) => boolean;
  readonly readMedia: (files: FileList | readonly File[], html: string) => Promise<Extra>;
  readonly capture: () => Owner;
  readonly stillOwns: (owner: Owner) => boolean;
  readonly notAdded: () => void;
  readonly placeOf: (cell: Element) => Place;
  readonly restorePlace: (cell: Element, place: Place) => void;
  readonly findCell: (rowId: string, field: string) => Element | null;
  readonly insertNow: (cell: Element, html: string, text: string, extra: Extra | null, fromPaste: boolean) => void;
}

interface ClipboardRoutesMount<Owner, Place, Extra> {
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

export function mountFlowClipboardRoutes(root: HTMLElement, handlers: Readonly<Record<(typeof ROUTES)[number], (event: ClipboardEvent) => void>>): () => void {
  const routes = ROUTES.map(type => {
    const handler = (event: Event): void => {
      if (event.defaultPrevented) return;
      if (type === "paste") event.preventDefault();
      handlers[type](event as ClipboardEvent);
    };
    root.addEventListener(type, handler);
    return () => { root.removeEventListener(type, handler); };
  });
  return () => { routes.forEach(dispose => { dispose(); }); };
}

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
    if (!ports.copy(e, cell, cut) || !cut) return;
    const active = realm.document.activeElement;
    const fresh = active && active.closest ? active.closest(".cell-editable") : null;
    ports.afterCut(fresh || cell);
  }

  function insert(cell: Element, html: string, text: string, files: FileList | readonly File[] | null | undefined, fromPaste = false): void {
    if (!open) return;
    if (!ports.hasMedia(files, html)) {
      ports.insertNow(cell, html, text, null, fromPaste);
      return;
    }
    const rowId = cell.getAttribute("data-id") || "";
    const field = cell.getAttribute("data-field") || "";
    const owner = ports.capture();
    const place = ports.placeOf(cell);
    void ports.readMedia(files || [], html).then(function (extra) {
      if (!open) return;
      if (!ports.stillOwns(owner)) { ports.notAdded(); return; }
      const live = cell.isConnected ? cell : ports.findCell(rowId, field);
      if (!live) return;
      if (html || text) ports.restorePlace(live, place);
      ports.insertNow(live, html, text, extra, fromPaste);
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
    if (ports.pasteBeats(data, cell)) return;
    if (!data) return;
    insert(cell, data.getData("text/html"), data.getData("text/plain"), data.files, true);
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
