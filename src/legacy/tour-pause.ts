import type { TourPause } from "../application/tour-pause.ts";

let handlers: TourPause | null = null;

export function handTourPauseTo(next: TourPause): void {
  handlers = next;
}

export function interruptTourForDialog(): void {
  handlers?.interrupt();
}

export function offerTourResumeAfterDialog(): void {
  handlers?.offerResume();
}
