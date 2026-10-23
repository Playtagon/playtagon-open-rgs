// sampleMode: the streaming, resumable sampler release checks run on. A chunk
// is a summary (Welford moments, counts, exact payout frequencies, a fixed
// histogram) plus the state needed to continue the SAME stream elsewhere, so a
// run split across processes measures exactly what one uninterrupted run would.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsMath } from "@open-rgs/core";
import { defineGame, type GameManifest, type ComplexMath, type SimpleMath, type SpinContext } from "@open-rgs/contract";
import {
  sampleMode, mergeSampleChunks, xoshiro256ss, HISTOGRAM_EDGES,
  type SampleChunk, type StatefulSimulatorRng,
} from "../src/index.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 53 + 7) & 0xff);

let dir = "";
let mathPath = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sample-test-"));
  mathPath = join(dir, "tiers.ts");
  // A math that draws from the injected host RNG exactly as a built release
  // math does, loaded through the real runtime loader.
  await writeFile(mathPath, `
    export default (host) => ({
      kind: "simple", name: "tiers", version: "1.0.0", rtp: 0.95,
      play: (carry, ctx) => {
        const r = host.rng_next();
        const m = r < 0.6 ? 0 : r < 0.85 ? 0.5 : r < 0.95 ? 2 : r < 0.99 ? 10 : r < 0.999 ? 100 : 2000;
        return { multiplier: m, ops: [{ kind: "tier", feature: r >= 0.99 }], type: m > 0 ? "win" : "loss" };
      },
    });
  `);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function tiersManifest(rng: StatefulSimulatorRng, cap?: number): Promise<GameManifest> {
  const math = await loadTsMath(mathPath, { rng });
  return defineGame({
    id: "tiers", declaredRtp: 0.95, defaultMode: "base",
    ...(cap !== undefined ? { maxWinMultiplier: cap } : {}),
    modes: { base: { math, stakeMultiplier: 1 } },
  });
}

/** A math replaying a fixed sequence of multipliers, independent of any RNG. */
function seqMath(values: readonly number[], extra: (i: number) => Partial<{ carry: string; nextMode: string }> = () => ({})): SimpleMath {
  let i = 0;
  return {
    kind: "simple", name: "seq", version: "1", rtp: 1,
    play: () => {
      const k = i++;
      return { multiplier: values[k % values.length]!, ops: [], type: "x", ...extra(k) };
    },
  };
}
const manifestOf = (math: SimpleMath | ComplexMath, stakeMultiplier = 1, cap?: number): GameManifest => defineGame({
  id: "g", declaredRtp: 1, defaultMode: "base",
  modes: { base: { math, stakeMultiplier, ...(cap !== undefined ? { maxWinMultiplier: cap } : {}) } },
});

const featureObserver = (ops: readonly unknown[]) => ({
  feature: ops.some((o) => (o as { feature?: boolean }).feature === true),
  capOp: ops.some((o) => (o as { kind?: string }).kind === "max_win"),
});

describe("determinism", () => {
  test("two runs with the same seed match exactly", async () => {
    const a = xoshiro256ss(SEED);
    const b = xoshiro256ss(SEED);
    const ca = await sampleMode(await tiersManifest(a), "base", { rounds: 10_000, rng: a, observe: featureObserver });
    const cb = await sampleMode(await tiersManifest(b), "base", { rounds: 10_000, rng: b, observe: featureObserver });
    expect(ca).toEqual(cb);
    expect(ca.count).toBe(10_000);
    expect(ca.resume.rng).toEqual(a.snapshot());
  });

  test("a different seed gives a different sample", async () => {
    const a = xoshiro256ss(SEED);
    const b = xoshiro256ss(OTHER_SEED);
    const ca = await sampleMode(await tiersManifest(a), "base", { rounds: 10_000, rng: a });
    const cb = await sampleMode(await tiersManifest(b), "base", { rounds: 10_000, rng: b });
    expect(ca.mean).not.toBe(cb.mean);
  });
});

