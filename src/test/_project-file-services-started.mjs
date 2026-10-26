import { installProjectFileServices, projectFileServicesStarted } from "../application/formats/project-file-services.ts";
import { wireProjectFiles } from "../bootstrap/wiring/project-files.ts";
import { adoptRestoredState, docIdEvents, initDocIdentityChannel, migrateDocument, reassignDocId, standaloneHtmlFor } from "../js/02b-doc-id.js";
import { setBaseState } from "../js/03-sync.js";
import { tagFieldOccurrences } from "../js/07-production-tags.js";

if (!projectFileServicesStarted()) installProjectFileServices(wireProjectFiles({
  prepareDocument: migrateDocument,
  restoreDocument: adoptRestoredState,
  changeDocumentId: reassignDocId,
  identityEvents: docIdEvents,
  connectIdentity: initDocIdentityChannel,
  standaloneHtml: standaloneHtmlFor,
  replaceSyncBase: setBaseState,
  tagOccurrences: tagFieldOccurrences
}).services);
