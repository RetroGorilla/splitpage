A local saved claim before transaction completion loses acknowledged identities on a renderer crash.

Observed in Edg/157.0.4341.42. Reproduce with the locked local browser command in local-report.md.

Harness sends generation 1 (a=s1) and observes Saved on this device after commit.
Harness holds generation 2 (ab=s1 a1) transaction open; defective tab reports Saved on this device.
Harness receipt ledger: [1,2]. Page.crash kills the renderer while the gate remains held.
Fresh-tab hydration: generation=1; status=Ready; writable=true; editor=[R1: s1(a)]; network=[R1: s1(a)]; manifest=[].
Independent checker rejects: Saved 2, recovered only 1.
