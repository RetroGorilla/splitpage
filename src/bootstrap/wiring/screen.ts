import { onRefresh, onSessionChange } from "../../legacy/session-bridge.ts";
import { documentLocation } from "../../legacy/location-bridge.ts";
import { onPreferenceChange, preferences, viewFlags } from "../../legacy/preferences-bridge.ts";
import { onShotHiding } from "../../js/01b-hide-shot.js";
import { onPresenceRecolor } from "../../js/13a-presence.js";
import { screenListeners } from "../../js/05-render.js";

let stopScreen: (() => void) | null = null;

export function mountScreenFeature(): void {
  stopScreenFeature();
  const screen = screenListeners();
  const stops: (() => void)[] = [
    onPreferenceChange((change) => {
      const name = preferences().nameOf(change.key);
      if (name) screen.preference(name);
    }),
    onSessionChange(screen.session),
    onRefresh(screen.refresh),
    onShotHiding(screen.hiding),
    onPresenceRecolor(screen.colours),
    documentLocation().onChange(screen.location),
    viewFlags().onChange(screen.flag)
  ];
  stopScreen = () => {
    while (stops.length) stops.pop()?.();
  };
}

export function stopScreenFeature(): void {
  const stop = stopScreen;
  stopScreen = null;
  stop?.();
}
