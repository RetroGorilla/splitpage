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

export function captureSessionCapabilities(source: CapabilityPort): CapabilityPort {
  function hold(name: StandaloneCapabilityName): Capability {
    const answer = source[name]();
    return answer.allowed ? Object.freeze({ allowed: true }) : Object.freeze({ allowed: false, reason: answer.reason });
  }
  const answers = {
    saveDestinations: hold("saveDestinations"),
    autosave: hold("autosave"),
    merge: hold("merge"),
    stash: hold("stash"),
    drafts: hold("drafts"),
    history: hold("history"),
    folders: hold("folders"),
    bundles: hold("bundles")
  } satisfies Record<StandaloneCapabilityName, Capability>;
  return Object.freeze({
    saveDestinations: () => answers.saveDestinations,
    autosave: () => answers.autosave,
    merge: () => answers.merge,
    stash: () => answers.stash,
    drafts: () => answers.drafts,
    history: () => answers.history,
    folders: () => answers.folders,
    bundles: () => answers.bundles,
    edit: () => source.edit(),
    comment: () => source.comment()
  });
}
