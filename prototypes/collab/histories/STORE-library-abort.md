A failed y-indexeddb update leaves synced true and the newer in-memory identities absent after recovery.

Observed in Edg/157.0.4341.42. Reproduce with the locked local browser command in local-report.md.

Persist a=s1; a later readonly transaction is the commit fence. Apply ab=s1 a1 and abort its write transaction.
After the abort: generation=2; status=Saving on this device; writable=true; editor=[R1: s1(a) a1(b)]; network=[R1: s1(a) a1(b)]; manifest=[]; synced=true.
Page.crash, then reopen from retained IndexedDB state.
Fresh library hydration: generation=0; status=Ready; writable=true; editor=[R1: s1(a)]; network=[no rows]; manifest=[].
