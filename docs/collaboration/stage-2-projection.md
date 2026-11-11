# Full-document projection

`projectSharedDocument` in `src/adapters/collab/project.ts` returns a detached
`DocumentShape`, not a `ValidatedDocument`. Exporters retain their normalization
boundary. No application, feature or bootstrap module calls this projection yet.

The reviewed field view supplies scalar, record, gallery and status values. The
full projector adds title, headings, narration and visuals using wire-normalized
snapshots. It never transacts on or repairs the source; tests pin transactions,
updates, encoded bytes, state vector and revision before and after projection.

The adapter reads immutable records through `mark-store.ts`, never native formatting.
One core helper interprets identified payloads under the [stored convention](stage-2-identified-marks.md):
URL, tag registry id or comment anchor id. Occurrence ids never supply those names.
Comment locations follow the first live anchor in row order, narration before visual.

Assumption: multiple active payloads of one identified occurrence choose the smallest
JSON serialization under UTF-16 comparison. Both arrangements are tested for each
identified kind. Distinct occurrences serialize in UTF-16 id order. Broader merged
tag, crossing, link and join policies remain package 6b; caches belong to 6c.

Imported key order is not shared content. Known keys follow app creation/save order;
unknown string keys follow in UTF-16 order, with native integer-index enumeration.
Conflicting paths prefer explicit creation, then fixture frequency, then UTF-16 ties.
The pull request records source paths, competing orders and corpus counts.

The immutable 291-document manifest is copied byte for byte. Tests load/save through
the app, hydrate, transfer encoded state and compare both exact values ignoring only
object-key order and canonical app-save bytes. A separate literal table re-keys
expected documents at every level and must preserve values. Exactly 175 saves also
match without re-keying. A fixed-client collision probe pins the shared key-order contract.

Literal allowances cover three U+200B cases, one cue wrapper, two device-local link
locations and decided reply order in five fixture/comment pairs. Independent reply
sorting preserves every value and rejects unlisted pairs. All 96 fields have literal
probes, with two/three-writer operation histories and encoded late joiners.
