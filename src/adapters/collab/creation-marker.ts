import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";

export const SHARED_CREATION_RETIREMENT_FIELD = "creationRetired";

export function readSharedCreationMarkers(handle: SharedDocumentHandle) { return collabState(handle).roots.creationRetired; }
