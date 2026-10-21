export interface MediaRoutePorts {
  readonly choose: () => void;
  readonly addPicture: (rowId: string, file: File, slot: number | undefined) => void;
  readonly removePicture: (rowId: string, slot: number) => void;
  readonly removeLink: (rowId: string, slot: number, key: string) => void;
  readonly openLink: (rowId: string, slot: number, key: string) => void;
}

export interface MediaRoutesMount {
  readonly window: Window;
  readonly fileInput: HTMLInputElement;
  readonly ports: MediaRoutePorts;
}

export interface MediaRoutes {
  readonly pickerClick: (e: MouseEvent) => boolean;
  readonly linkClick: (e: MouseEvent) => boolean;
  readonly pick: (rowId: string) => void;
  readonly dispose: () => void;
}

type Realm = Window & typeof globalThis;

const PICKER = '[data-action="image-add"], [data-action="image-add-more"], [data-action="image-replace"]';

export function mountMediaRoutes(mount: MediaRoutesMount): MediaRoutes {
  const ports = mount.ports;
  const realm = mount.window as Realm;
  const input = mount.fileInput;
  let pendingRow: string | null = null;
  let pendingSlot: number | undefined;
  let open = true;

  function closest(e: Event, selector: string): Element | null {
    const target = e.target;
    return target instanceof realm.Element ? target.closest(selector) : null;
  }

  function idOf(el: Element): string {
    return el.getAttribute("data-id") || "";
  }

  function slotOf(el: Element): number {
    return Number(el.getAttribute("data-slot")) || 0;
  }

  function onChange(): void {
    const files = input.files;
    const file = files && files[0];
    const rowId = pendingRow;
    if (file && rowId) ports.addPicture(rowId, file, pendingSlot);
    input.value = "";
    pendingRow = null;
    pendingSlot = undefined;
  }

  input.addEventListener("change", onChange);

  return {
    pickerClick(e: MouseEvent): boolean {
      if (!open) return false;
      const add = closest(e, PICKER);
      if (add) {
        pendingRow = idOf(add);
        pendingSlot = add.getAttribute("data-action") === "image-replace" ? slotOf(add) : undefined;
        ports.choose();
        return true;
      }
      const remove = closest(e, '[data-action="image-remove"]');
      if (remove) { ports.removePicture(idOf(remove), slotOf(remove)); return true; }
      return false;
    },
    linkClick(e: MouseEvent): boolean {
      if (!open) return false;
      const off = closest(e, '[data-action="gallery-link-remove"]');
      if (off) { ports.removeLink(idOf(off), slotOf(off), off.getAttribute("data-key") || ""); return true; }
      const link = closest(e, '[data-action="gallery-link"]');
      if (link) {
        e.preventDefault();
        ports.openLink(idOf(link), slotOf(link), link.getAttribute("data-key") || "");
        return true;
      }
      return false;
    },
    pick(rowId: string): void {
      if (!open) return;
      pendingRow = rowId;
      ports.choose();
    },
    dispose(): void {
      if (!open) return;
      open = false;
      pendingRow = null;
      pendingSlot = undefined;
      input.removeEventListener("change", onChange);
    }
  };
}
