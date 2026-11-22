# Stage 3 removal evidence

The baseline is `8db5591a8`. This inventory covers the stage 3 source cut and the guards that outlived it. The native behavior decisions remain in [the design](native-adapter-design.md#slice-8-editor-decisions).

## Surviving checks

- Native comment Resolve and reopen each create one author-local Undo step. The native editor and refusal-parity app tests exercise real Undo in both directions.
- The mapped caret app tests cover Writer boundary Backspace, Alt+Backspace refusal, cross-view Undo focus, and protection of imported B-roll labels with editable neighbouring text.
- Standalone save, export and attribution from projection capture live in `tests/adapters/formats/project-file.test.ts`. Standalone Find uses `tests/features/find/standalone-replace.test.ts`. Shared entry and switch use native and replica-neutral fixtures.
- Transaction origins, the 4/104 status read cost, the 291 incremental fixture checks and adapter timing exception/refusal/reentrancy tests retired with the old document, status index, incremental projector and intake. Native guarded delivery and release timing have their own tests.
- The standalone trace driver and generic parser retain historical timing coverage. The application release bundle excludes all timing marks and the test bundle keeps document entry, render and command marks.
- The PR and nightly matrices each discover 887 root tests. The shard proof includes unweighted roots, Chromium routing and the commit-time writers inventory. The PR change detector fails open when the diff is unknown.

## Deleted test dependencies

The table records the nearest retired implementation by a runtime import path in the baseline. It also records the three static or child-process adapter inventories. Mixed assertions are covered by their surviving targets above.

| Deleted test | Retired implementation |
| --- | --- |
| `tests/adapters/collab/anchors.test.ts` | `src/adapters/collab/anchors.ts` |
| `tests/adapters/collab/buffer-gate.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/cleanup-origin.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/comment-anchor-columns.test.ts` | `src/adapters/collab/incremental-project.ts` |
| `tests/adapters/collab/comment-recovery.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/comment-stamps.test.ts` | `src/adapters/collab/project.ts` |
| `tests/adapters/collab/creation-retirement-cost-matrix.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/creation-retirement-phases.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/creation-undo-cost.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/discard.test.ts` | `src/adapters/collab/split-executor.ts` |
| `tests/adapters/collab/document.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/draft-placement.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/execution-guard.test.ts` | `src/adapters/collab/execute.ts` |
| `tests/adapters/collab/field-mapping.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/formatting-invariant.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/gallery-reads.test.ts` | `src/adapters/collab/project.ts` (Hardcoded legacy gallery-reader inventory) |
| `tests/adapters/collab/guarded-subscriptions.test.ts` | `src/adapters/collab/document.ts` (Hardcoded legacy subscription inventory) |
| `tests/adapters/collab/heading-create-flow-agreement.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/heading-create.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/heading-finalize-flow-agreement.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/heading-finalize.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/heading-last-line.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/heading-removal.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/hydrated-marks.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/identified-marks.test.ts` | `src/adapters/collab/mark-translation.ts` |
| `tests/adapters/collab/identity-struct-contract.test.ts` | `src/adapters/collab/identity-structs.ts` |
| `tests/adapters/collab/incremental-broll.test.ts` | `src/adapters/collab/record-executor.ts` |
| `tests/adapters/collab/incremental-changes-generator.test.ts` | `src/adapters/collab/incremental-project.ts` |
| `tests/adapters/collab/incremental-changes.test.ts` | `src/adapters/collab/incremental-project.ts` |
| `tests/adapters/collab/incremental-cost.test.ts` | `src/adapters/collab/read-counts.ts` |
| `tests/adapters/collab/incremental-cross-records.test.ts` | `src/adapters/collab/incremental-project.ts` |
| `tests/adapters/collab/incremental-fixtures.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/incremental-generator.test.ts` | `src/adapters/collab/incremental-project.ts` |
| `tests/adapters/collab/incremental-project.test.ts` | `src/adapters/collab/incremental-project.ts` |
| `tests/adapters/collab/ingress-gate-generator.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/ingress-gate.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/join-binding-model.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-binding-neighborhood.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-buffer-routing.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-commands.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-endpoint-cases.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-flow-agreement.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-identical-glue.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-layout-histories.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-marks.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-neighborhood.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/join-recovery.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-routing-contract.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-routing-limit.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-split-handoff.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/join-stage1.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/joined-flow-agreement.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/joined-replacement-undo.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/joined-text-routing.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/long-row-commands.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/long-row.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/mark-flow-agreement.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/mark-occurrences.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/mark-operations.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/marks/executor-literals.test.ts` | `src/adapters/collab/anchors.ts` |
| `tests/adapters/collab/marks/generator.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/marks/literals.test.ts` | `src/adapters/collab/anchors.ts` |
| `tests/adapters/collab/marks/store.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/marks/writer-identity.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/measure/measurement.test.mjs` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/move-refusal.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/native-text-purpose.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/operation-families.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/paint-base-split.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/paint-base.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/painted-selection.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/people-recovery.test.ts` | `src/adapters/collab/record-executor.ts` |
| `tests/adapters/collab/preparation-has.test.ts` | `src/adapters/collab/prepare.ts` |
| `tests/adapters/collab/preparation.test.ts` | `src/adapters/collab/execute.ts` |
| `tests/adapters/collab/projection-agreement.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/projection-broll-duplicates.test.ts` | `src/adapters/collab/executor-references.ts` |
| `tests/adapters/collab/projection-capture.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/projection-executed-splits.test.ts` | `src/adapters/collab/execute.ts` |
| `tests/adapters/collab/projection-fields.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/projection-gallery-overflow.test.ts` | `src/adapters/collab/record-executor.ts` |
| `tests/adapters/collab/projection-gallery.test.ts` | `src/adapters/collab/record-executor.ts` |
| `tests/adapters/collab/projection-join-glue.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/projection-merged-structure.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/projection-merged-text.test.ts` | `src/adapters/collab/mark-store.ts` |
| `tests/adapters/collab/projection-omitted-field.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/projection-roundtrip.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/projection-safety.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/projection-split-applier.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/projection-split-recovery.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/projection-tag-boundaries.test.ts` | `src/adapters/collab/mark-store.ts` |
| `tests/adapters/collab/projection-tag-containment.test.ts` | `src/adapters/collab/mark-store.ts` |
| `tests/adapters/collab/projection-text-agreement.test.ts` | `src/adapters/collab/project.ts` |
| `tests/adapters/collab/projection-text-fields.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/projection-text-safety.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/read-cache-cost.test.ts` | `src/adapters/collab/prepare.ts` |
| `tests/adapters/collab/read-cache-generator.test.ts` | `src/adapters/collab/mark-state.ts` |
| `tests/adapters/collab/read-cache.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/record-cost.test.ts` | `src/adapters/collab/record-executor.ts` (Legacy record executor loaded by a child process) |
| `tests/adapters/collab/record-executor.test.ts` | `src/adapters/collab/execute.ts` |
| `tests/adapters/collab/record-generator.test.ts` | `src/adapters/collab/execute.ts` |
| `tests/adapters/collab/record-hydration-parity.test.ts` | `src/adapters/collab/record-reader.ts` |
| `tests/adapters/collab/record-identity.test.ts` | `src/adapters/collab/execute.ts` |
| `tests/adapters/collab/record-malformed.test.ts` | `src/adapters/collab/record-reader.ts` |
| `tests/adapters/collab/record-removal-edit.test.ts` | `src/adapters/collab/record-executor.ts` |
| `tests/adapters/collab/record-removal-ways.test.ts` | `src/adapters/collab/record-executor.ts` |
| `tests/adapters/collab/record-review.test.ts` | `src/adapters/collab/execute.ts` |
| `tests/adapters/collab/recovery-removal.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/removal-contract.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/removal-flow-agreement.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/removal-model.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/removal-pending-records.test.ts` | `src/adapters/collab/record-executor.ts` |
| `tests/adapters/collab/removal-stage1.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/removal-state.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/roots.test.ts` | `src/adapters/collab/roots.ts` |
| `tests/adapters/collab/scalar-executor.test.ts` | `src/adapters/collab/execute.ts` |
| `tests/adapters/collab/scalar-generator.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/split-removal.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/split-retirement-cost.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/split-visual.test.ts` | `src/adapters/collab/text-executor.ts` |
| `tests/adapters/collab/stage1-buffer-executor.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/stage1-mark-executor.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/status-identity.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/status-read-cost.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/stored-link-policy.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/structure-create.test.ts` | `src/adapters/collab/structure-reservations.ts` |
| `tests/adapters/collab/structure-flow-agreement.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/structure-identities.test.ts` | `src/adapters/collab/split-executor.ts` |
| `tests/adapters/collab/structure-index.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/structure-join-model.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/structure-join.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/structure-owner.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/structure-removal.test.ts` | `src/adapters/collab/split-executor.ts` |
| `tests/adapters/collab/structure-split.test.ts` | `src/adapters/collab/structure-reservations.ts` |
| `tests/adapters/collab/structure-stage1.test.ts` | `src/adapters/collab/split-executor.ts` |
| `tests/adapters/collab/text-apply-phase.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/text-flow-agreement.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/text-generator.test.ts` | `src/adapters/collab/text-executor.ts` |
| `tests/adapters/collab/text-operations.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/text-preparation.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/adapters/collab/timing-marks.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/transaction-origin.test.ts` | `src/adapters/collab/state.ts` |
| `tests/adapters/collab/trial-replica.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/undo-creation.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/undo-gallery.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/undo-heading-consumed.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/undo-heading-creation.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/undo-heading.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/undo-held-updates.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/undo-join.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/undo-mark-growth.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/undo-notice.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/adapters/collab/undo-operations.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/undo-picture-fields.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/undo-provenance-cache.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/undo-provenance-marker.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/undo-records.test.ts` | `src/adapters/collab/status.ts` |
| `tests/adapters/collab/undo-removal.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/undo-runs.test.ts` | `src/adapters/collab/document.ts` |
| `tests/adapters/collab/undo-split.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/undo-unjoin.test.ts` | `src/adapters/collab/join-executor.ts` |
| `tests/adapters/collab/visual-set.test.ts` | `src/adapters/collab/removal-executor.ts` |
| `tests/adapters/collab/writer-painted-base.test.ts` | `src/adapters/collab/document.ts` |
| `tests/application/commands/comments-shared.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/application/commands/empty-script.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/application/commands/flow-paste-shared.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/application/commands/flow-shared.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/application/commands/gallery-shared.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/application/commands/records-shared.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/application/commands/structure-shared.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/application/commands/values-shared.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/application/editing/buffered-field.test.ts` | `src/application/editing/buffered-field.ts` |
| `tests/application/editing/painted-selection.test.ts` | `src/application/editing/painted-selection.ts` |
| `tests/application/session/shared-session-generator.test.ts` | `src/adapters/collab/anchors.ts` |
| `tests/application/session/shared-session-recovery.test.ts` | `src/adapters/collab/replica.ts` |
| `tests/application/session/shared-session-replica.test.ts` | `src/adapters/collab/replica.ts` |
| `tests/application/session/shared-session-replicas.test.ts` | `src/adapters/collab/document.ts` |
| `tests/bootstrap/shared-author.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/collab/broll-keying.test.ts` | `src/adapters/collab/document.ts` |
| `tests/collab/broll-text-records.test.ts` | `src/adapters/collab/record-reader.ts` |
| `tests/collab/buffer-commit.test.ts` | `src/adapters/collab/buffer.ts` |
| `tests/collab/buffer-generator.test.ts` | `src/adapters/collab/buffer.ts` |
| `tests/collab/buffer-overflow.test.ts` | `src/adapters/collab/document.ts` |
| `tests/collab/buffer-recovery.test.ts` | `src/adapters/collab/buffer.ts` |
| `tests/collab/buffer-stamps.test.ts` | `src/adapters/collab/buffer.ts` |
| `tests/collab/buffer-text-records.test.ts` | `src/adapters/collab/buffer.ts` |
| `tests/collab/measure/options.test.mjs` | `src/adapters/collab/state.ts` |
| `tests/collab/people-text-records.test.ts` | `src/adapters/collab/record-reader.ts` |
| `tests/collab/undo-seam.test.ts` | `src/adapters/collab/buffer.ts` |
| `tests/collab/undo/decided-rows.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/collab/undo/generator-shared-three.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/collab/undo/generator-shared-two.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/collab/undo/generator.test.ts` | `src/adapters/collab/undo-executor.ts` |
| `tests/collab/undo/limits.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/collab/undo/mirrored-rules.test.ts` | `src/adapters/collab/scalar-executor.ts` |
| `tests/collab/undo/restore-order.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/collab/undo/stage1-buffer.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/collab/undo/stage1-records.test.ts` | `src/adapters/collab/hydrate.ts` |
| `tests/features/editing/cell-buffer-recovery.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/editing/cell-buffer-visual.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/editing/cell-buffer.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/editing/split-caret-review.test.ts` | `src/adapters/collab/project.ts` |
| `tests/features/editing/split-caret.test.ts` | `src/adapters/collab/project.ts` |
| `tests/features/empty-script/guards.test.ts` | `src/features/empty-script/empty-script.ts` |
| `tests/features/empty-script/shared.test.ts` | `src/adapters/collab/document.ts` |
| `tests/features/find/shared-replace-generator.test.ts` | `src/adapters/collab/document.ts` |
| `tests/features/find/shared-replace-long-row.test.ts` | `src/adapters/collab/stamp.ts` |
| `tests/features/find/shared-replace-rejoined.test.ts` | `src/adapters/collab/project.ts` |
| `tests/features/find/shared-replace-storage.test.ts` | `src/adapters/collab/document.ts` |
| `tests/features/find/shared-replace-structure.test.ts` | `src/adapters/collab/project.ts` |
| `tests/features/find/shared-replace.test.ts` | `src/adapters/collab/document.ts` |
| `tests/features/rows/scene-create.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/rows/scene-name-buffer.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/shared-undo-surfaces.test.ts` | `src/adapters/collab/buffer.ts` |
| `tests/features/title/name-box-clipboard-generator.test.ts` | `src/adapters/collab/document.ts` |
| `tests/features/title/title-buffer.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/writer/buffer-binding.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/writer/buffer-heading.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/writer/buffer-invariants.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/writer/buffer-recovery.test.ts` | `src/adapters/collab/state.ts` |
| `tests/features/writer/buffer-undo.test.ts` | `src/adapters/collab/buffer-selection.ts` |
| `tests/features/writer/flow-command-ports.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tests/features/writer/visual-buffer.test.ts` | `src/adapters/collab/operation-families.ts` |
| `tools/test-ci-old-adapter-shards.mjs` | `tools/old-adapter-tests.mjs` |

## Original mutation IDs

IDs are one-based positions within each baseline manifest. The nightly collaboration job runs 449 entries. Sixteen entries in the two other manifests are outside its glob. The baseline held 1,145 fast collaboration entries, five slow entries and those sixteen outside entries. Seven hundred fast IDs and all five slow IDs retire, and four entries were added.

| Manifest | Retained original IDs | Retired original IDs | New entries |
| --- | --- | --- | --- |
| `tests/collab/broll-keying-mutants.json` | 3?5, 8?13, 15, 25 | 1?2, 6?7, 14, 16?24, 26?28 | 0 |
| `tests/collab/buffer-binding-mutants.json` | 12, 25, 29, 67, 99, 108 | 1?11, 13?24, 26?28, 30?66, 68?98, 100?107, 109?153 | 0 |
| `tests/collab/buffer-commit-mutants.json` | 1?2 | ? | 0 |
| `tests/collab/buffer-mutants.json` | ? | 1?4 | 0 |
| `tests/collab/comment-command-mutants.json` | 10?15 | 1?9, 16 | 0 |
| `tests/collab/commit-writer-mutants.json` | 2?3, 9?12 | 1, 4?8 | 0 |
| `tests/collab/composition-mutants.json` | 1, 37, 40?52, 54?75, 77?78, 81 | 2?36, 38?39, 53, 76, 79?80, 82 | 0 |
| `tests/collab/creation-undo-mutants.json` | ? | 1?42 | 0 |
| `tests/collab/disable-list-mutants.json` | 1?18 | ? | 0 |
| `tests/collab/draft-detach-mutants.json` | 1?28 | ? | 0 |
| `tests/collab/empty-script-mutants.json` | ? | 1?45 | 0 |
| `tests/collab/find-replace-mutants.json` | 5, 7, 12?18 | 1?4, 6, 8?11, 19?27 | 0 |
| `tests/collab/gallery-command-mutants.json` | ? | 1?25 | 0 |
| `tests/collab/heading-creation-undo-mutants.json` | ? | 1?14 | 0 |
| `tests/collab/ingress-gate-mutants.json` | ? | 1?9 | 0 |
| `tests/collab/join-glue-mutants.json` | 1?2 | 3 | 0 |
| `tests/collab/join-mutants.json` | ? | 1?10 | 0 |
| `tests/collab/join-neighborhood-mutants.json` | ? | 1?4 | 0 |
| `tests/collab/join-routing-mutants.json` | 1, 4?5, 11 | 2?3, 6?10, 12 | 0 |
| `tests/collab/measure-hook-mutants.json` | 2, 7?19 | 1, 3?6 | 0 |
| `tests/collab/projection-mutants.json` | 1?20, 22?30, 40?42, 44 | 21, 31?39, 43, 45?48 | 0 |
| `tests/collab/record-command-mutants.json` | 1?18, 21 | 19?20 | 0 |
| `tests/collab/record-removal-mutants.json` | ? | 1?33 | 0 |
| `tests/collab/recovery-panel-mutants.json` | 1 | ? | 0 |
| `tests/collab/removal-mutants.json` | 2, 12, 14, 20, 22?23, 25, 27?28, 30 | 1, 3?11, 13, 15?19, 21, 24, 26, 29 | 0 |
| `tests/collab/scene-create-mutants.json` | ? | 1?12 | 0 |
| `tests/collab/scene-name-mutants.json` | ? | ? | 4 |
| `tests/collab/shared-entry-mutants.json` | 1?76 | ? | 0 |
| `tests/collab/shared-session-mutants.json` | 1?6, 12?20, 22?27 | 7?11, 21 | 0 |
| `tests/collab/split-callers-mutants.json` | 5?9, 11?12 | 1?4, 10 | 0 |
| `tests/collab/split-composed-mutants.json` | 3?9 | 1?2 | 0 |
| `tests/collab/split-records-mutants.json` | 1?21, 23?41, 43?80 | 22, 42 | 0 |
| `tests/collab/split-review-mutants.json` | ? | 1 | 0 |
| `tests/collab/structure-command-mutants.json` | ? | 1?14 | 0 |
| `tests/collab/structure-mutants.json` | 9?10 | 1?8, 11?27 | 0 |
| `tests/collab/trial-replica-mutants.json` | ? | 1?22 | 0 |
| `tests/collab/undo-mutants.json` | 1?29, 103, 139?140 | 30?102, 104?138, 141?142 | 0 |
| `tests/collab/undo-slow-mutants.json` | ? | 1?5 | 0 |
| `tests/collab/value-command-mutants.json` | ? | 1?9 | 0 |
| `tests/collab/visible-refusal-mutants.json` | 1?11 | ? | 0 |
| `tests/collab/writer-visual-mutants.json` | 11, 17 | 1?10, 12?16 | 0 |
| `tests/features/find/shared-refusal-mutants.json` | 1?2 | ? | 0 |
| `tools/paragraph-mutants.json` | 1?14 | ? | 0 |
