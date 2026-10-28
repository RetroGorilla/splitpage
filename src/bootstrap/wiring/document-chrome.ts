import { onSessionChange } from "../../legacy/session-bridge.ts";
import { documentLocation, serverStatus } from "../../legacy/location-bridge.ts";
import { onPreferenceChange, viewFlags } from "../../legacy/preferences-bridge.ts";
import { onSaveChange } from "../../legacy/save-bridge.ts";
import { identityChipListeners } from "./title-chrome.ts";
import { saveStatusListeners } from "./save-status.ts";
import { presence } from "../../legacy/presence-bridge.ts";
import { localFileMenuControls } from "./local-files.ts";
import { refreshOpenFileMenu } from "./file-menu-controls.ts";
import { desktopDocumentListeners } from "../../legacy/desktop-bridge.ts";

let stopChrome: (() => void) | null = null;

export function mountDocumentChromeFeature(): void {
  stopDocumentChromeFeature();
  const stops: (() => void)[] = [];
  for (const refresh of [(...args: Parameters<ReturnType<typeof localFileMenuControls>["updateFileChip"]>) => localFileMenuControls().updateFileChip(...args), (...args: Parameters<ReturnType<typeof localFileMenuControls>["mirrorFileChipToWriter"]>) => localFileMenuControls().mirrorFileChipToWriter(...args), refreshOpenFileMenu]) {
    const chip = localFileMenuControls().fileChipListeners(refresh);
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
      if (change.flag === "writerOpen" && change.value) localFileMenuControls().mirrorFileChipToWriter();
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
