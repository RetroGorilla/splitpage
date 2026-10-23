export interface DesktopVideoResult {
  readonly ok?: boolean;
  readonly code?: string;
  readonly bytes?: unknown;
  readonly mime?: string;
}

export interface DesktopVideo {
  readonly present: () => boolean;
  readonly grant: (file: unknown) => Promise<string | null> | null;
  readonly opens: () => boolean;
  readonly open: (token: string) => Promise<DesktopVideoResult | null>;
  readonly thumbnail: (host: string, ref: string) => Promise<DesktopVideoResult | null> | null;
}
