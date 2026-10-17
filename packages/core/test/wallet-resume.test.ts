// ADR-007 / Spec 05 "Open-round persistence & resume": a complex round opened
// (and debited) by one process is resumed on a fresh INIT by ANOTHER process,
// from what the wallet returns on openSession — no shared store, no stickiness.
//
// The wallet below persists the open round the way Spec 05 asks (id, bet, mode,
// state, math version, open time) in an object that outlives the orchestrator,
// so "process 1 dies, process 2 takes the session" is two createOrchestrator()
// calls over one wallet, with process 1's in-memory session dropped in between
// (the session cache is module-level, so dropping it is what a restart does).

import { afterEach, describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import { withDeferredClose } from "../src/deferred-close.js";
import { remove as forgetSession } from "../src/session.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath, type ComplexMath,
  type ConnectionMeta, type PlatformEvent, type WalletOpenRound,
} from "@open-rgs/contract";

interface Stored { roundId: string; bet: number; modeId?: string; state: string; mathVersion?: string; openedAt: number }

class DurableWallet implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 100_000;
  open = new Map<string, Stored>();
  credits: number[] = [];
  closeKeys = new Set<string>();
  private seq = 0;
  /** Test knobs for adapters that persist less than Spec 05 asks. */
  dropState = false;
  forceVersion: string | undefined;

  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    const o = this.open.get(sessionId);
    const openRound: WalletOpenRound | undefined = o && {
      roundId: o.roundId, modeId: o.modeId ?? "", bet: o.bet, ops: [], actionLog: [], openedAt: o.openedAt,
      ...(this.dropState ? {} : { state: o.state }),
      ...(this.forceVersion ?? o.mathVersion ? { mathVersion: this.forceVersion ?? o.mathVersion } : {}),
    }
    return {
      sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0,
      ...(openRound ? { openRound } : {}),
    };
  }
  async settleSimple(_r: SettleSimple): Promise<RoundReceipt> { throw new Error("complex only"); }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    if (this.open.has(req.sessionId)) throw new Error("RoundAlreadyOpen");
    const cost = req.bet * req.priceMultiplier;
    this.balance -= cost;
    const roundId = `round-${++this.seq}`;
    this.open.set(req.sessionId, {
      roundId, bet: req.bet, ...(req.modeId ? { modeId: req.modeId } : {}), state: req.initialState,
      ...(req.mathVersion ? { mathVersion: req.mathVersion } : {}), openedAt: 1_700_000_000_000,
    });
    return { roundId, balance: this.balance };
  }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    if (req.idempotencyKey && this.closeKeys.has(req.idempotencyKey)) return { roundId: req.roundId, balance: this.balance };
    const o = this.open.get(req.sessionId);
    if (!o || o.roundId !== req.roundId) throw new Error("RoundNotOpen");
    this.balance += req.win;
    this.credits.push(req.win);
    if (req.idempotencyKey) this.closeKeys.add(req.idempotencyKey);
    this.open.delete(req.sessionId);
    return { roundId: req.roundId, balance: this.balance };
  }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

/** Deterministic outcome per draw so a re-run math could never coincide by luck. */
function simple(version = "1.0.0"): SimpleMath {
  let n = 0;
  return {
    kind: "simple", name: "buy", version, rtp: 0.96,
    play() {
      n++;
      return { multiplier: 7 * n, ops: [{ kind: "reveal", draw: n }, { kind: "win", x: 7 * n }], type: "win" };
    },
  };
}

function runtime(wallet: DurableWallet, m: ComplexMath) {
  const manifest = defineGame({
    id: "g", declaredRtp: 0.96, defaultMode: "base", maxWinMultiplier: 10_000,
    modes: { base: { math: m, stakeMultiplier: 1 }, buy: { math: m, stakeMultiplier: 50 } },
  });
  const orch = createOrchestrator({ manifest, platform: wallet });
  const conn: ConnectionMeta = { connectionId: `c-${Math.random()}`, sessionId: null, demo: false };
  return { orch, conn };
}

