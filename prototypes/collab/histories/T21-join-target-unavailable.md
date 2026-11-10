# T21: a valid join followed by removal or move throws

Seed R1 `ab`, R2 `cd`, R3 `ef` with original character identities. The expected values below are literal data written before executing these histories, from artifact 8's join/recovery rule (section 2, joined-beat row) and the coordinator's move reading.

| Commands | Required projection | Current result |
| --- | --- | --- |
| Join R2 into R1; remove R1 as Alice | Visible R3 `ef`; recovery R1 `ab cd`, removed by Alice; original ab/cd identities plus one projected glue | `readStructure` throws `Structural join target unavailable` |
| Join R2 into R1; move R1 immediately after R2 (B layout) | Visible R1 `ab cd`, R3 `ef`; no recovery; joined source follows its target | Same exception |

`SchemaReplica.join`, `SchemaReplica.remove` and `moveBeat` produce the histories without fabricating shared records. Every D1/D2/D3/duplicate/reverse/late-C delivery plus an encoded-state late join reproduces the exceptions; both layouts run the removal case. Layout A refuses the move command and makes no claim to implement it. The earlier `readReplica` also throws (`Probe requires an earlier live join target`), independently recorded by the same gate.

`test/reader-order/histories.ts` retains required projection summaries and the observed exception strings. The literal checker rejects these exceptions even when every replica throws equally; the general no-throw checker also reports them. They remain known failures in the first check-only revision, rather than delaying delivery of the general check.

The repaired readers produce the literal results above, with original identities and glue, in every listed delivery and late join. The original reader still throws as the control. A further real-command literal removes R1 after observing all joined characters: both layouts retain one recovery row R1 `ab cd` with no edited identities. Join grouping now follows a removed target chain even when removal observations also reach its members. Missing targets and cycle links are absent rather than throwing.
