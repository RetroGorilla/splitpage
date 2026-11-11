# Merged-state projection

The existing `projectSharedDocument` now uses the same assembly as
`projectSharedDocumentWithRecovery`, which returns the plain `document` and a
detached `recovery` list. Neither entry writes shared state. There is no application
caller or cache. Recovery offsets are UTF-16 offsets within the source cell.

## Text rules

Source: [Stage 0 merged-state answers](stage-0/8-schema-hypotheses.md#projection-answers-for-merged-states-both-candidates),
original lines 115–119. The following quotations bind the tests.

| Case | Answer | Literal test family |
| --- | --- | --- |
| Stack (115) | “Accept occurrences in order of (extent start, longer first, occurrenceId)” and “Stack outer to inner by extent length, then occurrenceId” | `nested tags use extent length before occurrence id`; `same-start longer tag is outer`; `equal extents use UTF-16 occurrence ids` |
| Crossing (116) | “Projected untagged; listed in recovery with its words and tag” | `crossing tag is untagged and recoverable` |
| Split (117) | “Each part is its own extent of the same occurrence key, projected per beat” | `tag split parts constructed directly` |
| Links (118) | “The smallest linkId wins per character; across a tag stretch, the first found” | `smallest link id wins each character`; `a partial link covers the tag stretch` |
| Partial marks (119) | “comment union over the stretch, first link; shared state not rewritten” | `partial comments union over a tag stretch` |

The pure rule takes immutable occurrence identities and their marked characters,
ignores stored nesting, unites touching ranges of one tag name, rejects crossings
between different names, then passes the accepted stack to the
existing text serializer. Crossing recovery retains the occurrence, tag name,
marked words and extent. The other occurrence's accepted mark remains visible
where it overlaps the rejected occurrence. Content atoms keep the serializer's
existing atom mark policy.

Assumed, for the product owner: a crossing tag that starts later appears as ordinary
words and is listed in recovery with its tag. Equal starts prefer the longer tag;
equal extents order their tags by UTF-16 occurrence identity.

The split tests construct the two parts through monitored hydrated documents and
immutable mark authoring, because no structure executor exists on this base. The
test does not implement a split command. The delivery matrix covers two and three
writers, reordered and duplicate updates, and encoded late joiners. The seeded
test adds and removes each formatting kind alongside tag, link and comment
additions, checks literal outcomes and has an empty declared-limit table.

The coordinator's containment regression is also pinned against the standalone
`setMark` edit and `toHtml` encoder in narration and visual text: `Box(abcd)` plus
`Red` over `[1,3)` becomes `Box(a Red(bc) d)`, whatever the native-id order. Applying
`Box` over `[0,4)` to `a Box(bc) d` becomes `Box(abcd)`. The tests
check the one-writer result before concurrent delivery and then add another copy
of the hydrated occurrence, comparing reordered/duplicate delivery and encoded
late joiners. Link and comment HTML is compared with the standalone encoder too:
links have one selected URL per character; comment wrappers follow the encoder's
sorted anchor names, independently of native occurrence identities.

## Names are presence, not layers

Coordinator ruling, 2026-11-11, assumed for product review: an identified mark's
payload names something that is present on a character or absent. Occurrences are
storage. The same name is emitted once per character, and adjacent runs merge as
the app's encoder merges them. This qualifies the occurrence-based interpretation
of line 115 above; containment orders different names only. Touching/overlapping
ranges of one tag name are united before crossing analysis. Their smallest native
occurrence identity supplies the UTF-16 tie-break; the tag registry identity breaks
a remaining tie when malformed content gives different names the same native id.

Assumed, for the product owner: in a shared script the same tag cannot be applied
twice to the same words; a script that already has a doubled tag shows it once when
shared.

An independent DOM audit of narration, visual, comment and reply cells finds
**0 of 291** reference documents with one tag name nested inside itself. The audit
is a literal empty fixture/cell list in `projection-tag-containment.test.ts`.
The existing reference gate and its six approved differences remain unchanged;
no seventh difference is needed.

## Remaining groups

Join groups and their scalar-field assumptions, paragraph flags, removed/empty
scenes, the empty script, gallery folding/overflow and duplicate b-roll identities
remain subsequent parts of package 6b. Causal status uses the existing reader.
Deleted registry entries, long scene-name notices, missing owners and broader
recovery UI are not implemented by this text split. The existing named-tag
fallback is retained for imported tags with no registry record, as required by
the unchanged 291-document round-trip gate.
