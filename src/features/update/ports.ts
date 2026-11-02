import type { ExternalLinks } from "../../application/desktop-presence.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";

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
  readonly releaseUrl?: unknown;
  readonly desktopAppUrl?: string | null;
  readonly desktop?: boolean;
}

export interface UpdatePorts {
  readonly updates: {
    readonly status: () => Promise<DesktopIpcResult<"splitpage:update-status"> | null>;
    readonly onStatus: (listener: (status: DesktopIpcResult<"splitpage:update-status">) => void) => void;
    readonly stopStatus: () => void;
    readonly download: () => Promise<DesktopIpcResult<"splitpage:update-download"> | null>;
    readonly install: () => Promise<DesktopIpcResult<"splitpage:update-install"> | null>;
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
