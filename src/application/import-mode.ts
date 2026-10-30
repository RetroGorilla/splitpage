export interface ImportMode {
  readonly touched: () => boolean;
  readonly touch: () => void;
  readonly reset: () => void;
}

export function createImportMode(): ImportMode {
  let touched = false;
  return Object.freeze({
    touched: (): boolean => touched,
    touch: (): void => { touched = true; },
    reset: (): void => { touched = false; }
  });
}
