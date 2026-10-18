// The money contract between the orchestrator and every wallet (Spec 02 "Bet
// computation", Spec 05):
//
//   bet             = allowedBets[betIndex]               (the ladder rung, D)
//   priceMultiplier = clientPriceMultiplier x stakeMultiplier   (C x stake)
//   cost            = bet x priceMultiplier               (what the wallet debits)
//   win             = settleAmount(multiplier, cost)
//
// The orchestrator used to send `bet = D x C` together with
// `priceMultiplier = C x stake`, so a wallet pricing the round the documented
// way (bet x priceMultiplier, as MockPlatform, the conformance kit and the
// production adapters do) charged D x C^2 x stake: a three-chip table round at
// D=100 debited 900 for a 300 stake. These tests pin the single meaning across
// spin, deferred open/close, retries, restart adoption and refusals.

import { afterEach, describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import { withDeferredClose } from "../src/deferred-close.js";
import { remove as forgetSession } from "../src/session.js";
import { MockPlatform } from "@open-rgs/platform-mock";
import {
  defineGame, RGSError,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath, type SpinContext,
  type ConnectionMeta, type PlatformEvent, type WalletOpenRound,
} from "@open-rgs/contract";

/** Records every money call so a test can assert "one debit, one credit". */
class RecordingMock extends MockPlatform {
  calls: { kind: "settle" | "open" | "close"; bet?: number; priceMultiplier?: number; win?: number }[] = [];
  override async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.calls.push({ kind: "settle", bet: req.bet, priceMultiplier: req.priceMultiplier, win: req.win });
    return super.settleSimple(req);
  }
  override async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    this.calls.push({ kind: "open", bet: req.bet, priceMultiplier: req.priceMultiplier });
    return super.openComplex(req);
  }
  override async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    this.calls.push({ kind: "close", win: req.win });
    return super.closeComplex(req);
  }
}

function fixedMath(multiplier: number, seen: SpinContext[] = []): SimpleMath {
  return {
    kind: "simple", name: "fixed", version: "1", rtp: 36 / 37,
    play: (_prev, ctx) => { seen.push(ctx); return { multiplier, ops: [{ kind: "x", m: multiplier }], type: multiplier > 0 ? "win" : "loss" }; },
  };
}

const sessionIds: string[] = [];
afterEach(() => { for (const sid of sessionIds.splice(0)) forgetSession(sid); });

function setup(opts: { multiplier?: number; balance?: number; ladder?: number[]; seen?: SpinContext[] } = {}) {
  const platform = new RecordingMock({
    startingBalance: opts.balance ?? 100_000,
    allowedBets: opts.ladder ?? [100],
    defaultBetIndex: 0,
    currencyDecimals: 2,
    currency: "FUN",
  });
  const math = fixedMath(opts.multiplier ?? 12, opts.seen);
  const manifest = defineGame({
    id: "price-contract", declaredRtp: 36 / 37, defaultMode: "normal", maxWinMultiplier: 100_000,
    modes: {
      normal: { math, stakeMultiplier: 1 },
      ante: { math, stakeMultiplier: 1.25 },
      buy: { math, stakeMultiplier: 100 },
      deferred: { math: withDeferredClose(math), stakeMultiplier: 1 },
    },
  });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: `c-${Math.random()}`, sessionId: null, demo: true };
  return { orch, platform, conn };
}

async function init(o: ReturnType<typeof setup>, sid: string) {
  sessionIds.push(sid);
  await o.platform.connect();
  return o.orch.init({ sid }, o.conn);
}

async function rejection(fn: () => Promise<unknown>): Promise<RGSError> {
  try { await fn(); } catch (e) { return e as RGSError; }
  throw new Error("expected a rejection");
}

