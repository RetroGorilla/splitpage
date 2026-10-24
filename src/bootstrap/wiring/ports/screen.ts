import type { ScreenState } from "../../../application/screen.ts";
import { screenNow } from "../../../legacy/screen-state.ts";

export const screen = (): ScreenState => screenNow();
