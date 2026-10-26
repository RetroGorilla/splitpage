# Project-file services relocation

The remaining project-file glue from `src/js/20d-formats.js` lives in the application owner `src/application/save/project-files.ts`. The codecs remain in `src/adapters/formats/project-file.ts`. The factory owns the pending Markdown row choice, builds the existing six project-file services, and exposes the same format controls. It changes no file bytes, arguments, call ordering, or open/save policies.

`src/bootstrap/wiring/project-files.ts` supplies named document, text, location, entry, recovery, export, saving and opening ports. The already moved owners are reached through `src/bootstrap/wiring/ports/`. The codecs arrive from their adapter through the wiring. The page port provides the existing modal elements without requiring browser globals in the owner.

The Rule 5 fields are `prepareDocument`, `restoreDocument`, `changeDocumentId`, `identityEvents`, `connectIdentity`, `standaloneHtml` (currently `02b-doc-id.js`), `replaceSyncBase` (currently `03-sync.js`), and `tagOccurrences` (currently `07-production-tags.js`). The entry supplies them using its existing imports, and bootstrap fills the owner's typed ports. No new bootstrap import from `src/js` is introduced.

The project-file services are still installed at the existing project-file-services startup step. `mountProjectFiles` replaces the old `20d` initializer in the same position, after Help and before Connect. Only this mount is newly re-exported by `src/bootstrap/wiring.ts`. The imports view calls the wired owner's `finishMarkdownRowChoice`. There is no compatibility re-export.

## Project-file calls

Every old location below is in `src/js/20d-formats.js`. The function providers keep their existing implementations; this table records where each call or exposed function now lives.

| Call or function | Old location | New location and connection |
| --- | --- | --- |
| `legacyProjectFileServices` | Service factory | `createProjectFiles(...).services` in `application/save/project-files.ts`; installed by the same wiring step |
| `askMarkdownRowChoice` | Pending resolver and modal | Factory-local `askMarkdownRowChoice` in the owner; page port; unchanged missing-modal `keep` result and detail text |
| `finishMarkdownRowChoice` | Export used by views | Owner method; views reach it through `bootstrap/wiring/project-files.ts`; hide, clear resolver, then normalize/resolve in the same order |
| `deriveDocId` | `__init` exposed helper | Owner's `formats.deriveDocId`; same direct core helper |
| `migrateRows` | Service and `formats.migrate` | `ports.entry` from named `projectFileDocument`; same function from `legacy/document-ports.ts` after prompt 4 |
| `migrateDocument` | Service | `ports.deferred.prepareDocument`; same raw/origin arguments |
| `adoptRestoredState` | Exposed helper | `formats.adoptRestoredState` from `ports.deferred.restoreDocument`; same snapshot |
| `reassignDocId` | Exposed helper | `formats.reassignDocId` from `ports.deferred.changeDocumentId`; same target/options |
| `docIdEvents` | Exposed helper | `formats.docIdEvents` from `ports.deferred.identityEvents` |
| `initDocIdentityChannel` | Exposed helper | `formats.initDocIdentityChannel` from `ports.deferred.connectIdentity`; same optional factory |
| `standaloneHtmlFor` | `buildStandaloneHtml` | Owner's `buildStandaloneHtml`: capture first, then `ports.deferred.standaloneHtml` with that capture |
| `setBaseState` | `forgetDiskBase` | `ports.deferred.replaceSyncBase(null, "__splitpageFormats.forgetDiskBase: test hook, drives the two-way fallback")`; after any home amendment, including when no file home exists |
| `amendHome` | `forgetDiskBase` | `ports.location.amendHome` from named `projectFileLocation`; same home and `{ diskBase: null }`, before clearing the sync base |
| `fileHome` | `docFile`, `hasDiskBase`, `forgetDiskBase` | `ports.location.fileHome`; one read for `docFile`, short-circuit one/two reads for the other controls, preserving order |
| `documentLocation().writtenOut` | `writtenOut` | `ports.location.writtenOut` through named location port |
| `stashLocalWork` | Exposed `stash` | `ports.recovery.stash` from named `projectFileRecovery`; same function and result |
| `tagFieldOccurrences` | Service | `ports.deferred.tagOccurrences`; same HTML, phrase, category, name and count-only arguments |
| `sanitizeHtml`, `inertBody` | Services | Named text port; same functions and arguments |
| `captureExportDocument` | No-state splitpage/Markdown build and standalone HTML | `ports.exports.captureExportDocument` from named `projectFileExports`; called before the codec or standalone builder |
| `exportDocumentOf` | Supplied-state splitpage/Markdown build | `ports.exports.exportDocumentOf`; same truthy-state branch, one original state argument, before the codec |
| `buildSplitpageFile` | `buildSplitpage` | `ports.codecs.buildSplitpage` from the unchanged adapter; receives the same export document |
| `buildMarkdownProject` | `buildMarkdown` | `ports.codecs.buildMarkdown` from the unchanged adapter; receives the same export document |
| `parseMarkdownProject` | `parseMarkdown` | `ports.codecs.parseMarkdown` from the unchanged adapter; same text |
| `autoSavePolicy` | `autosave.timing/enabled/halt/pending` | `ports.saving.autoSave` from named `projectFileSaving`; each control reads the policy at call time before the same property/method |
| `autoSaveTarget` | `autosave.target` | `ports.saving.target`; same result |
| `toggleAutoSave`, `flushAutoSave` | Exposed autosave helpers | `ports.saving.toggle/flush`; same functions |
| `saveDoc` | `save` | `ports.saving.save(opts || {})`; original options object and returned promise retained |
| `openDocument` | `openFile` | `ports.opening.open({ kind: "file", file, handle: handle || null, options: { skipSnapshot: true } })` |
| `openDocument` | `importFile` | `ports.opening.open({ kind: "import", file })` |
| `currentDocument` | `docId` | Named document reader's `current`; same short-circuit one/two reads |
| `heldDocument` | `state` | Named `projectFileDocument.heldDocument`; retains the held document, including its identity |
| `cloneState` | Exposed `clone` | Same direct core helper |

The `20d` legacy-file exception and its eight numbered-function edges to `02b`, `03` and `07` are pruned. Bootstrap's import of `20d` disappears. The former `20d -> 14b` dependency was already replaced by prompt 3's export owner/bridge; the application owner now consumes its named export port. There are no added exceptions, shared-port builders, feature-to-feature imports, legacy-to-feature imports, or code comments.

## Validation scope

The owner unit tests use fakes to check service arguments, serialization capture order, open/import requests and promise identity, save options, home-amendment/sync-base order, identity/recovery/autosave controls, and independent Markdown modal choices. Existing format and app tests retain their assertions. Test setup follows the moved factory, and the formats load manifest replaces the deleted numbered module with the three new modules while pinning the new total at 15.

The PR requires the PC Electron smoke: open and save a `.splitpage` file and a Markdown project. The task evidence records the completed open/save/reopen scenarios and the unchanged browser suites and full validation commands.