describe("resumable chunks", () => {
  test("4000 + 6000 rounds, resumed in a fresh process, equals 10000", async () => {
    const whole = xoshiro256ss(SEED);
    const full = await sampleMode(await tiersManifest(whole), "base", { rounds: 10_000, rng: whole, observe: featureObserver });

    const first = xoshiro256ss(SEED);
    const c1 = await sampleMode(await tiersManifest(first), "base", { rounds: 4_000, rng: first, observe: featureObserver });
    // round-trip the state through JSON, as a checkpoint does
    const saved = JSON.parse(JSON.stringify(c1.resume)) as SampleChunk["resume"];
    // a new generator AND a newly loaded math: nothing survives but the checkpoint
    const second = xoshiro256ss(SEED, saved.rng);
    const c2 = await sampleMode(await tiersManifest(second), "base", { rounds: 6_000, rng: second, resume: saved, observe: featureObserver });

    expect(c1.count).toBe(4_000);
    expect(c2.count).toBe(6_000); // a chunk summarizes its own rounds only
    const merged = mergeSampleChunks(c1, c2);
    expect(merged.count).toBe(full.count);
    expect(merged.hits).toBe(full.hits);
    expect(merged.capClipped).toBe(full.capClipped);
    expect(merged.capReached).toBe(full.capReached);
    expect(merged.observed).toEqual(full.observed);
    expect(merged.maxMultiplier).toBe(full.maxMultiplier);
    expect(merged.positivePayouts).toEqual(full.positivePayouts);
    expect(merged.histogram).toEqual(full.histogram);
    expect(merged.resume).toEqual(full.resume);
    expect(merged.resume.roundsCompleted).toBe(10_000);
    expect(merged.mean).toBeCloseTo(full.mean, 12);
    expect(merged.m2 / full.m2).toBeCloseTo(1, 12);
  });

  test("resuming with a generator that is not at the checkpoint is refused", async () => {
    const first = xoshiro256ss(SEED);
    const c1 = await sampleMode(await tiersManifest(first), "base", { rounds: 100, rng: first });
    const fresh = xoshiro256ss(SEED); // still at the start, not the checkpoint
    await expect(sampleMode(await tiersManifest(fresh), "base", { rounds: 100, rng: fresh, resume: c1.resume }))
      .rejects.toThrow(/does not match the resume state/);
  });

  test("resuming a different mode is refused", async () => {
    const math = seqMath([1]);
    const manifest = defineGame({
      id: "g", declaredRtp: 1, defaultMode: "a",
      modes: { a: { math, stakeMultiplier: 1 }, b: { math, stakeMultiplier: 1 } },
    });
    const rng = xoshiro256ss(SEED);
    const c1 = await sampleMode(manifest, "a", { rounds: 10, rng });
    await expect(sampleMode(manifest, "b", { rounds: 10, rng, resume: c1.resume })).rejects.toThrow(/mode/);
  });

  test("carry is threaded and survives the chunk boundary", async () => {
    // pays the round count carried from the previous round: dependent rounds
    const counting = (): SimpleMath => ({
      kind: "simple", name: "carry", version: "1", rtp: 1,
      play: (carry) => {
        const n = carry === undefined ? 0 : Number(carry);
        return { multiplier: n % 3, ops: [], type: "x", carry: String(n + 1) };
      },
    });
    const rngA = xoshiro256ss(SEED);
    const full = await sampleMode(manifestOf(counting()), "base", { rounds: 10, rng: rngA });
    const rngB = xoshiro256ss(SEED);
    const c1 = await sampleMode(manifestOf(counting()), "base", { rounds: 4, rng: rngB });
    expect(c1.resume.carry).toBe("4");
    const c2 = await sampleMode(manifestOf(counting()), "base", { rounds: 6, rng: rngB, resume: c1.resume });
    const merged = mergeSampleChunks(c1, c2);
    expect(merged.positivePayouts).toEqual(full.positivePayouts);
    expect(merged.mean).toBeCloseTo(full.mean, 12);
    // and the dependence is reported, never hidden inside an independent-round CI
    expect(full.carriedRounds).toBe(10);
    expect(merged.carriedRounds).toBe(10);
  });

  test("nextMode routing is reported as dependence", async () => {
    const rng = xoshiro256ss(SEED);
    const c = await sampleMode(manifestOf(seqMath([0, 5], (i) => (i % 2 ? { nextMode: "fs" } : {}))), "base", { rounds: 10, rng });
    expect(c.nextModeRounds).toBe(5);
    expect(c.carriedRounds).toBe(0);
    const indep = await sampleMode(manifestOf(seqMath([0, 5])), "base", { rounds: 10, rng });
    expect(indep.nextModeRounds).toBe(0);
    expect(indep.carriedRounds).toBe(0);
    expect(indep.resume.carry).toBeNull();
  });
});

