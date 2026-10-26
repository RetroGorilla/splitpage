import type { ActionDefinition } from "../../application/actions.ts";
import { OPENS_A_DIALOG, availableUnless } from "../../application/screen.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { ImportDialogControls } from "./ports.ts";

export function importActions(owner: () => ImportDialogControls | null, screen: () => ScreenState): ActionDefinition[] {
  return [
    {
      id: "gdoc-import",
      label: "Import: Google Doc link…",
      group: "File",
      icon: "i-link",
      words: "import google docs link url",
      availability: () => availableUnless(["loading", ...OPENS_A_DIALOG], screen()),
      run: () => { owner()?.openGdocModal(); }
    },
    {
      id: "show-gdoc-import",
      label: "Show the Google Docs import",
      group: "File",
      availability: () => ({ enabled: true, visible: false }),
      run: () => { owner()?.openGdocModal(); }
    }
  ];
}
