import { SHARED_SESSION_DISABLED } from "./ports.ts";
import type { Capability, CapabilityPort, StandaloneCapabilityName } from "./ports.ts";

export function createSessionCapabilities(
  mode: "standalone" | "shared",
  common: Pick<CapabilityPort, "edit" | "comment">
): CapabilityPort {
  function answer(name: StandaloneCapabilityName): () => Capability {
    const permission: Capability = mode === "standalone"
      ? Object.freeze({ allowed: true })
      : Object.freeze({ allowed: false, reason: SHARED_SESSION_DISABLED[name] });
    return () => permission;
  }
  const standalone = {
    saveDestinations: answer("saveDestinations"),
    autosave: answer("autosave"),
    merge: answer("merge"),
    stash: answer("stash"),
    drafts: answer("drafts"),
    history: answer("history"),
    folders: answer("folders"),
    bundles: answer("bundles")
  } satisfies Record<StandaloneCapabilityName, () => Capability>;
  return Object.freeze({ ...standalone, edit: () => common.edit(), comment: () => common.comment() });
}
