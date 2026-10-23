import type { ActionDefinition } from "../../application/actions.ts";
import { OPENS_A_DIALOG, availableUnless } from "../../application/screen.ts";
import type { OnboardingActionPorts, OnboardingMount } from "./ports.ts";

export function onboardingActions(current: () => OnboardingMount | null, ports: OnboardingActionPorts): ActionDefinition[] {
  return [{
    id: "setup",
    label: "Set up Splitpage…",
    group: "Help",
    icon: "i-sliders",
    words: "setup settings wizard install",
    availability: () => current() ? availableUnless(OPENS_A_DIALOG, ports.screen()) : { enabled: false },
    run: () => { current()?.openOnboarding(); }
  }];
}
