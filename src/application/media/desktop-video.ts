export interface DesktopVideoResult {
  readonly ok?: boolean;
  readonly code?: string;
  readonly [key: string]: unknown;
}

export interface DesktopVideo {
  readonly grant: (file: unknown) => Promise<string | null>;
  readonly open: (token: string) => Promise<DesktopVideoResult | null>;
  readonly thumbnail: (host: string, ref: string) => Promise<DesktopVideoResult | null>;
}
