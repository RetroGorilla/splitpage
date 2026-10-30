export interface FindOptions {
  readonly matchesCase: () => boolean;
  readonly setMatchCase: (value: boolean) => void;
}

export function createFindOptions(): FindOptions {
  let matchCase = false;
  return Object.freeze({
    matchesCase: (): boolean => matchCase,
    setMatchCase: (value: boolean): void => { matchCase = value; }
  });
}
