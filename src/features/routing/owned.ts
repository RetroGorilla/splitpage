export interface Disposable {
  readonly dispose: () => void;
}

export interface Owned<T extends Disposable> {
  readonly owner: () => T | null;
  readonly replace: (create: () => T, routes?: (owner: T) => readonly (() => () => void)[]) => T;
  readonly stop: () => void;
}

export function owned<T extends Disposable>(): Owned<T> {
  let current: T | null = null;
  let unroute: (() => void)[] = [];
  const stop = (): void => {
    const owner = current;
    const routes = unroute;
    current = null;
    unroute = [];
    for (const off of routes) off();
    owner?.dispose();
  };
  return {
    owner: () => current,
    replace: (create, routes) => {
      stop();
      const owner = create();
      current = owner;
      try {
        for (const route of routes ? routes(owner) : []) unroute.push(route());
      } catch (error) {
        stop();
        throw error;
      }
      return owner;
    },
    stop
  };
}
