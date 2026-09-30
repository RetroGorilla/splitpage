import { S } from "../js/_state.js";
import { writerOpen } from "../js/19-writer.js";
import type { ScreenState } from "./screen.ts";

export function screenNow(): ScreenState {
  const tour = document.getElementById("tour-overlay");
  return { loading: !S.state, prompter: Boolean(S.prompterOpen), writer: Boolean(writerOpen), tour: Boolean(tour && !tour.hidden) };
}

export function inDesktopApp(): boolean {
  return Boolean(S.DESKTOP);
}
