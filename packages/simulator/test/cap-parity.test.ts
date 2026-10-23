// The simulator's cap must behave EXACTLY as the orchestrator's, because the
// whole point of measuring a capped RTP is that it is the RTP the server pays.
// The simulator has no core dependency by design, so the rule is implemented
// twice - and pinned here, against the real thing.

import { describe, expect, test } from "bun:test";
import { applyMaxWinCap, createOrchestrator, log } from "@open-rgs/core";
import { applyCap, sampleMode, simulate, xoshiro256ss } from "../src/index.js";
import { defineGame, type ConnectionMeta, type PlatformAdapter, type SettleSimple, type SimpleMath } from "@open-rgs/contract";

describe("cap parity with the orchestrator", () => {
  const cases: Array<[number, number | undefined]> = [
    [0, 5000], [1, 5000], [4999.9, 5000], [5000, 5000], [5000.1, 5000], [1e9, 5000],
    [0.5, undefined], [12345, undefined],
    [-1, 5000], [-0, 5000],
  ];

  for (const [multiplier, cap] of cases) {
    test(`multiplier ${multiplier} under cap ${cap ?? "none"}`, () => {
      const engine = applyMaxWinCap({ multiplier, ops: [], type: "spin" }, 1, cap).multiplier;
      expect(applyCap(multiplier, cap)).toBe(engine);
    });
  }

  test("a non-finite multiplier fails the round in the engine and pays nothing here", () => {
    // The engine throws rather than paying (the NaN <= cap trap). The simulator
    // cannot throw away a whole run for one bad spin, so it counts zero - which
    // is the same money.
    expect(() => applyMaxWinCap({ multiplier: NaN, ops: [], type: "spin" }, 1, 5000)).toThrow();
    expect(applyCap(NaN, 5000)).toBe(0);
    expect(applyCap(Infinity, 5000)).toBe(0);
  });
});

describe("measured RTP is the RTP the server would pay", () => {
  // 1 spin in 1000 pays 100_000x; the manifest caps at 5_000x.
  // Uncapped RTP = 100. Capped RTP = 5.
  let n = 0;
  const spiky: SimpleMath = {
    kind: "simple", name: "spiky", version: "1", rtp: 5,
    play: () => (++n % 1000 === 0
      ? { multiplier: 100_000, ops: [], type: "win" }
      : { multiplier: 0, ops: [], type: "loss" }),
  };

  test("the cap is applied, and its cost is reported", async () => {
    n = 0;
    const manifest = defineGame({
      id: "cap", declaredRtp: 1, defaultMode: "default", maxWinMultiplier: 5_000,
      modes: { default: { math: spiky, stakeMultiplier: 1 } },
    });
    const [r] = await simulate(manifest, { spinsPerMode: 10_000 });
    expect(r!.rtp.measured).toBeCloseTo(5, 6);
    expect(r!.rtp.measuredUncapped).toBeCloseTo(100, 6);
    expect(r!.rtp.maxWinMultiplier).toBe(5_000);
    expect(r!.rtp.capped.rounds).toBe(10);
    expect(r!.rtp.capped.rtpRemoved).toBeCloseTo(95, 6);
    // and the distribution the report prints is the capped one
    expect(r!.win.maxMultiplier).toBe(5_000);
  });

  test("a per-mode cap overrides the game-wide one, as it does in the orchestrator", async () => {
    n = 0;
    const manifest = defineGame({
      id: "cap2", declaredRtp: 1, defaultMode: "default", maxWinMultiplier: 5_000,
      modes: { default: { math: spiky, stakeMultiplier: 1, maxWinMultiplier: 1_000 } },
    });
    const [r] = await simulate(manifest, { spinsPerMode: 10_000 });
    expect(r!.rtp.measured).toBeCloseTo(1, 6);
    expect(r!.rtp.maxWinMultiplier).toBe(1_000);
  });

  test("no cap configured leaves the measurement untouched", async () => {
    n = 0;
    const manifest = defineGame({
      id: "cap3", declaredRtp: 1, defaultMode: "default",
      modes: { default: { math: spiky, stakeMultiplier: 1 } },
    });
    const [r] = await simulate(manifest, { spinsPerMode: 10_000 });
    expect(r!.rtp.measured).toBeCloseTo(100, 6);
    expect(r!.rtp.capped.rounds).toBe(0);
    expect(r!.rtp.maxWinMultiplier).toBeNull();
  });
});

