export type FormatCommand = "bold" | "italic" | "underline";

export interface EditorToolbarPorts {
  readonly command: (button: Element) => void;
  readonly confirmLink: (wrap: Element | null) => void;
  readonly cancelLink: (wrap: Element | null) => void;
  readonly format: (cell: Element, command: FormatCommand) => void;
}

export interface EditorToolbarMount {
  readonly window: Window;
  readonly ports: EditorToolbarPorts;
}

export interface EditorToolbarRoutes {
  readonly click: (e: MouseEvent) => boolean;
  readonly keydown: (e: KeyboardEvent) => boolean;
  readonly formatKey: (e: KeyboardEvent, cell: Element) => boolean;
  readonly dispose: () => void;
}

type Realm = Window & typeof globalThis;

const WRAP = ".field-wrap";

const FORMAT_KEYS: Readonly<Record<string, FormatCommand>> = { b: "bold", i: "italic", u: "underline" };

function formatCommandOf(key: string): FormatCommand | null {
  const k = key.toLowerCase();
  return Object.prototype.hasOwnProperty.call(FORMAT_KEYS, k) ? FORMAT_KEYS[k] ?? null : null;
}

export function mountEditorToolbar(mount: EditorToolbarMount): EditorToolbarRoutes {
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
      const button = target.closest(".mini-toolbar button[data-cmd]");
      if (button) { ports.command(button); return true; }
      const confirm = target.closest('[data-action="link-confirm"]');
      if (confirm) { ports.confirmLink(confirm.closest(WRAP)); return true; }
      const cancel = target.closest('[data-action="link-cancel"]');
      if (cancel) { ports.cancelLink(cancel.closest(WRAP)); return true; }
      return false;
    },
    keydown(e: KeyboardEvent): boolean {
      if (!open) return false;
      const target = targetOf(e);
      if (!target || !target.matches(".link-popover input")) return false;
      if (e.key === "Enter") {
        e.preventDefault();
        ports.confirmLink(target.closest(WRAP));
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ports.cancelLink(target.closest(WRAP));
      }
      return true;
    },
    formatKey(e: KeyboardEvent, cell: Element): boolean {
      if (!open) return false;
      if (!(e.ctrlKey || e.metaKey)) return false;
      const command = formatCommandOf(String(e.key || ""));
      if (!command) return false;
      e.preventDefault();
      ports.format(cell, command);
      return true;
    },
    dispose(): void {
      open = false;
    }
  };
}
