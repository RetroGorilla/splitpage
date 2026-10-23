export interface LastFile {
  readonly load: () => Promise<unknown | null>;
}
