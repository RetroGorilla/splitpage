import type { Presence } from "../../../application/collaboration/presence.ts";
import { presence as owner } from "../../../legacy/presence-bridge.ts";

export const presence: Pick<Presence, "personColor"> = {
  personColor: (seed) => owner().personColor(seed)
};
