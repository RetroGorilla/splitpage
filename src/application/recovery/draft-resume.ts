export interface DraftResume {
  readonly restorePending: () => boolean;
  readonly setRestorePending: (pending: boolean) => void;
}

export function createDraftResume(): DraftResume {
  let pending = false;
  return Object.freeze({
    restorePending: function (): boolean { return pending; },
    setRestorePending: function (value: boolean): void { pending = !!value; }
  });
}
