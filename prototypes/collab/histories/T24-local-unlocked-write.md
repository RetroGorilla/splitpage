A tab bypassing writable ownership changes persisted character identities while another tab holds the Web Lock.

Observed in Edg/157.0.4341.42. Reproduce with the locked local browser command in local-report.md.

Generation 1 committed. The browser lock query confirms the (deployment, instance) lock is held by the first tab.
The second tab is refused normally; its deliberately defective path writes generation 2 without acquiring the lock.
A later reopened transaction reads: generation=2; status=Ready; writable=true; editor=[R1: s1(a) a1(b)]; network=[R1: s1(a) a1(b)]; manifest=[].
The independent literal generation-1 identity oracle rejects the unauthorized a1, even though the storage write committed.