describe("release sampling pays what the engine pays", () => {
  // The same deterministic payout sequence, played once through the real
  // orchestrator against a recording wallet and once through sampleMode.
  const raw = [0, 10, 49.5, 50, 75, 0, 2, 1_000_000, 0.25, 3];
  const replay = (): SimpleMath => {
    let i = 0;
    return {
      kind: "simple", name: "replay", version: "1", rtp: 1,
      play: () => ({ multiplier: raw[i++ % raw.length]!, ops: [], type: "x" }),
    };
  };
  // A feature buy priced at 100x with its own 50x cap under a 5000x game cap.
  const manifestFor = (math: SimpleMath) => defineGame({
    id: "parity", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 5_000,
    modes: {
      base: { math: replay(), stakeMultiplier: 1 },
      buy: { math, stakeMultiplier: 100, maxWinMultiplier: 50 },
    },
  });

  test("mode-specific cap and full mode cost agree with the orchestrator", async () => {
    const settles: SettleSimple[] = [];
    const wallet = {
      isHealthy: true, diagnostics: {},
      async connect() {}, disconnect() {}, onEvent() {},
      async openSession(id: string) {
        return { sessionId: id, currency: "USD", currencyDecimals: 2, balance: 1e12, allowedBets: [100], defaultBetIndex: 0 };
      },
      async settleSimple(req: SettleSimple) { settles.push(req); return { roundId: `r${settles.length}`, balance: 1e12 }; },
    } as unknown as PlatformAdapter;
    const orch = createOrchestrator({ manifest: manifestFor(replay()), platform: wallet });
    const conn = { connectionId: "c1", sessionId: null, demo: false } as ConnectionMeta;
    const level = log.getLevel();
    log.setLevel("warn"); // keep the session-init info line out of test output
    try {
      await orch.init({ sid: "parity-1" }, conn);
      for (let i = 0; i < raw.length * 3; i++) await orch.spin({ sid: "parity-1", mode: "buy", betIndex: 0 }, conn);
    } finally {
      log.setLevel(level);
    }

    const cost = settles.reduce((a, s) => a + s.bet * s.priceMultiplier, 0);
    const win = settles.reduce((a, s) => a + s.win, 0);
    const engineClipped = settles.filter((s) => s.type === "max_win_reached").length;
    expect(settles.every((s) => s.priceMultiplier === 100)).toBe(true);

    const c = await sampleMode(manifestFor(replay()), "buy", { rounds: raw.length * 3, rng: xoshiro256ss(new Uint8Array(32).fill(1)) });
    // RTP against the FULL mode price, after the mode's own cap
    expect(c.mean).toBeCloseTo(win / cost, 12);
    expect(c.capClipped).toBe(engineClipped);
    expect(c.maxMultiplier).toBe(Math.max(...settles.map((s) => s.multiplier)));
    expect(c.maxWinMultiplier).toBe(50);
  });

  test("a non-finite payout fails the round in both, instead of paying zero", async () => {
    expect(() => applyMaxWinCap({ multiplier: NaN, ops: [], type: "spin" }, 1, 5000)).toThrow();
    const nan: SimpleMath = { kind: "simple", name: "nan", version: "1", rtp: 1, play: () => ({ multiplier: NaN, ops: [], type: "x" }) };
    await expect(sampleMode(manifestFor(nan), "buy", { rounds: 1, rng: xoshiro256ss(new Uint8Array(32).fill(1)) }))
      .rejects.toThrow(/invalid multiplier/);
  });
});
