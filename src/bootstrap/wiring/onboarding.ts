import type { ActionDefinition } from "../../application/actions.ts";
import { actions as portActions } from "./ports/actions.ts";
import { panelControl as portSidePanels } from "./ports/panels.ts";
import { place as portPlace } from "./ports/location.ts";
import { lastFile as portLastFile } from "./ports/files.ts";
import { draftResume as portDraftResume, seedCheck as portSeedCheck } from "./ports/startup.ts";
import { launch as portLaunch } from "./ports/desktop.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { presence } from "./ports/desktop-presence.ts";
import { onboardingActions as definitions } from "../../features/onboarding/actions.ts";
import { startOnboarding as mountOnboarding } from "../../features/onboarding/onboarding.ts";
import type { OnboardingMount, OnboardingPorts } from "../../features/onboarding/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { localFileMenuControls } from "./local-files.ts";
import { preferences } from "./preferences-owner.ts";

const onboarding = owned<OnboardingMount>();

export function mountOnboardingFeature(): OnboardingMount {
  return onboarding.replace(() => {
    const ports: OnboardingPorts = {
      desktop: presence.running,
      actions: portActions,
      preferences: {
        onboarding: () => preferences().onboarding(),
        recordOnboarding: (skipped, at) => preferences().recordOnboarding(skipped, at)
      },
      sidePanels: portSidePanels,
      place: portPlace,
      draftResume: portDraftResume,
      seedCheck: portSeedCheck,
      launchFacts: portLaunch,
      lastFile: portLastFile,
      onFileMenuChoice: (listener) => localFileMenuControls().onFileMenuChoice(listener)
    };
    return mountOnboarding(ports);
  });
}

export const stopOnboardingFeature = onboarding.stop;

export function onboardingActions(): ActionDefinition[] {
  return definitions(onboarding.owner, { screen: portScreen });
}
