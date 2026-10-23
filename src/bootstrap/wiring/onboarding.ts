import type { ActionDefinition } from "../../application/actions.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { onboardingActions as definitions } from "../../features/onboarding/actions.ts";
import { __init as mountOnboarding } from "../../features/onboarding/onboarding.js";
import type { OnboardingMount, OnboardingPorts } from "../../features/onboarding/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { launcherFetch } from "../../js/13-hosted.js";
import { onFileMenuChoice } from "../../js/18-local-files.js";
import { addServerBookmark } from "../../js/20e-connect.js";
import { preferences } from "../../legacy/preferences-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

const onboarding = owned<OnboardingMount>();

export function mountOnboardingFeature(): OnboardingMount {
  return onboarding.replace(() => {
    const shared = sharedPorts();
    const ports: OnboardingPorts = {
      desktop: runningOnDesktop,
      actions: shared.actions,
      notices: shared.notices,
      preferences: {
        onboarding: () => preferences().onboarding(),
        recordOnboarding: (skipped, at) => preferences().recordOnboarding(skipped, at)
      },
      sidePanels: shared.sidePanels,
      place: shared.place,
      fileDelivery: shared.fileDelivery,
      draftResume: shared.draftResume,
      seedCheck: shared.seedCheck,
      launchFacts: shared.launchFacts,
      lastFile: shared.lastFile,
      launcherInfo: () => launcherFetch("api/launcher/info"),
      onFileMenuChoice: (listener) => onFileMenuChoice(listener),
      addServerBookmark: (name, url, options) => addServerBookmark(name, url, options)
    };
    return mountOnboarding(ports);
  });
}

export const stopOnboardingFeature = onboarding.stop;

export function onboardingActions(): ActionDefinition[] {
  return definitions(onboarding.owner, { screen: sharedPorts().screen });
}
