# Picture loss after checkpoint and restart

Shows that recovered text, a retained picture reference and a membership row cannot establish that P survived.

1. Create instance I with `R1 "abcd"`, identities `a:7:0 b:7:1 c:7:2 d:7:3`, and gallery item `{id:"gP", beat:"R1", ref:p, pending:false}`.
2. Upload P through the instance-authorized blob HTTP route. Independently read its membership and exact PNG bytes.
3. An owned image client joins and hydrates P; its full-snapshot transmission receives a positive receipt.
4. Capture a checkpoint containing the document reference, commit it, prune its covered journal and stop all clients.
5. Kill the server. Deliberately delete only P's hash file, leaving the membership and checkpoint unchanged.
6. Restart. Independent checkpoint/tail recovery still has literal `abcd`, `gP`, the correct p and instance docId. Membership still lists p.
7. `assertStoredP` reads the actual file and fails with `Recovered picture bytes missing`. No saved or complete-picture result is endorsed.

P is the one-pixel PNG fixture with SHA-256 `6b1048f8a6d40bac0b2954c18fefa40c4ea7a96120fc2e54b7317c0e43c2bbec`. The identical checker runs on honest T13/T17 recoveries. This defect is rejected under both pending-image and upload-before-sync with two documents before any honest image-bearing trace is registered.

Replay: `node --test --test-concurrency=1 test/service/instance/images-lifecycle.test.ts`.
