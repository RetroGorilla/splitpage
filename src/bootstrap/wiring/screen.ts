import { onRefresh, onSessionChange, onStamped } from "./session-owner.ts";
import { documentLocation } from "./location-owner.ts";
import { onPreferenceChange, preferences, viewFlags } from "../../legacy/preferences-bridge.ts";
import { shotHiding } from "./shot-hiding.ts";
import { screenListeners } from "../../features/rows/render.js";

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
    onStamped(screen.stamped),
    shotHiding().onHiding(screen.hiding),
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