describe("simple spin: cost = ladder rung x client price x stake", () => {
  test("D=100, C=3, stake 1: debits exactly 300 and pays 12 x 300", async () => {
    const seen: SpinContext[] = [];
    const o = setup({ multiplier: 12, seen });
    await init(o, "pc-simple-3");
    const r = await o.orch.spin({ mode: "normal", betIndex: 0, priceMultiplier: 3 }, o.conn);
    expect(r.win).toBe(3600);
    expect(r.balance).toBe(100_000 - 300 + 3600);
    expect(r.bet).toBe(100);
    expect(r.priceMultiplier).toBe(3);
    expect(o.platform.calls).toEqual([{ kind: "settle", bet: 100, priceMultiplier: 3, win: 3600 }]);
    // math still sees the full price, currency-blind
    expect(seen[0]!.priceMultiplier).toBe(3);
    expect(seen[0]!.betIndex).toBe(0);
  });

  test("an ordinary slot round (C=1, stake 1) is unchanged", async () => {
    const o = setup({ multiplier: 2 });
    await init(o, "pc-simple-1");
    const r = await o.orch.spin({ mode: "normal" }, o.conn);
    expect(r.bet).toBe(100);
    expect(r.priceMultiplier).toBe(1);
    expect(r.win).toBe(200);
    expect(r.balance).toBe(100_000 - 100 + 200);
  });

  test("buy (stake 100, C=1) debits 100 x D once", async () => {
    const o = setup({ multiplier: 3 });
    await init(o, "pc-buy");
    const r = await o.orch.spin({ mode: "buy" }, o.conn);
    expect(r.priceMultiplier).toBe(100);
    expect(r.win).toBe(30_000);
    expect(r.balance).toBe(100_000 - 10_000 + 30_000);
    expect(o.platform.calls).toEqual([{ kind: "settle", bet: 100, priceMultiplier: 100, win: 30_000 }]);
  });

  test("ante (stake 1.25) composes with the client price: C=3 debits 375", async () => {
    const o = setup({ multiplier: 10 });
    await init(o, "pc-ante");
    const r = await o.orch.spin({ mode: "ante", priceMultiplier: 3 }, o.conn);
    expect(r.priceMultiplier).toBe(3.75);
    expect(r.win).toBe(3750);
    expect(r.balance).toBe(100_000 - 375 + 3750);
  });

  test("the largest client price (100000) at D=1 debits 100000, not its square", async () => {
    const o = setup({ multiplier: 0, ladder: [1], balance: 1_000_000 });
    await init(o, "pc-max");
    const r = await o.orch.spin({ mode: "normal", priceMultiplier: 100_000 }, o.conn);
    expect(r.balance).toBe(1_000_000 - 100_000);
  });

  test("balance is checked against the full cost, before the math runs", async () => {
    const seen: SpinContext[] = [];
    const o = setup({ balance: 299, seen });
    await init(o, "pc-insufficient");
    const e = await rejection(() => o.orch.spin({ mode: "normal", priceMultiplier: 3 }, o.conn));
    expect(e.code).toBe("INSUFFICIENT_BALANCE");
    expect(seen).toHaveLength(0);
    expect(o.platform.calls).toHaveLength(0);
    // exactly affordable goes through
    const ok = await o.orch.spin({ mode: "normal", priceMultiplier: 2 }, o.conn);
    expect(ok.balance).toBe(299 - 200 + 2400);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 100_001, "3" as unknown as number])(
    "an invalid client price %p is refused before RNG and before the wallet",
    async (price) => {
      const seen: SpinContext[] = [];
      const o = setup({ seen });
      await init(o, `pc-invalid-${String(price)}`);
      const e = await rejection(() => o.orch.spin({ mode: "normal", priceMultiplier: price }, o.conn));
      expect(e).toBeInstanceOf(RGSError);
      expect(e.code).toBe("INVALID_BET");
      expect(seen).toHaveLength(0);
      expect(o.platform.calls).toHaveLength(0);
    },
  );

  test("a retried spin with the same idempotency key settles once", async () => {
    const o = setup({ multiplier: 12 });
    await init(o, "pc-retry");
    const a = await o.orch.spin({ mode: "normal", priceMultiplier: 3, idempotencyKey: "k-1" }, o.conn);
    const b = await o.orch.spin({ mode: "normal", priceMultiplier: 3, idempotencyKey: "k-1" }, o.conn);
    expect(b.roundId).toBe(a.roundId);
    expect(b.balance).toBe(100_000 - 300 + 3600);
    expect(o.platform.calls.filter((c) => c.kind === "settle")).toHaveLength(1);
  });
});

describe("deferred close: one debit at open, one credit at close", () => {
  test("D=100, C=3: open debits 300, close credits 3600, retries move nothing", async () => {
    const o = setup({ multiplier: 12 });
    await init(o, "pc-deferred");
    const opened = await o.orch.openRound({ mode: "deferred", priceMultiplier: 3, idempotencyKey: "open-1" }, o.conn);
    expect(opened.bet).toBe(100);
    expect(opened.priceMultiplier).toBe(3);
    expect(opened.balance).toBe(100_000 - 300);
    const reOpen = await o.orch.openRound({ mode: "deferred", priceMultiplier: 3, idempotencyKey: "open-1" }, o.conn);
    expect(reOpen.roundId).toBe(opened.roundId);
    expect(reOpen.balance).toBe(100_000 - 300);

    // A reconnect before the close sees the round's price, not a recomputed one.
    const again = await o.orch.init({ sid: "pc-deferred" }, o.conn);
    expect(again.resume?.bet).toBe(100);
    expect(again.resume?.priceMultiplier).toBe(3);

    const closed = await o.orch.closeRound({ idempotencyKey: "close-1" }, o.conn);
    expect(closed.win).toBe(3600);
    expect(closed.balance).toBe(100_000 - 300 + 3600);
    const reClose = await o.orch.closeRound({ idempotencyKey: "close-1" }, o.conn);
    expect(reClose.balance).toBe(100_000 - 300 + 3600);

    expect(o.platform.calls).toEqual([
      { kind: "open", bet: 100, priceMultiplier: 3 },
      { kind: "close", win: 3600 },
    ]);
  });
});

// --- restart adoption ---------------------------------------------------------

interface Stored { roundId: string; bet: number; priceMultiplier: number; modeId?: string; state: string; mathVersion?: string; terms?: string }

