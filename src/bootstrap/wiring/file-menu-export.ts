import type { ActionDefinition } from "../../application/actions.ts";
import { brollSummaryText, exportBrollScenes, exportComments, exportFacts, exportRuns } from "../../adapters/formats/export-kit.ts";
import { breakdownRows, sceneFacts } from "../../adapters/formats/export-projections.ts";
import { exportMetaLine, toMarkdownDoc, toMarkdownTableDoc } from "../../adapters/formats/export-text.ts";
import { narrationRows } from "../../adapters/formats/docx.ts";
import { tagPrintColor } from "../../adapters/formats/print-colors.ts";
import { fileMenuExportActions as definitions } from "../../features/file-menu/actions.ts";
import { __init as mountExportDialog } from "../../features/file-menu/export-dialog.js";
import type { FileMenuExportMount, FileMenuExportPorts } from "../../features/file-menu/ports.ts";
import { captureExportDocument as capture } from "../../js/14b-export-kit.js";
import { exportBaseName, exportFileName, handleFileMenuAction, runExportAction } from "../../js/18-local-files.js";
import { fileMenuOpen, onFileMenuRefresh, toggleFileMenu } from "../../js/18b-file-menu.js";
import { sharedPorts } from "./shared-ports.ts";
import { fileMenuExport as dialog } from "./file-menu-export-controls.ts";

export function mountFileMenuExportFeature(): FileMenuExportMount {
  return dialog.replace(() => {
    const shared = sharedPorts();
    const ports: FileMenuExportPorts = {
      document: shared.document,
      text: shared.text,
      notices: shared.notices,
      menuItems: shared.menuItems,
      exports: shared.exports,
      capture,
      preview: {
        facts: exportFacts,
        scenes: sceneFacts,
        breakdown: breakdownRows,
        shots: exportBrollScenes,
        runs: exportRuns,
        narration: narrationRows,
        meta: (doc) => exportMetaLine(exportFacts(doc)),
        shotSummary: (doc) => brollSummaryText(exportBrollScenes(doc)),
        commentCount: (doc) => exportComments(doc).length,
        markdown: (doc) => toMarkdownDoc(doc, { scenes: 3 }),
        markdownTable: (doc) => toMarkdownTableDoc(doc, { export: true, scenes: 7 }),
        tagColor: tagPrintColor
      },
      fileName: (format, options) => exportFileName(format, exportBaseName(), options),
      exportAction: runExportAction,
      share: () => { handleFileMenuAction("collaborate"); },
      onMenuRefresh: onFileMenuRefresh
    };
    return mountExportDialog(ports) as FileMenuExportMount;
  });
}

export const stopFileMenuExportFeature = dialog.stop;

export function fileMenuExportActions(): ActionDefinition[] {
  return definitions(dialog.owner, {
    screen: sharedPorts().screen,
    closeMenu: () => { if (fileMenuOpen()) toggleFileMenu(false); }
  });
}

