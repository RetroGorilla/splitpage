# Shared whole-beat flow paste

Rule 88 on #1414 permits whole-beat paste. The shared Writer composition selects
`pasteSharedFlowClipboard` and gives `writerFlowCommands` its current handle in
addition to its author and writer ports. Session entry and selecting those ports
in the running Writer remain integration work.

The shared clipboard reader checks embedded images and moves before the existing
standalone reader prepares the paste. `sharedFlowPaste` converts its carried
collections into the existing record-create family, resolves created identities
before returning the selection, and retains the structure operations. Narration
and visual text are initial content of segment-create; gallery slots are explicit
gallery records. Headings use a complete initial line followed by heading-finalize:
heading-create alone refuses an empty name, so it cannot stand alone in the
required separate-operation comparison. No operation kind or handler is added.

Tag sameness remains `registryKey(category, name)`; person sameness remains
`normalizeTagName(name)`, both from standalone `insertBeats`. Normalization trims,
folds case and collapses whitespace. Tag ids retain standalone's deterministic
`mintTagId` rule, so concurrent creation of the same tag has one registry key.
New people, shots, comments, replies and gallery records receive paste-author ids.
Beat and heading ids come from the existing structure identity port. Existing
text references become observed unit identities before the command executes.

Each admitted paste is one shared command and one undo entry. Creation undo still
refuses `undo-unsupported:segment-create`; this cut does not change undo support.
Gallery record undo also remains unsupported by the existing adapter.

The whole paste is refused, without a document write, for these cases:

| Case | Reason |
| --- | --- |
| Old embedded image (rule 97) | `paste-gallery-legacy-image` |
| Gallery location tied to a local file | `paste-gallery-local-file` |
| Comment authored by someone else | `paste-comments-foreign-author` |
| Reply authored by someone else | `paste-replies-foreign-author` |
| Existing carried collection would be replaced or removed | `paste-<collection>-replacement-unavailable` |
| Existing text cannot be observed through the handle port | `paste-references-unavailable` |
| Carried fields rejected by the existing record-family validator | `paste-<collection>-fields-unavailable` |
| Clipboard move (rule 92) | `move-in-shared-session` |

The comment and reply limits come from the existing record-create handler's
author restriction. The shared clipboard reader does not impersonate an author.
Non-whole flow pastes with unsupported registry changes retain
`flow-clipboard-records-unavailable`. Visual selection retains
`invalid-record-field`; importing rows and bulk tagging remain refused.

`flowCommand` also refuses a changed standalone plan with an empty operations list
as `flow-operations-empty`, before producing stamps. The standalone clipboard
reader and standalone command implementation are unchanged; neither a standalone
paste nor a standalone keystroke executes an additional read or allocation.
