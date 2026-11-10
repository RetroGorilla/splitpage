# T13 baseline receipt registration

Shows why g0 must be separated from the edits made during handoff.

1. The initial commit durably contains `R1 "abcd"`, identities `7:0..3`.
2. The owner has typed `X:11:0` and `Y:11:1` during upload.
3. The provider's initial SyncStep2 sends the missing edits, rather than retransmitting g0.
4. An early implementation registered the whole local document as new work in `ConnectionReceipts`.
5. The received positive status covered the transmitted edits; the tracker still waited for an acknowledgement of g0 and never reached `Your changes saved to server`.
6. The corrected handoff registers its captured incremental updates separately. The T13 gate now requires sending before the g2-containing message is released and server-saved only after its covering receipt.

No artifact 8 expectation changed. Retained by `T13: g0 upload retains g1/g2` in `test/service/instance/instance.test.ts`.
