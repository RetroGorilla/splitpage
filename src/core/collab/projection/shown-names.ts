import { TITLE_MAX } from "../../document/file-title.ts";
import { cappedLongText, cappedText } from "../../document/text-policy.ts";
import { SCENE_NAME_MAX } from "../../flow/flow.ts";

export function sharedShownTitle(title: string): string {
  return Array.from(title).length > TITLE_MAX ? cappedLongText(title, TITLE_MAX) : title;
}

export function sharedShownSceneName(name: string): string {
  return Array.from(name).length > SCENE_NAME_MAX ? cappedText(name, SCENE_NAME_MAX) : name;
}

export function sharedNameLimit(field: string): number | null {
  return field === "title" ? TITLE_MAX : field === "heading" ? SCENE_NAME_MAX : null;
}

export function sharedShownName(field: string, text: string): string {
  return field === "title" ? sharedShownTitle(text) : field === "heading" ? sharedShownSceneName(text) : text;
}
