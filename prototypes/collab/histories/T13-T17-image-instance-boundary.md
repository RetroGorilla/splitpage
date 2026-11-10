# T13 / T17 image-instance boundary found and closed

Shows that the image module's fixed `fixture` scope cannot publish or retrieve P for a generated collaboration instance through its current public surface.

The original boundary probes ran on `c3b655b2`. They were not completed T13/T17 traces. The authorized follow-up changes configuration and image-route wiring while retaining the closed caller capability list.

1. Start the existing child service with instance admission and the image policy enabled.
2. Create and commit an instance I through the instance API; I is a generated canonical document id. Keep its recognized invitation.
3. PUT the literal one-pixel PNG P from `test/service/images/harness.ts` to `/api/images/I/<sha>`: **404**. Direct SQLite read: zero `(I, sha)` memberships.
4. Positive control: PUT identical bytes to `/api/images/fixture/<sha>`: **201**. Direct SQLite read: one `(fixture, sha)` membership, still zero `(I, sha)` memberships. This control does not establish P durability for I.
5. Construct `ImagePublication` through its public constructor with P, then attach through its public method to the same service.
6. Pending-image / one document: actual outgoing authentication frame names `fixture` and carries a zero-length token. The received authentication decision denies it.
7. Upload-before-sync / two documents: the same actual document name, empty token and denial occur.

The client constructor/attach surface accepts neither the generated instance name nor its invitation token. Upload-before-sync's canonical control frames also embed `fixture`. The HTTP route accepts only that same fixed name. No private field, captured live document, provider replacement or frame-rewriting workaround was used.

The initial lane stopped at this boundary. The follow-up authorization permits immutable instance/invitation inputs, instance-addressed blob membership and the corresponding admission wiring.

`ImagePublication` now copies those inputs into private fields. Its owned provider and exact canonical controls use them, with `fixture` and an empty token remaining the defaults. Neither input appears as a returned capability, getter or own property. The existing literal inventory runs unchanged under both defaults and generated instances. Blob HTTP requests are admitted against the instance's credentials, and an invitation for another instance is refused.

Literal outcomes remain unchanged: T13 requires local and server `R1 "abcdXY"`, durable P, exactly one creation, pending-guest refusal, invitation after both persistence contracts and a receipt covering g2. T17 requires invited C to load `R1 "abcd"` and P after checkpoint/journal/blob recovery, edit only after hydration and show `Saved on this device`.

Both rows now run with P under pending-image and upload-before-sync with two documents. `test/service/instance/images-lifecycle.test.ts` covers the full literals, upload restart, lost commit response, duplicate delivery and late joins. A separate deliberately lost blob after checkpoint/restart is rejected before honest traces count. See `T13-T17-picture-loss.md` for that minimized history and `src/service/images/instance-handoff-report.md` for the final result matrix.
