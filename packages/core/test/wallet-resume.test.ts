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
import { deriveIdempotencyKey } from "../src/idempotency.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath, type ComplexMath,
  type ConnectionMeta, type PlatformEvent, type WalletOpenRound, type WalletSettledRound,
} from "@open-rgs/contract";

interface Stored { roundId: string; bet: number; modeId?: string; state: string; mathVersion?: string; openedAt: number; promoId?: string; terms?: string }

class DurableWallet implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 100_000;
  open = new Map<string, Stored>();
  credits: number[] = [];
  /** round id → settlement; `${sessionId}|${requestKey}` → round id (durable, every accepted close). */
  settled = new Map<string, WalletSettledRound>();
  requestRounds = new Map<string, string>();
  closeKeys = new Set<string>();
  private seq = 0;
  /** Test knobs for adapters that persist less than Spec 05 asks. */
  dropState = false;
  forceVersion: string | undefined;
  /** A free-round pool on the wallet (promo-funded rounds debit nothing). */
  promo: { id: string; bet: number; remaining: number; modeFilter?: string[] } | undefined;
  /** Whether this wallet keeps the state current through updateComplex. */
  checkpoints = false;
  updateComplex?: (req: { sessionId: string; roundId: string; state: string }) => Promise<void>;
  constructor() {
    this.updateComplex = async (req) => {
      if (!this.checkpoints) return;
      const o = this.open.get(req.sessionId);
      if (o && o.roundId === req.roundId) o.state = req.state;
    };
  }

  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    const o = this.open.get(sessionId);
    const openRound: WalletOpenRound | undefined = o && {
      roundId: o.roundId, modeId: o.modeId ?? "", bet: o.bet, ops: [], actionLog: [], openedAt: o.openedAt,
      ...(this.dropState ? {} : { state: o.state }),
      ...(this.forceVersion ?? o.mathVersion ? { mathVersion: this.forceVersion ?? o.mathVersion } : {}),
      ...(o.promoId ? { promoId: o.promoId } : {}),
      ...(o.terms ? { terms: o.terms } : {}),
    }
    return {
      sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0,
      ...(openRound ? { openRound } : {}),
      ...(this.promo && this.promo.remaining > 0 ? { promo: { ...this.promo } } : {}),
    };
  }
  async settleSimple(_r: SettleSimple): Promise<RoundReceipt> { throw new Error("complex only"); }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    if (this.open.has(req.sessionId)) throw new Error("RoundAlreadyOpen");
    if (req.promoId) { this.promo!.remaining--; }
    else this.balance -= req.bet * req.priceMultiplier;
    const roundId = `round-${++this.seq}`;
    this.open.set(req.sessionId, {
      roundId, bet: req.bet, ...(req.modeId ? { modeId: req.modeId } : {}), state: req.initialState,
      ...(req.mathVersion ? { mathVersion: req.mathVersion } : {}), openedAt: 1_700_000_000_000,
      ...(req.promoId ? { promoId: req.promoId } : {}),
      ...(req.terms ? { terms: req.terms } : {}),
    });
    return { roundId, balance: this.balance };
  }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    if (req.idempotencyKey && this.closeKeys.has(req.idempotencyKey)) {
      // a replay of an earlier settlement (e.g. an autoclose): still map the client token
      if (req.requestKey) this.requestRounds.set(`${req.sessionId}|${req.requestKey}`, req.roundId);
      return { roundId: req.roundId, balance: this.balance };
    }
    const o = this.open.get(req.sessionId);
    if (!o || o.roundId !== req.roundId) throw new Error("RoundNotOpen");
    this.balance += req.win;
    this.credits.push(req.win);
    if (req.idempotencyKey) this.closeKeys.add(req.idempotencyKey);
    this.open.delete(req.sessionId);
    this.settled.set(req.roundId, {
      roundId: req.roundId, modeId: o.modeId ?? "", win: req.win, multiplier: req.multiplier, type: req.type,
      balance: this.balance, finalState: req.finalState,
      ...(req.mathVersion ? { mathVersion: req.mathVersion } : {}),
    });
    if (req.requestKey) this.requestRounds.set(`${req.sessionId}|${req.requestKey}`, req.roundId);
    return { roundId: req.roundId, balance: this.balance };
  }
  async findSettledClose(sessionId: string, requestKey: string): Promise<WalletSettledRound | undefined> {
    const roundId = this.requestRounds.get(`${sessionId}|${requestKey}`);
    return roundId ? this.settled.get(roundId) : undefined;
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

function runtime(wallet: DurableWallet, m: ComplexMath, auditMode: "best-effort" | "mandatory" = "best-effort",
  terms: { buyStake?: number; maxWin?: number } = {}) {
  const manifest = defineGame({
    id: "g", declaredRtp: 0.96, defaultMode: "base", maxWinMultiplier: terms.maxWin ?? 10_000,
    modes: { base: { math: m, stakeMultiplier: 1 }, buy: { math: m, stakeMultiplier: terms.buyStake ?? 50 } },
  });
  const orch = createOrchestrator({ manifest, platform: wallet, auditMode });
  const conn: ConnectionMeta = { connectionId: `c-${Math.random()}`, sessionId: null, demo: false };
  return { orch, conn };
}

// The session cache is module-level and shared with other suites: never leave ours behind.
afterEach(() => { for (let i = 1; i <= 20; i++) forgetSession(`wr-s${i}`); });

/** A pick game: open → one pick step → terminal. The state after the step is what pays. */
function pickGame(): ComplexMath {
  return {
    kind: "complex", name: "pick", version: "1.0.0", rtp: 0.96,
    open: () => ({ state: "before-pick", ops: [{ kind: "board" }], awaiting: { type: "pick" } }),
    step: (_s, a) => ({ state: `picked:${(a as { slot?: number }).slot}`, ops: [{ kind: "reveal" }] }),
    isTerminal: (s) => s.startsWith("picked:"),
    close: (s) => ({ multiplier: s === "picked:3" ? 10 : 0, ops: [], type: "pick" }),
  };
}

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

describe("adoption safety (security review)", () => {
  test("a promo-funded round is priced like a free round (bet, no stake fold) when adopted", async () => {
    const wallet = new DurableWallet();
    // a pool usable in the 50× buy mode: the free round must still be priced at its bet
    wallet.promo = { id: "fs-1", bet: 100, remaining: 3, modeFilter: ["buy"] };
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s7" }, p1.conn);
    await p1.orch.promoAccept({ sid: "wr-s7", accept: true }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    expect(wallet.balance).toBe(100_000); // free round: nothing debited
    expect(wallet.open.get("wr-s7")?.modeId).toBe("buy");
    forgetSession("wr-s7");
    const p2 = runtime(wallet, withDeferredClose(simple()));
    expect((await p2.orch.init({ sid: "wr-s7" }, p2.conn)).resume?.roundId).toBe("round-1");
    const closed = await p2.orch.closeRound({}, p2.conn);
    expect(closed.win).toBe(7 * 100); // what the same round pays without a restart — not 7 × 100 × 50
  });

  test("a stepped round is not adopted when the wallet's state may predate the last step", async () => {
    const wallet = new DurableWallet(); // best-effort audit, no checkpoints kept
    const p1 = runtime(wallet, pickGame());
    await p1.orch.init({ sid: "wr-s8" }, p1.conn);
    await p1.orch.openRound({ mode: "base" }, p1.conn);
    await p1.orch.stepRound({ action: { type: "pick", slot: 3 } }, p1.conn);
    forgetSession("wr-s8");
    const p2 = runtime(wallet, pickGame());
    expect((await p2.orch.init({ sid: "wr-s8" }, p2.conn)).resume).toBeUndefined(); // no replay from the pre-pick state
  });

  test("even with mandatory checkpoints a round awaiting a decision is left to autoclose", async () => {
    const wallet = new DurableWallet();
    wallet.checkpoints = true;
    const p1 = runtime(wallet, pickGame(), "mandatory");
    await p1.orch.init({ sid: "wr-s9" }, p1.conn);
    await p1.orch.openRound({ mode: "base" }, p1.conn);
    await p1.orch.stepRound({ action: { type: "pick", slot: 3 } }, p1.conn);
    forgetSession("wr-s9");
    const p2 = runtime(wallet, pickGame(), "mandatory");
    // the pick is checkpointed here, but nothing recorded with the round proves it
    // (process 1 might have run best-effort), so the round is not adopted
    expect((await p2.orch.init({ sid: "wr-s9" }, p2.conn)).resume).toBeUndefined();
  });

  // --- Codex review 3 -----------------------------------------------------

  test("a stepped round is not adopted even under mandatory audit: the opener's checkpoint policy is unknown", async () => {
    // process 1 ran best-effort: its pick happened, its checkpoint did not land
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, pickGame(), "best-effort");
    await p1.orch.init({ sid: "wr-s10" }, p1.conn);
    await p1.orch.openRound({ mode: "base" }, p1.conn);
    await p1.orch.stepRound({ action: { type: "pick", slot: 1 } }, p1.conn);
    forgetSession("wr-s10");
    wallet.checkpoints = true; // process 2 is configured mandatory with checkpoints
    const p2 = runtime(wallet, pickGame(), "mandatory");
    expect((await p2.orch.init({ sid: "wr-s10" }, p2.conn)).resume).toBeUndefined(); // no second pick
  });

  test("two processes cannot both take a round that still awaits a decision", async () => {
    const wallet = new DurableWallet();
    wallet.checkpoints = true;
    const p1 = runtime(wallet, pickGame(), "mandatory");
    await p1.orch.init({ sid: "wr-s11" }, p1.conn);
    await p1.orch.openRound({ mode: "base" }, p1.conn);
    forgetSession("wr-s11");
    const p2 = runtime(wallet, pickGame(), "mandatory");
    const p3 = runtime(wallet, pickGame(), "mandatory");
    const [a, b] = [await p2.orch.init({ sid: "wr-s11" }, p2.conn), await p3.orch.init({ sid: "wr-s11" }, p3.conn)];
    // neither may branch the round's history (p2 picks 3, p3 picks 1)
    expect(a.resume).toBeUndefined();
    expect(b.resume).toBeUndefined();
  });

  test("a round is not adopted when the mode's price changed since it opened", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s12" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn); // 100 × 50 debited
    forgetSession("wr-s12");
    const p2 = runtime(wallet, withDeferredClose(simple()), "best-effort", { buyStake: 100 }); // same math, new price
    expect((await p2.orch.init({ sid: "wr-s12" }, p2.conn)).resume).toBeUndefined();
    expect(wallet.credits).toEqual([]);
  });

  test("a round is not adopted when the max-win cap changed since it opened", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s13" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    forgetSession("wr-s13");
    const p2 = runtime(wallet, withDeferredClose(simple()), "best-effort", { maxWin: 5 });
    expect((await p2.orch.init({ sid: "wr-s13" }, p2.conn)).resume).toBeUndefined();
  });

  test("a CLOSE whose response was lost is answered after a restart without a second credit", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s14" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    const first = await p1.orch.closeRound({ idempotencyKey: "close-1" }, p1.conn); // credited; the response never arrives
    forgetSession("wr-s14"); // and the runtime dies
    const p2 = runtime(wallet, withDeferredClose(simple()));
    const init = await p2.orch.init({ sid: "wr-s14" }, p2.conn);
    expect(init.resume).toBeUndefined();
    const again = await p2.orch.closeRound({ idempotencyKey: "close-1" }, p2.conn);
    expect(again).toEqual(first);
    expect(wallet.credits).toEqual([first.win]);
    // another token is not a retry of that close
    await expect(p2.orch.closeRound({ idempotencyKey: "close-2" }, p2.conn)).rejects.toThrow(/No round in progress/);
  });

  // --- Codex review 4 -----------------------------------------------------

  test("a retried CLOSE of an old round answers for THAT round, even when a new round is open", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s16" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    const a = await p1.orch.closeRound({ idempotencyKey: "close-A" }, p1.conn); // response lost
    forgetSession("wr-s16");
    const p2 = runtime(wallet, withDeferredClose(simple()));
    await p2.orch.init({ sid: "wr-s16" }, p2.conn);
    const b = await p2.orch.openRound({ mode: "buy" }, p2.conn);
    const retried = await p2.orch.closeRound({ idempotencyKey: "close-A" }, p2.conn);
    expect(retried).toEqual(a); // round A's result, not a settlement of B
    expect(wallet.open.get("wr-s16")?.roundId).toBe(b.roundId); // B is still open
    expect(wallet.credits).toEqual([a.win]);
  });

  test("a client CLOSE that only replays an autoclose settlement is still recoverable after a restart", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple()));
    await p1.orch.init({ sid: "wr-s17" }, p1.conn);
    const opened = await p1.orch.openRound({ mode: "buy" }, p1.conn);
    // another runtime serving the same session autocloses first: same per-round key, no client token
    await wallet.closeComplex({
      sessionId: "wr-s17", roundId: opened.roundId, finalState: wallet.open.get("wr-s17")!.state,
      win: 7 * 100 * 50, multiplier: 7, type: "win", reason: "idle", mathVersion: "1.0.0",
      idempotencyKey: deriveIdempotencyKey("wr-s17", opened.roundId, "close"),
    });
    // this runtime still holds the round: the client's CLOSE replays that settlement
    const first = await p1.orch.closeRound({ idempotencyKey: "close-C" }, p1.conn); // response lost
    expect(wallet.credits).toEqual([7 * 100 * 50]);
    forgetSession("wr-s17"); // and the runtime dies
    const p2 = runtime(wallet, withDeferredClose(simple()));
    await p2.orch.init({ sid: "wr-s17" }, p2.conn);
    expect(await p2.orch.closeRound({ idempotencyKey: "close-C" }, p2.conn)).toEqual(first);
    expect(wallet.credits).toEqual([7 * 100 * 50]);
  });

  test("a known CLOSE token whose result cannot be rebuilt is an error, never a close of the open round", async () => {
    const wallet = new DurableWallet();
    const p1 = runtime(wallet, withDeferredClose(simple("1.0.0")));
    await p1.orch.init({ sid: "wr-s18" }, p1.conn);
    await p1.orch.openRound({ mode: "buy" }, p1.conn);
    const a = await p1.orch.closeRound({ idempotencyKey: "close-A" }, p1.conn);
    forgetSession("wr-s18");
    const p2 = runtime(wallet, withDeferredClose(simple("2.0.0"))); // a new math version is deployed
    await p2.orch.init({ sid: "wr-s18" }, p2.conn);
    const b = await p2.orch.openRound({ mode: "buy" }, p2.conn);
    await expect(p2.orch.closeRound({ idempotencyKey: "close-A" }, p2.conn)).rejects.toThrow(/already settled/);
    expect(wallet.open.get("wr-s18")?.roundId).toBe(b.roundId);
    expect(wallet.credits).toEqual([a.win]);
  });
});
