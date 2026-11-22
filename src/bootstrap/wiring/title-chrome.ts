import { startDocumentChrome } from "../../features/title/document-chrome.ts";
import type { DocumentChromeControl, DocumentChromePorts } from "../../features/title/ports.ts";
import { targetActions as definitions } from "../../features/title/actions.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentReader } from "./ports/document.ts";
import { edits } from "./ports/editing.ts";
import { personColors } from "./ports/person-colors.ts";
import { notices } from "./ports/effects.ts";
import { chromePreferences } from "./ports/preferences.ts";
import { screen } from "./ports/screen.ts";

const chrome = owned<DocumentChromeControl>();
export function titleChromeControls(): DocumentChromeControl {
  const current = chrome.owner();
  if (!current) throw new Error("The document chrome is not started yet");
  return current;
}
export function mountTitleChromeFeature(): DocumentChromeControl {
  return chrome.replace(() => {
    const ports: DocumentChromePorts = {
      document: documentReader, edits, personColors, notices,
      preferences: chromePreferences
    };
    return startDocumentChrome(ports);
  });
}
export const stopTitleChromeFeature = chrome.stop;
export const targetActions = () => definitions(titleChromeControls, screen);
export const personSwatchesHtml: DocumentChromeControl["personSwatchesHtml"] = (...args) => titleChromeControls().personSwatchesHtml(...args);
export const promptForName = () => { titleChromeControls().promptForName(); };
export const promptForWpm = () => { titleChromeControls().promptForWpm(); };
export const promptForTarget = () => { titleChromeControls().promptForTarget(); };
export const identityChipListeners = () => titleChromeControls().identityChipListeners();
