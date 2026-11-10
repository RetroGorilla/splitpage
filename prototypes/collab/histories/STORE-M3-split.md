Separate N and E transactions recover inconsistent generations after a renderer crash between commits.

Observed in Edg/157.0.4341.42. Reproduce with the locked local browser command in local-report.md.

Commit generation 1 for E, N and the manifest. Apply generation 2 in memory.
Commit only N in a second transaction. Page.crash before E or metadata are written.
Fresh-tab hydration: generation=1; status=Ready; writable=true; editor=[R1: s1(a)]; network=[R1: s1(a) a1(b)]; manifest=[].
Checker rejects: Network has generation 2; editor and metadata have generation 1.
