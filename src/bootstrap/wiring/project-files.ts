import { createProjectFiles } from "../../application/save/project-files.ts";
import type { ProjectFileDeferredPorts } from "../../application/save/project-files.ts";
import { buildMarkdownProject, buildSplitpageFile, parseMarkdownProject } from "../../adapters/formats/project-file.ts";
import { documentReader } from "./ports/document.ts";
import { text } from "./ports/text.ts";
import { projectFileDocument, projectFileExports, projectFileLocation, projectFileOpening, projectFileRecovery, projectFileSaving } from "./ports/project-files.ts";

let started: ReturnType<typeof createProjectFiles> | null = null;

function running(): ReturnType<typeof createProjectFiles> {
  if (!started) throw new Error("The project files are not wired yet");
  return started;
}

export function wireProjectFiles(deferred: ProjectFileDeferredPorts): ReturnType<typeof createProjectFiles> {
  started = createProjectFiles({
    deferred,
    document: documentReader,
    ...projectFileDocument,
    location: projectFileLocation,
    text,
    recovery: projectFileRecovery,
    exports: projectFileExports,
    saving: projectFileSaving,
    opening: projectFileOpening,
    codecs: { buildSplitpage: buildSplitpageFile, buildMarkdown: buildMarkdownProject, parseMarkdown: parseMarkdownProject },
    page: document
  });
  return started;
}

export function finishMarkdownRowChoice(choice: unknown): void {
  running().finishMarkdownRowChoice(choice);
}

export function mountProjectFiles(): void {
  Object.assign(window, { __splitpageFormats: running().formats });
}
