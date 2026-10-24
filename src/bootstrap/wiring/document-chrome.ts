import { onSessionChange } from "../../legacy/session-bridge.ts";
import { documentLocation, serverStatus } from "../../legacy/location-bridge.ts";
import { onPreferenceChange, viewFlags } from "../../legacy/preferences-bridge.ts";
import { onSaveChange } from "../../legacy/save-bridge.ts";
import { identityChipListeners } from "../../js/03-sync.js";
import { saveStatusListeners } from "../../js/12-dirty-toast.js";
import { presence } from "../../legacy/presence-bridge.ts";
import { fileChipListeners, mirrorFileChipToWriter, updateFileChip } from "../../js/18-local-files.js";
import { refreshOpenFileMenu } from "../../js/18b-file-menu.js";
import { desktopDocumentListeners } from "../../js/20f-desktop.js";

let stopChrome: (() => void) | null = null;

export function mountDocumentChromeFeature(): void {
  stopDocumentChromeFeature();
  const stops: (() => void)[] = [];
  for (const refresh of [updateFileChip, mirrorFileChipToWriter, refreshOpenFileMenu]) {
    const chip = fileChipListeners(refresh);
    stops.push(
      onSessionChange(chip.session),
      documentLocation().onChange(chip.location),
      serverStatus().onChange(chip.status),
      onSaveChange(chip.save)
    );
  }
  const status = saveStatusListeners();
  stops.push(
    onSaveChange(status.save),
    documentLocation().onChange(status.location),
    serverStatus().onChange(status.status),
    onPreferenceChange(status.preference)
  );
  status.paint();
  const identity = identityChipListeners();
  const desktop = desktopDocumentListeners();
  stops.push(
    onSessionChange(identity.session),
    onPreferenceChange(identity.preference),
    presence().onRecolor(identity.colours),
    onSessionChange(desktop.session),
    documentLocation().onChange(desktop.location),
    onSaveChange(desktop.save),
    viewFlags().onChange((change) => {
      if (change.flag === "writerOpen" && change.value) mirrorFileChipToWriter();
    })
  );
  stopChrome = () => {
    while (stops.length) stops.pop()?.();
  };
}

export function stopDocumentChromeFeature(): void {
  const stop = stopChrome;
  stopChrome = null;
  stop?.();
}
