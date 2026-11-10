# T21 status: malformed parent cycles

Shows the former recursive resolver overflowing its call stack on shared event data. Stored R1 status is `todo`.

| Event | Value | Parents | Retired |
| --- | --- | --- | --- |
| a | ready | a | yes |
| b | shot | a | yes |

At head `687f0d41`, reading this map raised `RangeError: Maximum call stack size exceeded` through `status-resolution.ts`. A two-node cycle a→b→a reachable from a frontier had the same problem. A lone self-parent had no frontier and returned stored status instead.

The review fix makes the policy explicit: **a cycle anywhere in a beat's valid status-event graph makes that beat read its stored status**. This applies equally to isolated cycles and cycles reachable from active or retired frontier events. Invalid record shapes are absent, missing/foreign-target parents are absent, and malformed events on another beat do not contaminate this beat. Graph validation, ancestry traversal and retired-value evaluation are iterative.

Literal checks: `node --test test/marks/status-malformed.test.ts`. Nine 96-case matrices cover cycles, foreign parents (including a cross-target cycle), malformed values and ignored prior metadata through every reader and the index; a persistent-index control covers replacement/repair, and a 20,000-event retired chain verifies evaluation without call-stack recursion.