// The session cache is module-level and shared with other suites: never leave ours behind.
afterEach(() => { for (let i = 1; i <= 6; i++) forgetSession(`wr-s${i}`); });

describe("wallet-driven resume across processes (ADR-007)", () => {
  test("a round opened by process 1 is resumed, rendered and settled once by process 2", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s1" }, p1.conn);
    const opened = await p1.orch.openRound({ mode: "buy" }, p1.conn);
    expect(wallet.balance).toBe(100_000 - 100 * 50);
    forgetSession("wr-s1"); // process 1 dies here: nothing of its memory survives

    const p2 = runtime(wallet, withDeferredClose(simple()));
    const init = await p2.orch.init({ sid: "wr-s1" }, p2.conn);
    expect(init.resume?.roundId).toBe(opened.roundId);
    expect(init.resume?.modeId).toBe("buy");
    expect(init.resume?.ops).toEqual(opened.ops); // regenerated from the persisted state, not empty
    expect(init.resume?.awaiting?.type).toBe("endRound");
    expect(init.resume?.replay?.unfinished).toBe(true);
    expect(init.resume as Record<string, unknown>).not.toHaveProperty("state"); // math state never reaches the client

    const closed = await p2.orch.closeRound({}, p2.conn);
    // process 2's own math would have drawn n=1 again; the wallet's state says what process 1 decided
    expect(closed.win).toBe(7 * 100 * 50);
    expect(wallet.credits).toEqual([7 * 100 * 50]);
    expect(wallet.open.has("wr-s1")).toBe(false);
  });

  test("after resume the session plays on normally", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s2" }, p1.conn);
    await p1.orch.openRound({ mode: "base" }, p1.conn);
    forgetSession("wr-s2");
    const p2 = runtime(wallet, withDeferredClose(simple()));
    await p2.orch.init({ sid: "wr-s2" }, p2.conn);
    await p2.orch.closeRound({}, p2.conn);
    const next = await p2.orch.openRound({ mode: "base" }, p2.conn);
    expect(next.roundId).not.toBe("round-1");
  });

  test("a round opened under another math version is not adopted (that math cannot value it)", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple("1.0.0")));
    await p1.orch.init({ sid: "wr-s3" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    forgetSession("wr-s3");
    const p2 = runtime(wallet, withDeferredClose(simple("2.0.0")));
    const init = await p2.orch.init({ sid: "wr-s3" }, p2.conn);
    expect(init.resume).toBeUndefined();
    expect(wallet.credits).toEqual([]);
  });

  test("a wallet that does not persist the state yields no resume (pre-v1.7 behaviour)", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s4" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    wallet.dropState = true;
    forgetSession("wr-s4");
    const p2 = runtime(wallet, withDeferredClose(simple()));
    expect((await p2.orch.init({ sid: "wr-s4" }, p2.conn)).resume).toBeUndefined();
  });

  test("an unknown mode is not adopted", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s5" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    wallet.open.get("wr-s5")!.modeId = "retired-mode";
    forgetSession("wr-s5");
    const p2 = runtime(wallet, withDeferredClose(simple()));
    expect((await p2.orch.init({ sid: "wr-s5" }, p2.conn)).resume).toBeUndefined();
  });

  test("the orchestrator tells the wallet which mode a round was opened in", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s6" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    expect(wallet.open.get("wr-s6")?.modeId).toBe("buy");
  });
});

describe("withDeferredClose.resume", () => {
  test("rebuilds render ops and the end-round hint from a parked state", async () => {
    const m = withDeferredClose(simple(), { prompt: "Collect" });
    const open = await m.open(undefined, { mode: "base" });
    const r = await m.resume!(open.state);
    expect(r.ops).toEqual(open.ops);
    expect(r.awaiting).toEqual(open.awaiting);
  });
});
