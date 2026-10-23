export const VIEWING_ONLY = "Viewing only — you can comment on this script, but not change it.";

export interface ReviewFacts {
  readonly reviewing: () => boolean;
  readonly refuseInReview: () => boolean;
}
