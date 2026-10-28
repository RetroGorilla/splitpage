# Document identity

The identity owner is in `src/application/identity/document-identity.js`. Its wiring creates it at the old 02b initializer slot, after page entry, scene status and shot hiding, before blobs, gallery and sync. Importing it creates nothing. Its methods and identity port refuse before start and after stop; stop closes the cross-tab channel. Pending history copies remain unawaited, but a late failure cannot display a notice after that owner stops.

## Responsibilities and ports

The owner holds the page nonce, adopted-at timestamp, last identity key, copy-event log, copy warning and identity channel. It stamps ids through the session, records merged identities, requests history copies without awaiting them, and applies the existing duplicate-claim policy. The typed ports in `ports.ts` provide session reads and stamping, location facts and written-out marks, history copy and document-change notifications, notices, desktop presence, ids, the clock, channel creation and error reporting. `bootstrap/wiring/ports/document-identity.ts` supplies these from the real owners and adapters; `document-identity-controls.ts` supplies the narrowed owner methods to feature wiring.

Initial loading, migration and restored-state adoption live in `src/bootstrap/startup/document-entry.js`, beside the initial-document orchestration. They keep the existing document ports, state-field table, migration, clone and transition calls. `src/adapters/page/standalone-html.js` holds standalone HTML generation beside the page shell, with row migration supplied at startup. Image inlining, id removal, serialized bytes and page-head processing are unchanged.

The document guard is a small owner beside identity in `src/application/identity/document-guard.ts`. Wiring supplies the query decision and error reporting when the session starts, before the session exposes a document. Every guard operation refuses before startup and after teardown; passthrough requires an explicitly started disabled guard. Its proxy caches and unwrapping remain inside the guard; the session bridge and P1 document reader still return that same guard view. Query parsing is in `src/adapters/page/document-guard-query.ts`; the page test probe is installed by identity wiring at the former 02b position.

## Remaining numbered callers

None. `src/legacy/document-identity-bridge.ts` went with `13-hosted.js`, its last numbered caller, when the server features were removed. The old `src/legacy/document-guard.ts` bridge is deleted. No compatibility re-exports remain.

The 02b numbered-file exception, 03 → 02b, 13 → 02b, 18 → 02b and bootstrap → 02b dependencies are removed.

## Validation

`src/test/document-identity-owner.test.mjs` exercises startup and stop refusal, stamp and reassignment order, history copies and warning deduplication, duplicate loser and winner messages, channel replacement and desktop refusal using fakes. Existing migration, identity-policy, export-byte, publish-race, home, guard and document-entry tests retain their assertions. Bootstrap manifests include every new entry and wiring module and verify that imports do not start an owner.
