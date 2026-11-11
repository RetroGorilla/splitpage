# Identified mark convention

This Stage 2 convention supersedes the comment representation in Stage 0
[candidate B's comments and character-attributes rows](stage-0/8-schema-hypotheses.md)
(original lines 57 and 62), and the [comment mark inventory row](stage-0/2-fields.md)
(original line 150). Stage 1's `c:<commentId>` with boolean payload is historical.
Immutable anchored records and the mark store's exact native identities remain.

## Wire and stored meanings

`SharedMarkValue` is the unchanged wire vocabulary. A comment operation still carries
`{kind:"comment", id:anchorName, value:true|null}`; the core operation reader refuses
a string comment value. Flow operations name links by URL, tags by registry id and
comments by anchor id. Positive inserted-chunk marks use those same standalone names.
Formatting kinds without identities keep their existing `true|null` intent.

`SharedStoredMarkValue` is the adapter's separate stored definition. Its only reader,
`readSharedStoredMark`, is used by stored-record readers and mark-write preparation.
An addition stores formatting as `true`, or an identified mark with these fields:

| Kind | Native id | Payload |
| --- | --- | --- |
| comment | occurrence identity | comment anchor id, a stable string |
| tag | occurrence identity | tag registry id, a stable string |
| link | occurrence identity | URL |

A native id names an occurrence; it never names a comment record, registry entry or
URL. Two ranges of the same comment anchor are two occurrences carrying one payload.
The comment record retains its `anchorId`. Standalone `syncCommentAnchors` is untouched;
projection reads payloads when producing plain `cmt` names and derives locations
without writing shared state. INV-54 remains the separate b-roll-key re-key rule.

In shared content, each kind and payload is present or absent on each character:
any active addition supplies that name. Occurrences are storage, not visible layers.
A clear removes every observed addition with the named payload on the selected units.
Two concurrent additions of one name read once, and one later clear removes both.
Standalone can stack one tag name twice; sharing it shows that name once. The
[text executor contract](stage-2-text-executor.md) records this declared difference.

The stored reader accepts only this form. In particular, the old stored comment
`{id:recordId,value:true}` is invalid, with no compatibility path. Stable native ids,
comment anchor payloads and tag payloads must be well-formed UTF-16 without U+FFFD.

## Prepare translation

`prepareSharedMarkTranslation` is the one adapter function translating wire marks.
Both inserted chunks and the following range handlers use it during prepare.
Positive identified marks take their payload from the wire id and derive their
native id as `JSON.stringify(["mark-occurrence",writer,operationId,...position])`.
The writer is the live replica identity. Insertion positions are `[chunkIndex,markIndex]`;
range handlers supply their mark's position within the operation. No caller-supplied
identified id becomes a native occurrence id. The immutable record's writer-scoped
operation identity remains separate from this occurrence identity.

For removal, the caller supplies the observed active additions covering the referenced
units, from the touched text's facade or its plain ordered plan. The translator selects
additions with the requested kind whose payload equals the standalone name, returning
their full record identities in UTF-16 order without duplicates. An unmatched name
removes nothing. Formatting selects the observed additions of its kind. The store
then removes precisely those record identities; it performs no name translation.

Flow-base positions require the entry's checked `{base:readSharedRevision(handle)}`.
The handler resolves each operation's UTF-16 ranges before translating marks. Anchor
positions already follow received edits. No translator reads another text, scans a
root, looks up comment records, opens a transaction or changes the document. Planned
additions from earlier operations are ordinary fixed identities in that plain plan.
Apply uses only the deeply frozen description prepared from these decisions.

Hydration assigns identified occurrence ids from the existing per-text scope and
serial, and keeps the fixed hydration writer for immutable record identities. Comment
occurrences now consume that serial too. Two hydrations produce equal stored readings.

## Evidence and scope

`tests/adapters/collab/identified-marks.test.ts` pins the separate wire/stored validators,
rejection of old boolean records, native occurrence derivation, payload-based removal,
inserted marks and separate ranges of one hydrated comment anchor. The three one-writer
`abcd` literals clear one hydrated link, tag or comment through a small test handler
using the production translator and apply description. Direct and duplicated delivery,
a join before the clear and a fresh encoded late join all end plain on every copy.
Range handlers are registered by the following C2 change; this PR does not register
them in production. The existing mapping probes retain every range and record field.
