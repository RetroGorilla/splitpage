# T21: writer values must mean the same thing after encoded reload

Stored status is `todo`. These are literal regression inputs, with expected values written before running the fix.

| Shared event input | Expected status |
| --- | --- |
| `a={target:"R1",value:"ready",parents:new Array(1),by:"Alice"}` | `todo`: sparse parents are invalid |
| The same event with dense `parents:[]` and value `"bogus"`, `""`, `"READY"` or `"done"` | `todo`: unknown statuses are invalid |
| `a={target:"R1",value:"ready",parents:[],by:{toString:null,valueOf:null}}` and valid concurrent `b=shot` by Bob | `shot`: the invalid author makes a absent |

The previous guard used `parents.every`, which skips holes. The writer accepted the sparse event as `ready`; a fresh replica decoded its hole as explicit `undefined` and rejected it as `todo`. The previous guard also returned unknown status strings, and conflict-notice interpolation threw for the non-coercible author. These are the review's three retained counterexamples.

`test/marks/status-roundtrip.test.ts` retains seeds **1376**, **1413**, **1592590337** and **1592590338**. Each seed enumerates the complete input pool before sampling it, writes and recreates values in `statusEvents` and `retiredStatus`, checks deletion, and compares all five complete projected results plus an observing index with a fresh encoded-state replica. No reader may throw. Shared Yjs objects in projected registry metadata are compared by their public JSON value, rather than their local document/observer internals.

The pool includes holes; undefined/null in every required field; numbers, NaN and infinities; nested objects and arrays; typed arrays; 65,536-character strings; lone surrogates; inherited, hidden and getter fields; odd/null prototypes; null coercion methods; boxed values; shared types/subdocuments; valid events and invalid statuses. The literal sparse/status/author cases are also separate tests. Accepted events contain only validated target, value, parents and author data; `prior` is not consulted by any reader.

The validator canonicalizes a ContentAny value with the pinned lib0 codec used by Yjs, then validates a dense string parent array, one of `todo/ready/shot`, and string target/author fields. Binary and shared-type records are absent. This also makes inherited or hidden fields absent and normalizes strings exactly as the wire does. The commands validate their outgoing payloads and their tests assert that both status creation and undo leave only accepted events and true retirement flags.

Yjs refuses top-level symbols, functions, Uint16Array/Float64Array, ArrayBuffer, null-prototype objects without a supported constructor, and objects whose constructor is null. The property records refusals separately for each map and still checks the resulting document, including a status write that succeeded before its retirement write was refused. Uint8Array, arrays, undefined/null, boxed/date objects and shared types can be stored; unsuitable status shapes are ignored after canonicalization.
