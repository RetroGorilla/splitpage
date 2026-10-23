export interface UpdateStatus {
  readonly version?: string | null;
  readonly latest?: string | null;
  readonly updateAvailable?: boolean;
  readonly canInstall?: boolean;
  readonly checking?: boolean;
  readonly error?: string | null;
  readonly download?: {
    readonly state: "idle" | "downloading" | "ready" | "failed";
    readonly received?: number;
    readonly total?: number;
    readonly error?: string | null;
  } | null;
  readonly releaseUrl?: string | null;
  readonly desktopAppUrl?: string | null;
  readonly desktop?: boolean;
}

export interface UpdateResult {
  readonly ok?: boolean;
  readonly error?: string;
  readonly message?: string;
}

export interface UpdatePorts {
  readonly updates: {
    readonly status: () => Promise<UpdateStatus | null>;
    readonly onStatus: (listener: (status: UpdateStatus) => void) => void;
    readonly stopStatus: () => void;
    readonly download: () => Promise<UpdateResult | null>;
    readonly install: () => Promise<UpdateResult | null>;
  };
}
