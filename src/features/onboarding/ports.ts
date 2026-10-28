import type { ActionRegistry } from "../../application/actions.ts";
import type { LaunchFacts } from "../../application/desktop-presence.ts";
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
  readonly preferences: Pick<Preferences, "onboarding" | "recordOnboarding">;
  readonly sidePanels: Pick<SidePanels, "closeAll">;
  readonly place: Pick<DocumentPlace, "home">;
  readonly draftResume: Pick<DraftResume, "restorePending">;
  readonly seedCheck: SeedCheck;
  readonly launchFacts: Pick<LaunchFacts, "firstTabOfLaunch" | "hadPriorSession" | "launchIntent" | "hasDraftToRestore">;
  readonly lastFile: LastFile;
  readonly onFileMenuChoice: (listener: () => void) => () => void;
}

export interface OnboardingActionPorts {
  readonly screen: () => ScreenState;
}
