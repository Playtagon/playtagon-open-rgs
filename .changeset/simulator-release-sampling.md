---
"@open-rgs/simulator": minor
---

Add `xoshiro256ss`, a full 256-bit-state simulator generator seeded from all 32
bytes of a seed, with `nextUint64()` and checkpointable `snapshot()` state, and
`sampleMode`, a streaming per-mode sampler for release checks: fixed-size chunk
summaries (Welford moments, hit/cap/observer counts, exact positive-payout
frequencies, a fixed histogram) that resume the same stream across processes,
merged with `mergeSampleChunks`. Unlike `simulate()`, a non-finite payout throws.
`simulate()`, `mulberry32` and the runtime RNG are unchanged.
