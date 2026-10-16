export interface TourPauseHandlers {
  readonly interrupt: () => void;
  readonly offerResume: () => void;
}

let handlers: TourPauseHandlers | null = null;

export function handTourPauseTo(next: TourPauseHandlers): void {
  handlers = next;
}

export function interruptTourForDialog(): void {
  handlers?.interrupt();
}

export function offerTourResumeAfterDialog(): void {
  handlers?.offerResume();
}
