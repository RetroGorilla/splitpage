# T13 deliberate lifecycle defects

Shows that the independent database oracle rejects a retry allocating twice and an invitation preceding either commit.

1. `create(k)` uploads and commits `R1 "abcd"`, returning instance I.
2. Defective retry changes its allocation key and returns a second pending instance J.
3. `assertSingleCreation` reads SQLite itself and fails: `Retry created a second instance`.
4. Defective invitation publication exposes J while its row is pending.
5. `assertInvitation` fails: `Invitation preceded server commit`.
6. Exposing I without a committed local membership separately fails: `Invitation preceded local commit`.

Executable control: the first subtest in `test/service/instance/instance.test.ts`. Normal same-k retries and all six creation kill points run only after these defective fixtures are rejected. The defective retry adapter deliberately changes its internal allocation key; the client-facing operation is still the original attempt. The honest service also has a unique operation constraint.