describe("statistics", () => {
  test("Welford moments match a two-pass computation", async () => {
    const values = [0, 0, 0.5, 2, 0, 10, 0, 0.25, 100, 3];
    const c = await sampleMode(manifestOf(seqMath(values)), "base", { rounds: 1_000, rng: xoshiro256ss(SEED) });
    const xs = Array.from({ length: 1_000 }, (_, i) => values[i % values.length]!);
    const mu = xs.reduce((a, x) => a + x, 0) / xs.length;
    const m2 = xs.reduce((a, x) => a + (x - mu) ** 2, 0);
    expect(c.mean).toBeCloseTo(mu, 12);
    expect(c.m2 / m2).toBeCloseTo(1, 12);
    expect(c.hits).toBe(600);
    expect(c.maxMultiplier).toBe(100);
  });

  test("exact positive payouts are counted, losses excluded, ascending", async () => {
    const c = await sampleMode(manifestOf(seqMath([0, 2, 0.1, 2, 0, 0.30000000000000004])), "base", { rounds: 6, rng: xoshiro256ss(SEED) });
    expect(c.positivePayouts).toEqual([[0.1, 1], [0.30000000000000004, 1], [2, 2]]);
  });

  test("the fixed histogram uses upper-inclusive edges [0,1,2,5,10,20,50,100,500,1000,5000,+inf]", async () => {
    expect([...HISTOGRAM_EDGES]).toEqual([0, 1, 2, 5, 10, 20, 50, 100, 500, 1000, 5000, Infinity]);
    const values = [0, 0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20, 50, 51, 100, 499, 500, 1000, 4999, 5000, 5001, 1e6];
    const c = await sampleMode(manifestOf(seqMath(values)), "base", { rounds: values.length, rng: xoshiro256ss(SEED) });
    //                     <=0 <=1 <=2 <=5 <=10 <=20 <=50 <=100 <=500 <=1000 <=5000 >5000
    expect(c.histogram).toEqual([1, 2, 2, 2, 2, 2, 1, 2, 2, 1, 2, 2]);
  });

  test("observer flags are counted per round", async () => {
    const a = xoshiro256ss(SEED);
    const c = await sampleMode(await tiersManifest(a), "base", { rounds: 20_000, rng: a, observe: featureObserver });
    expect(c.observed["feature"]).toBeGreaterThan(0);
    expect(c.observed["capOp"]).toBe(0); // no cap configured: no cap op
    // the math flags exactly its >= 100x tiers
    const tens = c.positivePayouts.filter(([m]) => m >= 100).reduce((n, [, k]) => n + k, 0);
    expect(c.observed["feature"]).toBe(tens);
  });

  test("an empty chunk is valid and resumable", async () => {
    const rng = xoshiro256ss(SEED);
    const c = await sampleMode(manifestOf(seqMath([1])), "base", { rounds: 0, rng });
    expect(c.count).toBe(0);
    expect(c.mean).toBe(0);
    expect(c.m2).toBe(0);
    expect(c.histogram).toEqual(new Array(12).fill(0));
  });
});