/** A wallet that outlives the orchestrator and prices rounds as bet x priceMultiplier. */
class DurableWallet implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 100_000;
  open = new Map<string, Stored>();
  debits: number[] = [];
  credits: number[] = [];
  private seq = 0;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    const o = this.open.get(sessionId);
    const openRound: WalletOpenRound | undefined = o && {
      roundId: o.roundId, modeId: o.modeId ?? "", bet: o.bet, ops: [], actionLog: [], openedAt: 1,
      state: o.state, ...(o.mathVersion ? { mathVersion: o.mathVersion } : {}), ...(o.terms ? { terms: o.terms } : {}),
    };
    return {
      sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0,
      ...(openRound ? { openRound } : {}),
    };
  }
  async settleSimple(_r: SettleSimple): Promise<RoundReceipt> { throw new Error("complex only"); }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    const cost = req.bet * req.priceMultiplier;
    this.balance -= cost;
    this.debits.push(cost);
    const roundId = `dr-${++this.seq}`;
    this.open.set(req.sessionId, {
      roundId, bet: req.bet, priceMultiplier: req.priceMultiplier, state: req.initialState,
      ...(req.modeId ? { modeId: req.modeId } : {}), ...(req.mathVersion ? { mathVersion: req.mathVersion } : {}),
      ...(req.terms ? { terms: req.terms } : {}),
    });
    return { roundId, balance: this.balance };
  }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    const o = this.open.get(req.sessionId);
    if (!o || o.roundId !== req.roundId) throw new Error("RoundNotOpen");
    this.balance += req.win;
    this.credits.push(req.win);
    this.open.delete(req.sessionId);
    return { roundId: req.roundId, balance: this.balance };
  }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

function durableRuntime(wallet: DurableWallet, multiplier: number, stake = 1) {
  const manifest = defineGame({
    id: "g", declaredRtp: 0.96, defaultMode: "deferred", maxWinMultiplier: 10_000,
    modes: { deferred: { math: withDeferredClose(fixedMath(multiplier)), stakeMultiplier: stake } },
  });
  return {
    orch: createOrchestrator({ manifest, platform: wallet }),
    conn: { connectionId: `c-${Math.random()}`, sessionId: null, demo: false } as ConnectionMeta,
  };
}

describe("restart: a round is settled at the price it was opened at", () => {
  test("a C=3 round opened before a restart is adopted and paid on 300, once", async () => {
    const wallet = new DurableWallet();
    const p1 = durableRuntime(wallet, 12);
    sessionIds.push("pc-adopt");
    await p1.orch.init({ sid: "pc-adopt" }, p1.conn);
    await p1.orch.openRound({ priceMultiplier: 3 }, p1.conn);
    expect(wallet.debits).toEqual([300]);
    expect(wallet.open.get("pc-adopt")?.terms).toContain("cp=3");
    forgetSession("pc-adopt");

    const p2 = durableRuntime(wallet, 12);
    const init = await p2.orch.init({ sid: "pc-adopt" }, p2.conn);
    expect(init.resume?.bet).toBe(100);
    expect(init.resume?.priceMultiplier).toBe(3);
    const closed = await p2.orch.closeRound({}, p2.conn);
    expect(closed.win).toBe(3600);
    expect(wallet.debits).toEqual([300]);
    expect(wallet.credits).toEqual([3600]);
    expect(wallet.balance).toBe(100_000 - 300 + 3600);
  });

  test("a round opened under the legacy v1 terms (bet already D x C) keeps its old price", async () => {
    const wallet = new DurableWallet();
    const p = durableRuntime(wallet, 12);
    // What a pre-fix orchestrator persisted for D=100, C=3, stake 1.
    const parked = await withDeferredClose(fixedMath(12)).open(undefined, { mode: "deferred" });
    wallet.balance -= 300;
    wallet.open.set("pc-legacy", {
      roundId: "legacy-1", bet: 300, priceMultiplier: 3, modeId: "deferred", state: parked.state as string,
      mathVersion: "1", terms: "v1;stake=1;cap=10000",
    });
    sessionIds.push("pc-legacy");
    const init = await p.orch.init({ sid: "pc-legacy" }, p.conn);
    expect(init.resume?.roundId).toBe("legacy-1");
    const closed = await p.orch.closeRound({}, p.conn);
    expect(closed.win).toBe(3600);
    expect(wallet.balance).toBe(100_000 - 300 + 3600);
  });

  test("a round whose persisted price disagrees with its terms is not adopted", async () => {
    const wallet = new DurableWallet();
    const p = durableRuntime(wallet, 12);
    const parked = await withDeferredClose(fixedMath(12)).open(undefined, { mode: "deferred" });
    wallet.open.set("pc-tampered", {
      roundId: "t-1", bet: 100, priceMultiplier: 3, modeId: "deferred", state: parked.state as string,
      mathVersion: "1", terms: "v2;stake=1;cap=10000;cp=1.5",
    });
    sessionIds.push("pc-tampered");
    const init = await p.orch.init({ sid: "pc-tampered" }, p.conn);
    expect(init.resume).toBeUndefined();
    expect(wallet.credits).toEqual([]);
  });
});
