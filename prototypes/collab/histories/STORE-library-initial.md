y-indexeddb's initial whenSynced event is observable before the initial persistence transaction commits.

Observed in Edg/157.0.4341.42. Reproduce with the locked local browser command in local-report.md.

Seed a=s1 in memory, hold the library's initial transaction with harness-owned requests.
whenSynced resolved: generation=0; status=Read-only; writable=false; editor=[R1: s1(a)]; network=[no rows]; manifest=[].
Page.crash while that transaction is held.
Fresh library hydration: generation=0; status=Ready; writable=true; editor=[no rows]; network=[no rows]; manifest=[].
The literal s1 identity oracle rejects the empty recovered document; whenSynced cannot be a saved receipt.
