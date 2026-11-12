import { SHARED_SESSION_DISABLED } from "./ports.ts";
import type { Capability, CapabilityPort, StandaloneCapabilityName } from "./ports.ts";

export function createSessionCapabilities(
  mode: "standalone" | "shared",
  common: Pick<CapabilityPort, "edit" | "comment">
): CapabilityPort {
  const entries = (Object.keys(SHARED_SESSION_DISABLED) as StandaloneCapabilityName[]).map((name) => {
    const answer: Capability = mode === "standalone"
      ? Object.freeze({ allowed: true })
      : Object.freeze({ allowed: false, reason: SHARED_SESSION_DISABLED[name] });
    return [name, () => answer] as const;
  });
  const standalone = Object.fromEntries(entries) as Pick<CapabilityPort, StandaloneCapabilityName>;
  return Object.freeze({ ...common, ...standalone });
}
