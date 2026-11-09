import type { ActionDefinition } from "../../application/actions.ts";
import { OPENS_A_DIALOG, availableUnless } from "../../application/screen.ts";
import type { OnboardingActionPorts, OnboardingMount } from "./ports.ts";

export function onboardingActions(current: () => OnboardingMount | null, ports: OnboardingActionPorts): ActionDefinition[] {
  return [{
    id: "setup",
    label: "Getting started…",
    group: "Help",
    icon: "i-sliders",
    words: "setup set up settings wizard install introduction formats",
    availability: () => current() ? availableUnless(OPENS_A_DIALOG, ports.screen()) : { enabled: false },
    run: () => { current()?.openOnboarding(); }
  }];
}
