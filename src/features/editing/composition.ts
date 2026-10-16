export interface CompositionCell {
  readonly rowId: string;
  readonly field: string;
}

export interface CompositionPorts<M> {
  readonly cellOf: (target: EventTarget | null) => CompositionCell | null;
  readonly epoch: () => number;
  readonly mark: (cell: CompositionCell) => M;
  readonly dropEmptySince: (mark: M, cancelled: boolean) => boolean;
}

export interface CompositionMount<M> {
  readonly roots: readonly EventTarget[];
  readonly ports: CompositionPorts<M>;
}

export interface CompositionOwner {
  readonly settle: (e: Event) => void;
  readonly composing: () => boolean;
  readonly dispose: () => void;
}

interface Held<M> {
  readonly mark: M;
  readonly cell: CompositionCell;
  readonly epoch: number;
}

export const COMPOSITION_INPUTS: ReadonlySet<string> = new Set([
  "insertCompositionText", "deleteCompositionText", "deleteByComposition", "insertFromComposition"
]);

function sameCell(a: CompositionCell, b: CompositionCell): boolean {
  return a.rowId === b.rowId && a.field === b.field;
}

function eventData(e: Event): string {
  const data = (e as CompositionEvent).data;
  return typeof data === "string" ? data : "";
}

export function mountComposition<M>(mount: CompositionMount<M>): CompositionOwner {
  const ports = mount.ports;
  let open = true;
  let composing: Held<M> | null = null;
  let ended: Held<M> | null = null;

  function live(held: Held<M> | null): Held<M> | null {
    return open && held && held.epoch === ports.epoch() ? held : null;
  }

  function onComposition(e: Event): void {
    const cell = ports.cellOf(e.target);
    if (!cell) return;
    if (e.type === "compositionstart") {
      composing = { mark: ports.mark(cell), cell: cell, epoch: ports.epoch() };
      return;
    }
    const held = live(composing);
    composing = null;
    if (!held || !sameCell(held.cell, cell)) return;
    const data = eventData(e);
    if (ports.dropEmptySince(held.mark, !data)) return;
    ended = data ? null : held;
  }

  function onKeydown(e: Event): void {
    const key = e as KeyboardEvent;
    if (!key.isComposing && key.keyCode !== 229) ended = null;
  }

  const listeners: ReadonlyArray<readonly [string, (e: Event) => void, boolean]> = [
    ["compositionstart", onComposition, false],
    ["compositionend", onComposition, false],
    ["keydown", onKeydown, true]
  ];
  mount.roots.forEach((root) => {
    listeners.forEach(([type, fn, capture]) => { root.addEventListener(type, fn, capture); });
  });

  return {
    settle(e: Event): void {
      const held = live(ended);
      ended = null;
      if (held) ports.dropEmptySince(held.mark, COMPOSITION_INPUTS.has((e as InputEvent).inputType));
    },
    composing: () => live(composing) !== null,
    dispose(): void {
      if (!open) return;
      open = false;
      composing = null;
      ended = null;
      mount.roots.forEach((root) => {
        listeners.forEach(([type, fn, capture]) => { root.removeEventListener(type, fn, capture); });
      });
    }
  };
}