describe("the round is played as the engine plays it", () => {
  test("the context carries the full mode price and the caller's params, never cheats", async () => {
    const seen: SpinContext[] = [];
    const math: SimpleMath = {
      kind: "simple", name: "ctx", version: "1", rtp: 1,
      play: (_c, ctx) => { seen.push(ctx); return { multiplier: 0, ops: [], type: "x" }; },
    };
    await sampleMode(manifestOf(math, 100), "base", { rounds: 2, rng: xoshiro256ss(SEED), params: { zone: "red", chips: 1 } });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ mode: "base", betIndex: 0, priceMultiplier: 100, params: { zone: "red", chips: 1 } });
    expect(seen[0]!.cheat).toBeUndefined();
  });

  test("the mode-specific cap applies and both cap counts are reported", async () => {
    const values = [0, 40, 50, 60, 1000];
    const manifest = defineGame({
      id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 5_000,
      modes: { base: { math: seqMath(values), stakeMultiplier: 100, maxWinMultiplier: 50 } },
    });
    const c = await sampleMode(manifest, "base", { rounds: 5, rng: xoshiro256ss(SEED), observe: featureObserver });
    expect(c.maxWinMultiplier).toBe(50);
    expect(c.stakeMultiplier).toBe(100);
    expect(c.maxMultiplier).toBe(50);
    expect(c.capClipped).toBe(2);  // 60 and 1000 were clipped
    expect(c.capReached).toBe(3);  // 50 reached it exactly, plus the two clipped
    expect(c.observed["capOp"]).toBe(2); // the engine's max_win op on clipped rounds
    expect(c.mean).toBeCloseTo((0 + 40 + 50 + 50 + 50) / 5, 12);
  });

  test("negative payouts clamp to zero, as in the engine", async () => {
    const c = await sampleMode(manifestOf(seqMath([-3, 1])), "base", { rounds: 2, rng: xoshiro256ss(SEED) });
    expect(c.mean).toBe(0.5);
    expect(c.hits).toBe(1);
  });

  for (const bad of [NaN, Infinity, -Infinity, undefined, "2"]) {
    test(`an invalid payout (${String(bad)}) throws instead of counting as zero`, async () => {
      const math: SimpleMath = {
        kind: "simple", name: "bad", version: "1", rtp: 1,
        play: () => ({ multiplier: bad as number, ops: [], type: "x" }),
      };
      await expect(sampleMode(manifestOf(math), "base", { rounds: 3, rng: xoshiro256ss(SEED) })).rejects.toThrow(/invalid multiplier/);
    });
  }

  test("complex rounds use the given generator for strategy choices", async () => {
    const complex = (): ComplexMath => ({
      kind: "complex", name: "pick", version: "1", rtp: 1,
      open: () => ({ state: "0", ops: [], awaiting: { type: "pick", options: [1, 2, 3, 4] } }),
      step: (_s, a) => ({ state: String(a.value), ops: [{ kind: "picked", value: a.value }] }),
      isTerminal: (s) => s !== "0",
      close: (s) => ({ multiplier: Number(s), ops: [], type: "x" }),
    });
    const a = await sampleMode(manifestOf(complex()), "base", { rounds: 2_000, rng: xoshiro256ss(SEED), complexStrategy: "random" });
    const b = await sampleMode(manifestOf(complex()), "base", { rounds: 2_000, rng: xoshiro256ss(SEED), complexStrategy: "random" });
    expect(a).toEqual(b);
    expect(a.positivePayouts.map(([m]) => m)).toEqual([1, 2, 3, 4]);
  });

  test("bad arguments are rejected", async () => {
    const rng = xoshiro256ss(SEED);
    const m = manifestOf(seqMath([1]));
    await expect(sampleMode(m, "nope", { rounds: 1, rng })).rejects.toThrow(/unknown mode/);
    await expect(sampleMode(m, "base", { rounds: -1, rng })).rejects.toThrow(/rounds/);
    await expect(sampleMode(m, "base", { rounds: 1.5, rng })).rejects.toThrow(/rounds/);
    await expect(sampleMode(m, "base", { rounds: 1, rng: (() => 0.5) as unknown as StatefulSimulatorRng })).rejects.toThrow(/snapshot/);
  });
});

describe("the runtime loader still refuses simulator generators in production", () => {
  test("loadTsMath rejects xoshiro256ss under NODE_ENV=production", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await expect(loadTsMath(mathPath, { rng: xoshiro256ss(SEED) })).rejects.toThrow(/simulator-only PRNG/);
    } finally {
      if (prev === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = prev;
    }
  });
});
