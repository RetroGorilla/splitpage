# T21: late fields, repeated heads and accessor indices

These are the final review's minimized failures at 82e15f19. Earlier failure histories and evidence commit 8efcff79 remain readable.

Seed R1 `a`. Writer 1 calls `addComment(...,"C1","R1",0,1,"Alice")`; synchronize. Writer 2 sets C1's `resolution` to `{resolved:true}`; synchronize and load a third copy. Writer keys were `author,createdAt,text,rowId,field,resolution,recovery,replies`; the loaded copy started with `resolution`. A reply's later `updatedAt` had the same effect.

Literal current comment keys: `["author","createdAt","text","rowId","field","resolution","recovery","replies"]`. Adding `zFuture` then `aFuture` appends `["aFuture","zFuture"]`. Reply keys: `["id","commentId","author","createdAt","updatedAt","text"]`. The strict checker reads these objects directly.

B layout: R1 `a`, R2 `b`; attach an IncrementalProjection and set `segments["seg-b-R2"].head={b:"R1"}`. The observing writer kept R1 `a`; fresh and encoded-load projections produced R1 `ab`.

Literal current rows: `[{id:"R1",audioText:"a",visualText:""}]`. A segment starts without an active block; a repeated/malformed head cannot claim prefix text. A new valid inner boundary can resume it. A valid `{b:"missing"}` retains a second row `{id:"missing",audioText:"b",visualText:""}` even without beat metadata. Three projection paths share the assembler.

Compare `Object.defineProperty([0],"0",{get:()=>1,enumerable:true,configurable:true})` with `[1]`. The old comparison read the getter and skipped its descriptor. Literal result: reject the accessor through check and checkKnown before reading its indexed value.

Tests: test/reader-order/review.test.ts, general.test.ts and wire.test.ts. These cases do not prove agreement for an unbounded set of stored records.
