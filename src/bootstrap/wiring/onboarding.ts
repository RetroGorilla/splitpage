import type { ActionDefinition } from "../../application/actions.ts";
import { actions as portActions } from "./ports/actions.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { panelControl as portSidePanels } from "./ports/panels.ts";
import { place as portPlace } from "./ports/location.ts";
import { fileDelivery as portFileDelivery, lastFile as portLastFile } from "./ports/files.ts";
import { draftResume as portDraftResume, seedCheck as portSeedCheck } from "./ports/startup.ts";
import { launch as portLaunch } from "./ports/desktop.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { onboardingActions as definitions } from "../../features/onboarding/actions.ts";
import { startOnboarding as mountOnboarding } from "../../features/onboarding/onboarding.js";
import type { OnboardingMount, OnboardingPorts } from "../../features/onboarding/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { launcherFetch } from "../../js/13-hosted.js";
import { localFileMenuControls } from "./local-files.ts";
import { addServerBookmark } from "../../js/20e-connect.js";
import { preferences } from "../../legacy/preferences-bridge.ts";

const onboarding = owned<OnboardingMount>();

export function mountOnboardingFeature(): OnboardingMount {
  return onboarding.replace(() => {
    const ports: OnboardingPorts = {
      desktop: runningOnDesktop,
      actions: portActions,
      notices: portNotices,
      preferences: {
        onboarding: () => preferences().onboarding(),
        recordOnboarding: (skipped, at) => preferences().recordOnboarding(skipped, at)
      },
      sidePanels: portSidePanels,
      place: portPlace,
      fileDelivery: portFileDelivery,
      draftResume: portDraftResume,
      seedCheck: portSeedCheck,
      launchFacts: portLaunch,
      lastFile: portLastFile,
      launcherInfo: () => launcherFetch("api/launcher/info"),
      onFileMenuChoice: (listener) => localFileMenuControls().onFileMenuChoice(listener),
      addServerBookmark: (name, url, options) => addServerBookmark(name, url, options)
    };
    return mountOnboarding(ports);
  });
}

export const stopOnboardingFeature = onboarding.stop;

export function onboardingActions(): ActionDefinition[] {
  return definitions(onboarding.owner, { screen: portScreen });
}
