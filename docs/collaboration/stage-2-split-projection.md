# Split projection

The full projection and its recovery variant share a pure block interpreter.
It reads the production shapes in [structural execution](stage-2-structure-executor.md):
an ordinary `{b:newBeat}` boundary, a prefix `{b:newBeat,before:sourceBeat}`,
and a beat record with `segment`, `splitBy` and `visual`. Since package 9e,
`split` and `split-before` also create the new beat's empty visual in the same
step, as `segment-create` does: the record `visuals/<id>` with `beat` and `rank`,
its text and its mark store, where `<id>` is the structure identity of the split's
own id and writer with the role `visual`. A beat split before that change has no
`visual` and no record; it projects with an empty visual cell. A prefix assigns the preceding
source fragment to the new beat and resumes the source after the boundary.
Blank creation supplies a new physical segment. Native offsets count UTF-16
code units and one unit per inline atom or boundary; recovery ranges exclude
their opening boundary. Reading leaves bytes, vectors and revisions unchanged.

## Cases and literal tests

The three robustness answers below are coordinator rulings. They describe content
another copy could send; the entry does not author these malformed shapes.

| Case | Answer and source | Literal test |
| --- | --- | --- |
| Ordinary and prefix split | Structural execution, ordinary and prefix boundary paragraphs; Stage 0 answers line 117: each tag part projects per beat | `executed ordinary split has literal rows`; `executed prefix split has literal rows` |
| Concurrent splits | Stage 1 product decisions: both new beats show; retain the shared text order | `executed concurrent splits`, ten literal shapes, three schedules |
| Rich cells | Stage 0 answers lines 117, 121: split extents per beat, ignore boundary marks | `traced beat split matches literal marked cells and the independent applier`; `traced split cuts all inline atom kinds at native boundaries` |
| Blank segment | Structural execution, blank creation paragraphs | `blank segment creation through the entry` |
| Duplicate boundary | Coordinator ruling 1: first occurrence, including the head, owns the row; later fragments recover; adjacent repeats with no intervening units coalesce | `duplicate source boundary`; `adjacent identical boundaries coalesce`; `nonadjacent identical boundaries recover the later fragment` |
| Missing, wrong-shape or foreign beat | Coordinator ruling 2: recover the whole fragment without inventing a row or metadata | `missing beat`; `wrong-shape beat`; `foreign beat stays with its owner` |
| Segment ownership | Coordinator ruling 3: a valid stored segment containing the beat owns it; otherwise use the first ordered segment whose head names it | `second segment head cannot steal an imported beat`; `valid stored segment beats the head fallback`; `nonexistent stored segment uses the first head`; `stored segment without its beat uses the first head` |
| Existing merged rules after a split | Structure projection answers and root-field rulings | `merged join, status, tags, links and comments work across executed split shapes` |

The entry refusal test rejects occupied/repeated aliases, identity/segment field
overrides and foreign source owners without changing state. An accepted split
always creates the new native beat record and its segment ownership. Malformed
records and boundaries in the robustness tests are written directly through
monitored constructors, without an exemption or a new executor. Existing corrupt
state is not repaired by projection.

## Generators and limits

| History | Seeded coverage | Declared limits |
| --- | --- | --- |
| Valid entry lists | 24 seeds, ordinary/prefix/blank creation, two and three writers, marking, typing, deletion, scalar and status changes, normal/reversed/duplicated delivery, encoded late joiner; 1,872 checkpoints, 9,000 commands | None for projection |
| Malformed boundaries | 24 seeds, nineteen literal shapes, three writers with concurrent peer text and scalar changes, three delivery schedules, encoded late joiner; 1,368 checkpoints, 4,104 authoring actions | None for projection |

Expected rows and recovery are literal data. Traced app splits also compare with
the independent flow applier. Every copy compares canonical saved bytes, key
presence/order and array holes, including after encoded reload. A recovered rich
fragment retains its formatting, tag, link, comment, atom and source position.
The legacy split fixture now explicitly records its native beat's segment, as
the production executor does; its expected document is unchanged. An inline
beat without ownership has its own literal recovery case.

The valid generator also mixes prefix and ordinary splits, source typing at and
beside a split, deletion across the split position, and blank creation with a
split. Each has literal rows, two and three writers, both authoring orders and
all three delivery schedules. With three writers the third changes the source
beat's duration. Ownership tests explicitly give the order array and segment map
different orders. A recovered surrogate-pair example pins native UTF-16 offsets.

Additional damaged-state literals cover `missing-boundary`, `invalid-prefix`,
`a{b:N,before:R1}{b:R1}b` (the final `b` recovers), and an unreadable embed between
same-beat boundaries (it prevents coalescing). The two new defect entries remove
the anonymous leading fragment or treat an invalid prefix as a row.

## Declared edit-after-damage limit

| Stored sequence | Projection | Entry limitation | Follow-up |
| --- | --- | --- | --- |
| Head R1, text `{b:R1}ab` | R1 = `ab`, empty recovery; literal test `edit-after-damage handoff: adjacent head boundary projects ab` | The current executor sees an empty R1 span: typing at 0 moves `ab` to recovery, typing at 1 or 2 is refused | Structure lane will share one span interpretation with the core interpreter |

The handoff test pins projection only. It does not claim that editing this damaged
state is supported; that entry limitation is separate from replica agreement.

## Assumed, for the product owner

- Concurrent prefix typing stays at the original character gap and can appear in the first isolated prefix, while every new beat remains visible.
- When a beat boundary appears twice, its first fragment stays in the script and later fragments go to recovery; adjacent repeated boundaries count once.
- Text with missing, malformed or foreign beat metadata stays in recovery until it can be shown as a row.
- A beat belongs to its valid stored segment, or otherwise to the first segment that starts with it.

Ownership fallback is stored segment order, never map iteration.
There is no new identity tie-break. Existing join/tag/link/status rules run after
the split is interpreted. No incremental projection, cache, semantic undo,
gallery folding/overflow or duplicate b-roll policy is added here.
