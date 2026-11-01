import type { ExternalLinks } from "../../application/desktop-presence.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";

export interface UpdateActionPorts {
  readonly screen: () => ScreenState;
  readonly showAbout: () => void;
}

export interface UpdateStatus {
  readonly version?: string | null;
  readonly latest?: string | null;
  readonly updateAvailable?: boolean;
  readonly canInstall?: boolean;
  readonly checking?: boolean;
  readonly error?: string | null | undefined;
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

export interface UpdateFeaturePorts extends UpdatePorts {
  readonly preferences: Pick<Preferences, "desktopNoticeDismissed" | "dismissDesktopNotice">;
  readonly externalLinks: ExternalLinks;
  readonly desktop: () => boolean;
}

export interface UpdateMount {
  readonly loadUpdateStatus: () => () => void;
  readonly dismissUpdateNotice: () => void;
  readonly renderDesktopAppNotice: () => () => void;
  readonly dismissDesktopAppNotice: () => void;
  readonly desktopAppOffered: () => boolean;
  readonly desktopAppUrl: () => string;
  readonly showAbout: () => void;
  readonly readEmbeddedVersion: () => string | null;
  readonly dispose: () => void;
}
