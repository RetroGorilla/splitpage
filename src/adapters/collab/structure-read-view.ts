export interface SharedStructureReadView {
  readonly get: (path: readonly string[]) => unknown;
  readonly has: (path: readonly string[]) => boolean;
  readonly kind: (path: readonly string[]) => "map" | "text" | "array" | "value" | "missing";
  readonly scratch: <T>(key: string, create: () => T) => T;
}
