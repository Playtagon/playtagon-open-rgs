---
"@open-rgs/contract": minor
"@open-rgs/core": minor
"@open-rgs/platform-mock": patch
"@open-rgs/adapter-test-kit": minor
---

One round price everywhere: `bet` is the ladder rung (`allowedBets[betIndex]`), `priceMultiplier` is the client price x the mode's `stakeMultiplier`, and the wallet debits `bet x priceMultiplier`. The orchestrator used to send `bet = rung x clientPrice` together with `priceMultiplier = clientPrice x stake`, so every wallet pricing the round as documented (the mock, the conformance kit) charged `rung x clientPrice^2 x stake`: a three-chip round at 100 debited 900 instead of 300. Rounds with a client price of 1 (ordinary spins, buy and ante modes) are unchanged on the wire.

`ClientResponseSpin`, `ClientResponseOpenRound` and the INIT resume now report `bet` as the rung and add `priceMultiplier`; the audit event records `priceMultiplier` (appended to the hash only when present, so older chains verify unchanged). Round terms move to `v2;...;cp=<clientPrice>` and an adopted round is repriced from them; legacy `v1;` rounds keep their original cost. The mock wallet rejects a non-finite or negative `priceMultiplier`; the conformance kit uses `bet x priceMultiplier` in its balance expectations and adds `pricing.client-price` and `errors.invalid-price`.
