Enabling editing on lock acquisition is rejected while a harness-held storage transaction blocks hydration.

Observed in Edg/157.0.4341.42. Reproduce with the locked local browser command in local-report.md.

Generation 1 committed. Another tab starts and holds a readwrite transaction that blocks the hydration read.
The harness awaits hydration entry from inside the acquired lock callback for ["deployment-A","defect-hydrate"].
While the storage gate is held: generation=0; status=Hydrating; writable=true; editor=[no rows]; network=[no rows]; manifest=[]; editRefused=false.
The generation-2 edit is accepted by the defective tab; the same hydration-refusal checker rejects it.
After the harness releases hydration, editing succeeds: generation=2; status=Saving on this device; writable=true; editor=[R1: s1(a) a1(b)]; network=[R1: s1(a) a1(b)]; manifest=[].
