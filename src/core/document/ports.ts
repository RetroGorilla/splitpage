export interface ImageRef {
  sha256: string;
  width: number;
  height: number;
  mime: string;
}

export interface IdSource {
  id(prefix: string): string;
  docId(): string;
}

export interface ImageSource {
  known(sha: string): ImageRef | null;
  fromDataUrl(url: string): ImageRef | null;
}

export interface Clock {
  nowIso(): string;
}
