import "./_identity-started.mjs";
import "./_session-merge-started.mjs";
import { documentIdentityOwner } from "../bootstrap/wiring/document-identity.ts";
import "./_production-tags-started.mjs";
import { installProjectFileServices, projectFileServicesStarted } from "../application/formats/project-file-services.ts";
import { wireProjectFiles } from "../bootstrap/wiring/project-files.ts";
import { adoptRestoredState, migrateDocument } from "../bootstrap/startup/document-entry.js";
import { standaloneHtmlFor } from "../adapters/page/standalone-html.js";
const docIdEvents = (...args) => documentIdentityOwner().docIdEvents(...args);
const initDocIdentityChannel = (...args) => documentIdentityOwner().initDocIdentityChannel(...args);
const reassignDocId = (...args) => documentIdentityOwner().reassignDocId(...args);
import { setBaseState } from "../bootstrap/wiring/session-merge.ts";
import { tagFieldOccurrences } from "../features/tags/production-tags.js";


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
