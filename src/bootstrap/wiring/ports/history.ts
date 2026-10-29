import type { HistoryOwnerPorts } from "../../../application/recovery/history-ports.ts";
import type { LegacySnapshots } from "../../../application/recovery/legacy-snapshots.ts";
import { createHistoryBackends } from "../../../adapters/storage/history-backends.js";
import { inlineStateJson } from "../../../adapters/storage/02c-blobs.js";
import { historyDesktop } from "./desktop.ts";
import { getEditorName } from "../preferences-owner.ts";
import { saveChanges, unsavedChanges } from "../save-owners.ts";
import { legacySnapshots } from "../recovery-owners.ts";
import { documentReader } from "./document.ts";
import { homes } from "./location.ts";
import { notices } from "./effects.ts";
import { pictures } from "./pictures.ts";
import { ids } from "./identity.ts";
import { seedCheck } from "./startup.ts";

export function historyPorts(snapshots: LegacySnapshots = legacySnapshots()): HistoryOwnerPorts {
  return {
    document: documentReader,
    location: homes,
    preferences: { editorName: getEditorName },
    saving: { changes: saveChanges, unsaved: unsavedChanges },
    recovery: snapshots,
    effects: notices,
    pictures,
    inlinePictures: inlineStateJson,
    ids,
    seed: seedCheck,
    logger: console,
    now: () => Date.now(),
    decodeBase64: (text) => atob(text),
    yield: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
    desktop: historyDesktop,
    storage: createHistoryBackends
  };
}
