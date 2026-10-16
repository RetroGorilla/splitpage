export interface WriterRoutePorts {
  readonly input: (e: Event) => void;
  readonly keydown: (e: Event) => void;
  readonly editKeydown: (e: KeyboardEvent) => void;
  readonly format: (button: Element) => void;
  readonly gutter: () => void;
  readonly exportNarration: () => void;
}

export interface WriterRoutesMount {
  readonly window: Window;
  readonly doc: Element;
  readonly bar: Element;
  readonly ports: WriterRoutePorts;
}

export interface WriterRoutes {
  readonly dispose: () => void;
}

type Realm = Window & typeof globalThis;
type Listener = (e: Event) => void;

export function mountWriterRoutes(mount: WriterRoutesMount): WriterRoutes {
  const ports = mount.ports;
  const realm = mount.window as Realm;
  let open = true;

  function closest(e: Event, selector: string): Element | null {
    const target = e.target;
    return target instanceof realm.Element ? target.closest(selector) : null;
  }

  function onEditKeydown(e: Event): void {
    ports.editKeydown(e as KeyboardEvent);
  }

  function onBarClick(e: Event): void {
    const fmt = closest(e, ".wr-fmt");
    if (fmt) { ports.format(fmt); return; }
    if (closest(e, "#wr-gutter-mode")) { ports.gutter(); return; }
    if (closest(e, "#wr-export")) ports.exportNarration();
  }

  const bindings: ReadonlyArray<readonly [EventTarget, string, Listener, boolean]> = [
    [mount.doc, "input", ports.input, false],
    [mount.doc, "keydown", ports.keydown, false],
    [mount.doc, "keydown", onEditKeydown, true],
    [mount.bar, "click", onBarClick, false]
  ];
  bindings.forEach(([target, type, fn, capture]) => { target.addEventListener(type, fn, capture); });

  return {
    dispose(): void {
      if (!open) return;
      open = false;
      bindings.forEach(([target, type, fn, capture]) => { target.removeEventListener(type, fn, capture); });
    }
  };
}
