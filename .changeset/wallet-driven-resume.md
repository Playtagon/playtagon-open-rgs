---
"@open-rgs/contract": minor
"@open-rgs/core": minor
---

Wallet-driven resume (ADR-007): the orchestrator adopts a complex round the wallet reports open on `openSession` (`SessionInfo.openRound: WalletOpenRound` with `state` + `mathVersion`), so a round opened before a restart or on another pod resumes and settles once. `OpenComplex.modeId` tells the wallet which mode to persist; `ComplexMath.resume(state)` (implemented by `withDeferredClose`) rebuilds the render ops. Adoption requires a known complex mode, the persisted state and the same math version; otherwise the round is left to the autoclose backstop.
