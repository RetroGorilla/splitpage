export type UndoDirection = "undo" | "redo";

export interface UndoHooks {
  readonly commentsAreSent: () => boolean;
  readonly afterApply: (steps: readonly unknown[], dir: UndoDirection) => void;
  readonly onRefused: (reason: string | undefined, dir: UndoDirection) => void;
}

export interface UndoRoutePorts {
  readonly replay: (dir: UndoDirection) => void;
  readonly writerStep: (dir: UndoDirection) => boolean;
  readonly stale: () => boolean;
  readonly reviewOnly: () => boolean;
  readonly scriptCell: (el: Element) => boolean;
  readonly latest: () => unknown;
  readonly warn: (message: string) => void;
  readonly commentsAreSent: () => boolean;
  readonly afterReplay: (steps: readonly unknown[], dir: UndoDirection) => void;
  readonly install: (hooks: UndoHooks) => () => void;
}

export interface UndoRoutesMount {
  readonly window: Window;
  readonly roots: readonly Element[];
  readonly ports: UndoRoutePorts;
}

export interface UndoRoutes {
  readonly key: (e: KeyboardEvent) => boolean;
  readonly step: (dir: UndoDirection) => void;
  readonly undoIfLatest: (entry: unknown) => void;
  readonly dispose: () => void;
}

type Realm = Window & typeof globalThis;

const MOVED_ON = "Something else has changed since — Ctrl+Z undoes one step at a time.";

export function undoGesture(e: KeyboardEvent): UndoDirection | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const z = e.key === "z" || e.key === "Z";
  const y = e.key === "y" || e.key === "Y";
  if ((z && e.shiftKey) || (y && !e.shiftKey)) return "redo";
  return z ? "undo" : null;
}

export function mountUndoRoutes(mount: UndoRoutesMount): UndoRoutes {
  const ports = mount.ports;
  const realm = mount.window as Realm;
  let open = true;

  function scriptCellAround(target: EventTarget | null): boolean {
    if (!(target instanceof realm.Element)) return false;
    const cell = target.closest(".cell-editable");
    return cell !== null && ports.scriptCell(cell);
  }

  function ownsItsUndo(el: Element | null): boolean {
    if (!el || el === realm.document.body) return false;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    if (el instanceof realm.HTMLElement && el.isContentEditable) return !scriptCellAround(el);
    return false;
  }

  function step(dir: UndoDirection): void {
    if (!open || ports.stale()) return;
    if (ports.writerStep(dir)) return;
    ports.replay(dir);
  }

  function key(e: KeyboardEvent): boolean {
    if (!open || e.defaultPrevented) return false;
    const dir = undoGesture(e);
    if (!dir) return false;
    if (ownsItsUndo(realm.document.activeElement)) return false;
    if (ports.reviewOnly()) return false;
    e.preventDefault();
    step(dir);
    return true;
  }

  function inRoot(target: EventTarget | null): boolean {
    return target instanceof realm.Node && mount.roots.some((root) => root.contains(target));
  }

  function onWindowKeydown(e: Event): void {
    if (inRoot(e.target)) return;
    key(e as KeyboardEvent);
  }

  function onBeforeInput(e: Event): void {
    const inputType = (e as InputEvent).inputType;
    if (inputType !== "historyUndo" && inputType !== "historyRedo") return;
    if (!scriptCellAround(e.target)) return;
    e.preventDefault();
    step(inputType === "historyRedo" ? "redo" : "undo");
  }

  let release: (() => void) | null = ports.install({
    commentsAreSent: ports.commentsAreSent,
    afterApply: ports.afterReplay,
    onRefused: (reason, dir) => { ports.warn("Could not " + dir + " — " + (reason || "the document has changed since") + "."); }
  });
  mount.window.addEventListener("keydown", onWindowKeydown);
  mount.roots.forEach((root) => { root.addEventListener("beforeinput", onBeforeInput); });

  return {
    key: key,
    step: step,
    undoIfLatest(entry: unknown): void {
      if (!open) return;
      if (ports.latest() === entry) ports.replay("undo");
      else ports.warn(MOVED_ON);
    },
    dispose(): void {
      if (!open) return;
      open = false;
      mount.window.removeEventListener("keydown", onWindowKeydown);
      mount.roots.forEach((root) => { root.removeEventListener("beforeinput", onBeforeInput); });
      const done = release;
      release = null;
      done?.();
    }
  };
}
