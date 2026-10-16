export interface VideoPopoverPorts {
  readonly confirm: (wrap: Element | null) => void;
  readonly cancel: (wrap: Element | null) => void;
}

export interface VideoPopoverMount {
  readonly window: Window;
  readonly ports: VideoPopoverPorts;
}

export interface VideoPopoverRoutes {
  readonly click: (e: MouseEvent) => boolean;
  readonly keydown: (e: KeyboardEvent) => boolean;
  readonly dispose: () => void;
}

type Realm = Window & typeof globalThis;

const WRAP = ".field-wrap";

export function mountVideoPopover(mount: VideoPopoverMount): VideoPopoverRoutes {
  const ports = mount.ports;
  const realm = mount.window as Realm;
  let open = true;

  function targetOf(e: Event): Element | null {
    return e.target instanceof realm.Element ? e.target : null;
  }

  return {
    click(e: MouseEvent): boolean {
      if (!open) return false;
      const target = targetOf(e);
      if (!target) return false;
      const confirm = target.closest('[data-action="video-confirm"]');
      if (confirm) { ports.confirm(confirm.closest(WRAP)); return true; }
      const cancel = target.closest('[data-action="video-cancel"]');
      if (cancel) { ports.cancel(cancel.closest(WRAP)); return true; }
      return false;
    },
    keydown(e: KeyboardEvent): boolean {
      if (!open) return false;
      const target = targetOf(e);
      if (!target || !target.matches(".video-popover input")) return false;
      if (e.key === "Enter") {
        e.preventDefault();
        ports.confirm(target.closest(WRAP));
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ports.cancel(target.closest(WRAP));
      }
      return true;
    },
    dispose(): void {
      open = false;
    }
  };
}
