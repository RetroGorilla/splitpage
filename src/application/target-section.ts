export interface TargetSection<E> {
  readonly html: () => string;
  readonly wire: (wrap: E, close: () => void) => void;
}
