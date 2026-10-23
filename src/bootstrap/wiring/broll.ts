import { productionReaders } from "../../legacy/document-ports.ts";
import { domToPos } from "../../features/editing/cell-dom.ts";
import {
  ensureTrailingCaretSpot,
  inertBody,
  sanitizeHtml
} from "../../js/04-richtext.js";
import { cellEditing, paintGuard } from "../../legacy/editor-bridge.ts";
import {
  isInsideTagOrLink,
  scheduleIdleRefresh
} from "../../js/07-production-tags.js";
import { makeId, randomIds } from "../../adapters/identity/ids.ts";
import { htmlToPlainText } from "../../legacy/plain-text.ts";
import { cellOf, scriptCellOf } from "../../legacy/richtext.ts";
import { currentDocument, heldDocument, readSession, runCommand, runDocumentEdit, sessionStamps, sessionTextPorts } from "../../legacy/session-bridge.ts";
import { productionIndex } from "../../legacy/production-index-bridge.ts";
import { anchorBrollInRows, brollHtmlLines, brollKeyHtml } from "../../adapters/production/broll-anchors.ts";
import { createBrollRecords } from "../../features/broll/records.js";

const records = createBrollRecords({
  productionReaders,
  domToPos,
  ensureTrailingCaretSpot,
  inertBody,
  sanitizeHtml,
  cellEditing,
  paintGuard,
  isInsideTagOrLink,
  scheduleIdleRefresh,
  makeId,
  randomIds,
  htmlToPlainText,
  cellOf,
  scriptCellOf,
  currentDocument,
  heldDocument,
  readSession,
  runCommand,
  runDocumentEdit,
  sessionStamps,
  sessionTextPorts,
  productionIndex,
  anchorBrollInRows,
  brollHtmlLines,
  brollKeyHtml
});

export const {
  BROLL_MARKER_RE,
  BROLL_PROPS_MAX,
  brollInCell,
  brollPropKey,
  brollPropsInCell,
  BROLL_STATUSES,
  brollStatus,
  brollSeedOf,
  recordPastedBroll,
  brollEntries,
  derivedRecordsPlan,
  addBrollProp,
  brollShotsByProp,
  maybeCaptureBroll,
  declineBrollAnchoring,
  anchorBrollInLeftCell,
  renameBrollInScript,
  updateBrollBadge,
  scheduleBrollRefresh
} = records;

export function mountBrollRecordsFeature(): void {
  records.__init();
}
