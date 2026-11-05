export interface WriterRoutePorts {
  readonly format: (button: Element) => void;
}

interface WriterRoutesMount {
  readonly window: Window;
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

  function onBarClick(e: Event): void {
    const fmt = closest(e, ".wr-fmt");
    if (fmt) { ports.format(fmt); return; }
  }

  const bindings: ReadonlyArray<readonly [EventTarget, string, Listener, boolean]> = [
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
