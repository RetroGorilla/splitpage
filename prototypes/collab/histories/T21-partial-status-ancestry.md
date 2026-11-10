# T21 status: authoring with partial causal ancestry

Shows an open Stage 2 command-contract question, not replica disagreement. No decided two-event row determines this case.

Stored R1 status is `todo`. Use real `changeStatus` commands with separate clients: client 1 creates x=`ready`; client 2 receives x and creates p=`todo`, parents `[x]`; client 3 receives x,p and creates a=`shot`, parents `[p]`.

| Client 4 sees before creating c=`ready` | Recorded c.parents | Deliver all events, undo c | Every reader and late joiner |
| --- | --- | --- | --- |
| x,a; p withheld | `[a,x]` | c retired | todo |
| x,p,a | `[a]` | c retired | shot |

The generated event sets differ, so this does not violate set-based resolution. It shows that a command's recorded frontier depends on which ancestor records have arrived; the later arrival of p does not rewrite c.parents.

**Yjs can deliver a without p when they originate on different clients.** Each is a separate key in the root statusEvents map. The application's parent-id string is not a Yjs struct dependency. The test captures each actual command update, applies x and a while withholding p, and asserts a is present and p absent before c is authored. If p and a were successive structs from one client, that client's clock dependencies would instead delay a's integration until the missing structs arrived.

Open question for Stage 2: should a reader or command ignore an event until all of its ancestors are present? This PR does not change that contract. Literal reproduction: `node --test test/marks/review-histories.test.ts`.
