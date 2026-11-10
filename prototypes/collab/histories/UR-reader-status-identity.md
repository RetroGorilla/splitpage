# Command-record status identities differ from the retained reader history

Porting the identity-writing undo history in test/reader-order/review.test.ts exposes an unnormalized command-record status key. The original expectation is unchanged.

Base: #1421 head 04253f24b01d1caa5052d9c00f0b406ff15f357e. Replay function: runReaderIdentity in test/undo-records/reader-order.ts.

The retained history loads a beat and registries with lone-surrogate identities, then splits, joins, removes and restores the beat. It changes the status with target `\uD800`, event `status\uD800`, value `ready`, author Alice, and undoes that status command. The original history uses the library-backed changeStatus/undoStatus pair; the port uses changeStatus/CommandHistory.undo.

The original literal assertion recursively requires every stored map key to equal wireIdentity(key), including statusEvents and retiredStatus. It also requires the normalized status event identity list `["status\uFFFD"]`.

Observed: the port reaches statusEvents and fails because its raw key is `status\uD800`; expected `status\uFFFD`. The preceding 60 key assertions pass. No input or expected result was changed to normalize it for the command.

Resolved: command-record commands pass their arguments through the shared acceptCommand entry point, importing normalizeIdentityTree from the existing reader writer helper. Stored command records and inverse records use that same normalizer. runReaderIdentity now passes 71 key assertions with the original literal. command-identities.test.ts checks all writing command kinds against encoded reloads after command, undo, redo and second undo, including raw keys and values. No status implementation, expected result or declared limit was changed.
