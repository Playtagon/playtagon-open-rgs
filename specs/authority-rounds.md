# External-authority complex rounds (initial core slice)

An embedding room service can supply an immutable OPEN binding and a resolution decision to pure complex math. This is an opt-in library interface, not a public HTTP route and not a complete multiplayer runtime.

## Wiring

Configure `roundAuthority` and capture `onAuthorityAPI` on `createOrchestrator` or `createServer`. Keep the captured API exclusively in the server. The normal `OrchestratorAPI` passed to `ClientTransport` never contains these methods.

An authority mode declares `resolutionAuthority`, `recoveryMode: 'external-authority'`, and complex math with `authorityVersion: 1` and `resume`. The manifest must use `autoclose.policy: 'math-decides'`; the wallet must support `findSettledClose`. Startup rejects incomplete configurations. The current WASM state-only ABI does not declare authority support; this slice is for TypeScript math supporting the extra context argument.

- `openBoundRound`: session must already be initialized by the host; passes the resolved bet/index/price and stable key to `resolveOpen`. The resolver must durably validate the binding, amount, phase, eligibility and input hash before returning. Promotions are not supported by this initial authority path.
- `closeDecidedRound` / `autocloseDecidedRound`: require the exact RGS round and decision IDs. The resolver validates the immutable decision and its due time, binding and ownership. A missing decision produces NOT_READY with no wallet call. An admin/session autoclose asks the same resolver; disconnect does not manufacture a loss. Only crash-loss selects math.autoclose; other decisions use math.close.
- `restoreBoundRound`: rebuilds through the wallet and `authorizeRestore`; unlike the legacy fixed-at-open route it can restore an active externally-owned binding. Bad terms, math version, state or authority approval fail closed. It does not create a new bet.

Math receives the same resolution context for terminal and close. It must verify its own rules/binding and return only public-safe ops and `finalState`. Private draw/seed/context are not automatically copied into wallet requests. Type safety alone does not prove that a particular math implementation keeps secrets: release tests must inspect wallet/checkpoint/ops/log captures.

## Recovery and money

Authority CLOSE uses a stable per-round request token and the existing wallet idempotency key. Lost responses are rebuilt from the wallet's recorded finalState plus the resolver's saved decision. A retry for an old round does not settle a newer open round. Authority ID, recovery mode and rounding policy are pinned in commercial terms.

`moneyRounding: 'floor-e8'` additionally requires an exact decimal-string `CloseOutcome.multiplierE8`, matching the display multiplier, positive integral stake multiplier and an E8-representable cap. Core clamps to the configured cap and computes `BigInt(stake) * E8 / 100000000`, then checks the money safe range. Existing modes retain half-even. A different rounding policy cannot adopt the open round.

An authority OPEN exception is audited as `open-unknown`, not as proof that no debit happened. The host must keep its durable reservation until reconciliation. An OPEN receipt also cannot overwrite a newer `balanceChanged` event received while the request was in flight. A checkpoint restored through the authority API adopts the round without making another debit.

The bounded OPEN response cache is a convenience, not durable admission. Beyond cache expiry/restart the room journal and wallet must recover uncertain OPENs by stable key. The embedding host must perform inquiry instead of treating a timeout as a failed debit, and it must not open a new bet while the old outcome is unknown.

## Not delivered by this slice

No Room Service, PostgreSQL room repository, lease/fencing implementation, liability reservation, operation inquiry adapter, PF ceremony/curve, crash math implementation, gateway/WSS, guest route or UI is shipped here. Resolver implementations in tests are fixtures. This code must not be enabled for a live crash game until those consumers and end-to-end failure tests exist. No deployed vendor pin was changed.
