export interface TourPause {
  readonly interrupt: () => void;
  readonly offerResume: () => void;
}
