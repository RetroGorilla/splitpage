import type { ActionRegistry } from "../../application/actions.ts";
import type { LaunchFacts } from "../../application/desktop-presence.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { FileDelivery } from "../../application/files/file-delivery.ts";
import type { LastFile } from "../../application/files/last-file.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { SeedCheck } from "../../application/preferences/seed-check.ts";
import type { DraftResume } from "../../application/recovery/draft-resume.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { SidePanels } from "../../application/side-panels.ts";

export interface OnboardingMount {
  readonly openOnboarding: () => void;
  readonly dispose: () => void;
}

export interface OnboardingPorts {
  readonly desktop: () => boolean;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly notices: Pick<NoticePort, "show">;
  readonly preferences: Pick<Preferences, "onboarding" | "recordOnboarding">;
  readonly sidePanels: Pick<SidePanels, "closeAll">;
  readonly place: Pick<DocumentPlace, "home" | "arrivingOnLink">;
  readonly fileDelivery: FileDelivery;
  readonly draftResume: Pick<DraftResume, "restorePending">;
  readonly seedCheck: SeedCheck;
  readonly launchFacts: LaunchFacts;
  readonly lastFile: LastFile;
  readonly launcherInfo: () => Promise<{ readonly root?: string } | null>;
  readonly onFileMenuChoice: (listener: () => void) => () => void;
  readonly addServerBookmark: (name: string, url: string, options: { readonly pin: string; readonly remember: boolean }) => Promise<{
    readonly ok: boolean;
    readonly error?: string;
    readonly bookmark?: { readonly name: string };
  }>;
}

export interface OnboardingActionPorts {
  readonly screen: () => ScreenState;
}
