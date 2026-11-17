# Using the storage layer (for Owners B and C)

Code: `aggregator/src/storage/` (`types.ts` = contract, `memory.ts` = reference fake, `mongoRepository.ts` = real adapter,
`contracts.ts` = interface-only checkpoint / inbox / envelope proposals).

```ts
import { InMemoryRepository } from './storage/memory.js';   // tests: no database needed, real ordering/partial semantics
const repo = new InMemoryRepository(3);
const r = await repo.ingest({ event, eventVersion: 7, epoch: leaderEpoch });
// r.outcome: 'applied' | 'duplicate' | 'stale_version' | 'stale_epoch' | 'unavailable' (UNKNOWN: retry same identity or read back)
repo.setUnitDown(1, true);                                    // simulate a lost storage unit
const page = await repo.queryGlobal({ sort: 'occurred_desc', limit: 50 });  // page.partial / page.unavailable_units
```

Rules
* Identity is `hazardIdFor(source, source_ref_id)`; never generate random ids. (Open decision O-1: tell A before changing it.)
* A fence/version check and its write are one operation (`epoch`, `eventVersion`). Do the same for checkpoints and inbox state.
* `unavailable` means unknown outcome, not failure.
* Replicas are never separate partitions; do not merge replica results into global queries.
* Audit routes are mounted from `index.ts` with `createStorageRouter`; pass your inbox as `unprocessed` to feed `/internal/audit/unprocessed`.
* Run the tests: `cd aggregator && npm test`.
