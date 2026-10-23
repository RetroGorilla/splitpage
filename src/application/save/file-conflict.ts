export type FileConflictKind = "project" | "import";

export interface FileConflict {
  readonly fileName: string;
  readonly current: { readonly lastModified: number } | null;
  readonly kind: FileConflictKind;
}

export interface FileConflicts {
  readonly current: () => FileConflict | null;
  readonly show: (conflict: FileConflict) => void;
  readonly close: () => void;
  readonly onChange: (listener: () => void) => () => void;
  readonly stop: () => void;
}

export function createFileConflicts(): FileConflicts {
  const listeners = new Set<() => void>();
  let open: FileConflict | null = null;

  function announce(): void {
    Array.from(listeners).forEach(function (listener) { listener(); });
  }

  return Object.freeze({
    current: function () { return open; },
    show: function (conflict: FileConflict) {
      open = Object.freeze({ fileName: conflict.fileName, current: conflict.current, kind: conflict.kind });
      announce();
    },
    close: function () {
      open = null;
      announce();
    },
    onChange: function (listener: () => void) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    },
    stop: function () {
      listeners.clear();
      open = null;
    }
  });
}
