// Streaming, resumable per-mode sampling for release checks.
//
// simulate() keeps every round's multiplier to compute percentiles, which is
// right for a 100k-spin report and impossible for a billion-round check. A
// release check instead runs one mode in chunks: each chunk returns a fixed-size
// summary of ITS OWN rounds (Welford moments, counts, a fixed histogram, the
// exact frequency of every distinct positive payout) plus the state needed to
// continue the same stream - in this process or another one. Chunks combine
// with mergeSampleChunks (Chan et al.), so N rounds split across any number of
// checkpoints measure what one uninterrupted run would.
//
// Randomness: the math's RNG is wired at load time, so the caller loads the
// math with `loadTsMath(path, { rng })` and passes the SAME generator here,
// which also drives any complex-round strategy choice. The generator's state is
// the resume point; restore it with `xoshiro256ss(seed, resume.rng)` and reload
// the math with that generator before resuming.
//
// Every round is played and settled as the orchestrator would: the math sees
// the full mode price as `priceMultiplier`, the mode's cap (falling back to the
// game's) clips the payout through the shared applyCap, and the measured value
// is the capped multiplier, i.e. the return per unit of FULL mode cost. Unlike
// simulate(), a non-finite payout throws: the engine fails such a round, and a
// release measurement must not quietly count it as a loss.
//
// Independence: a release CI assumes independent, complete rounds. Carry is
// threaded and checkpointed exactly as the orchestrator threads it, but every
// round that returns carry or nextMode is counted (`carriedRounds`,
// `nextModeRounds`) so the caller can fail the math's capability rather than
// report a falsely narrow independent-round interval.

import type {
  GameManifest, SimpleMath, ComplexMath, AwaitingHint, CarryState, Op, SpinContext,
} from "@open-rgs/contract";
import type { StatefulSimulatorRng } from "./rng.js";
import { applyCap, pickAction, type ComplexStrategy } from "./simulate.js";

/** Upper-inclusive histogram edges, in multiples of the full mode cost:
 *  bin i counts payouts x with edge[i-1] < x <= edge[i] (bin 0 is x <= 0,
 *  i.e. losses; the last bin is x > 5000). 12 bins. */
export const HISTOGRAM_EDGES: readonly number[] = Object.freeze([0, 1, 2, 5, 10, 20, 50, 100, 500, 1000, 5000, Infinity]);

/** Where a sampled stream stands after a chunk. JSON-serializable. */
export interface SampleState {
  version: 1;
  mode: string;
  /** Rounds completed in this stream across all chunks so far. */
  roundsCompleted: number;
  /** Generator state at the boundary ({@link StatefulSimulatorRng.snapshot}). */
  rng: readonly string[];
  /** Math carry to thread into the next round, null when none. */
  carry: CarryState | null;
}

export interface SampleOptions {
  /** Rounds to play in this chunk (a non-negative safe integer). */
  rounds: number;
  /** Game-specific round parameters (SpinContext.params), e.g. a table zone. */
  params?: Record<string, unknown>;
  /** Continue a stream from a previous chunk's `resume`. */
  resume?: SampleState;
  /** The generator the math was loaded with; must be at `resume.rng`. */
  rng: StatefulSimulatorRng;
  /** Per-round flags decoded from the round's ops (engine-equivalent: the cap's
   *  `max_win` op is appended when the cap clips). Each true flag counts once. */
  observe?: (ops: readonly unknown[]) => Record<string, boolean>;
  /** Complex rounds only: how to choose actions. Default "first". */
  complexStrategy?: ComplexStrategy;
  /** Complex rounds only: step safety cap. Default 1000. */
  maxStepsPerRound?: number;
}

/** A fixed-size summary of one chunk's rounds (multiples of full mode cost). */
export interface SampleChunk {
  mode: string;
  stakeMultiplier: number;
  /** The cap the engine applies to this mode, null when uncapped. */
  maxWinMultiplier: number | null;
  /** Welford accumulators over the capped multiplier. Sample variance is
   *  m2 / (count - 1). */
  count: number;
  mean: number;
  m2: number;
  /** Rounds paying more than zero. */
  hits: number;
  /** Rounds whose raw payout exceeded the cap and was clipped. */
  capClipped: number;
  /** Rounds paying the cap (clipped or exactly at it). */
  capReached: number;
  /** Largest capped payout in the chunk (0 when empty). */
  maxMultiplier: number;
  /** Count of rounds per observer flag. */
  observed: Record<string, number>;
  /** Exact frequency of every distinct positive capped payout, ascending. */
  positivePayouts: Array<[multiplier: number, count: number]>;
  /** Counts per {@link HISTOGRAM_EDGES} bin. */
  histogram: number[];
  /** Rounds that returned carry / nextMode: dependence the release CI does not model. */
  carriedRounds: number;
  nextModeRounds: number;
  resume: SampleState;
}

/** Sample `rounds` complete rounds of one mode. Allocates no per-round storage. */
export async function sampleMode(
  manifest: GameManifest,
  mode: string,
  options: SampleOptions,
): Promise<SampleChunk> {
  const m = Object.prototype.hasOwnProperty.call(manifest.modes, mode) ? manifest.modes[mode] : undefined;
  if (!m) throw new Error(`sampleMode: unknown mode '${mode}'`);
  const { rounds, rng, resume, observe } = options;
  if (!Number.isSafeInteger(rounds) || rounds < 0) {
    throw new Error(`sampleMode: rounds must be a non-negative safe integer, got ${rounds}`);
  }
  if (typeof rng !== "function" || typeof rng.snapshot !== "function" || typeof rng.nextUint64 !== "function") {
    throw new Error("sampleMode: rng must be a stateful simulator generator with snapshot() (use xoshiro256ss)");
  }
  let carry: CarryState | undefined;
  let completedBefore = 0;
  if (resume) {
    if (resume.version !== 1) throw new Error(`sampleMode: unsupported resume state version ${String(resume.version)}`);
    if (resume.mode !== mode) throw new Error(`sampleMode: resume state is for mode '${resume.mode}', not '${mode}'`);
    if (!Number.isSafeInteger(resume.roundsCompleted) || resume.roundsCompleted < 0) {
      throw new Error("sampleMode: resume.roundsCompleted must be a non-negative safe integer");
    }
    if (!sameState(rng.snapshot(), resume.rng)) {
      throw new Error("sampleMode: the generator does not match the resume state; restore it with xoshiro256ss(seed, resume.rng)");
    }
    carry = resume.carry ?? undefined;
    completedBefore = resume.roundsCompleted;
  }
  if (!Number.isSafeInteger(completedBefore + rounds)) throw new Error("sampleMode: total rounds exceed the safe integer range");

  const cap = m.maxWinMultiplier ?? manifest.maxWinMultiplier;
  const ctx: SpinContext = {
    mode, betIndex: 0, priceMultiplier: m.stakeMultiplier,
    ...(options.params !== undefined ? { params: options.params } : {}),
  };
  const strategy = options.complexStrategy ?? "first";
  const maxSteps = options.maxStepsPerRound ?? 1000;

  let count = 0, mean = 0, m2 = 0;
  let hits = 0, capClipped = 0, capReached = 0, maxMultiplier = 0;
  let carriedRounds = 0, nextModeRounds = 0;
  const observed: Record<string, number> = {};
  const payouts = new Map<number, number>();
  const histogram = new Array<number>(HISTOGRAM_EDGES.length).fill(0);

  for (let i = 0; i < rounds; i++) {
    let raw: unknown;
    let ops: Op[];
    let nextMode: string | undefined;
    if (m.math.kind === "simple") {
      const r = (m.math as SimpleMath).play(carry, ctx);
      const out = r instanceof Promise ? await r : r;
      raw = out.multiplier; ops = out.ops; nextMode = out.nextMode; carry = out.carry;
    } else {
      const out = await playComplex(m.math as ComplexMath, carry, ctx, strategy, maxSteps, rng, observe !== undefined);
      raw = out.multiplier; ops = out.ops; nextMode = out.nextMode; carry = out.carry;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new Error(`sampleMode: math returned an invalid multiplier (${String(raw)}) in round ${completedBefore + i} of mode '${mode}'`);
    }
    if (carry !== undefined) carriedRounds += 1;
    if (nextMode !== undefined) nextModeRounds += 1;

    const sanitized = raw < 0 ? 0 : raw;
    const x = applyCap(raw, cap);
    const clipped = x !== sanitized;
    if (clipped) capClipped += 1;
    if (cap != null && x >= cap) capReached += 1;

    count += 1;
    const delta = x - mean;
    mean += delta / count;
    m2 += delta * (x - mean);
    if (x > 0) {
      hits += 1;
      payouts.set(x, (payouts.get(x) ?? 0) + 1);
      if (x > maxMultiplier) maxMultiplier = x;
    }
    let b = 0;
    while (x > HISTOGRAM_EDGES[b]!) b += 1;
    histogram[b]! += 1;

    if (observe) {
      const seen = clipped ? [...(ops ?? []), { kind: "max_win", cap_multiplier: cap, raw_multiplier: sanitized }] : (ops ?? []);
      const flags = observe(seen);
      for (const k of Object.keys(flags)) {
        observed[k] = (observed[k] ?? 0) + (flags[k] === true ? 1 : 0);
      }
    }
  }

  return {
    mode,
    stakeMultiplier: m.stakeMultiplier,
    maxWinMultiplier: cap ?? null,
    count, mean, m2,
    hits, capClipped, capReached, maxMultiplier,
    observed,
    positivePayouts: [...payouts.entries()].sort((a, b) => a[0] - b[0]),
    histogram,
    carriedRounds, nextModeRounds,
    resume: {
      version: 1, mode,
      roundsCompleted: completedBefore + rounds,
      rng: rng.snapshot(),
      carry: carry ?? null,
    },
  };
}

/** Combine two consecutive chunks of one stream (`b` follows `a`) into one
 *  summary: counts add, moments merge by Chan et al., payout frequencies
 *  merge exactly, and the resume point is `b`'s. Bulk callers may instead
 *  merge payout frequencies on disk; the moments rule is the same. */
export function mergeSampleChunks(a: SampleChunk, b: SampleChunk): SampleChunk {
  if (a.mode !== b.mode) throw new Error(`mergeSampleChunks: modes differ ('${a.mode}' vs '${b.mode}')`);
  if (b.resume.roundsCompleted !== a.resume.roundsCompleted + b.count) {
    throw new Error("mergeSampleChunks: chunks are not consecutive in one stream");
  }
  const count = a.count + b.count;
  const delta = b.mean - a.mean;
  const mean = count === 0 ? 0 : a.mean + delta * (b.count / count);
  const m2 = count === 0 ? 0 : a.m2 + b.m2 + delta * delta * (a.count * b.count / count);
  const observed: Record<string, number> = { ...a.observed };
  for (const [k, v] of Object.entries(b.observed)) observed[k] = (observed[k] ?? 0) + v;
  const payouts = new Map<number, number>(a.positivePayouts);
  for (const [x, n] of b.positivePayouts) payouts.set(x, (payouts.get(x) ?? 0) + n);
  return {
    mode: b.mode,
    stakeMultiplier: b.stakeMultiplier,
    maxWinMultiplier: b.maxWinMultiplier,
    count, mean, m2,
    hits: a.hits + b.hits,
    capClipped: a.capClipped + b.capClipped,
    capReached: a.capReached + b.capReached,
    maxMultiplier: Math.max(a.maxMultiplier, b.maxMultiplier),
    observed,
    positivePayouts: [...payouts.entries()].sort((x, y) => x[0] - y[0]),
    histogram: a.histogram.map((n, i) => n + (b.histogram[i] ?? 0)),
    carriedRounds: a.carriedRounds + b.carriedRounds,
    nextModeRounds: a.nextModeRounds + b.nextModeRounds,
    resume: b.resume,
  };
}

function sameState(a: readonly string[], b: readonly string[]): boolean {
  return Array.isArray(b) && a.length === b.length && a.every((w, i) => w === b[i]);
}

async function playComplex(
  math: ComplexMath,
  carry: CarryState | undefined,
  ctx: SpinContext,
  strategy: ComplexStrategy,
  maxSteps: number,
  rng: StatefulSimulatorRng,
  keepOps: boolean,
): Promise<{ multiplier: number; ops: Op[]; carry?: CarryState; nextMode?: string }> {
  const open = await Promise.resolve(math.open(carry, ctx));
  let state = open.state;
  let awaiting: AwaitingHint | undefined = open.awaiting;
  let lastOps: Op[] = open.ops;
  const ops: Op[] = keepOps ? [...open.ops] : [];
  let steps = 0;
  while (steps < maxSteps && !(await Promise.resolve(math.isTerminal(state)))) {
    if (!awaiting) break;
    const action = pickAction(awaiting, lastOps, steps, strategy, rng);
    const step = await Promise.resolve(math.step(state, action));
    state = step.state;
    awaiting = step.awaiting;
    lastOps = step.ops;
    if (keepOps) ops.push(...step.ops);
    steps += 1;
  }
  const close = await Promise.resolve(math.close(state));
  if (keepOps) ops.push(...close.ops);
  return {
    multiplier: close.multiplier, ops,
    ...(close.carry !== undefined ? { carry: close.carry } : {}),
    ...(close.nextMode !== undefined ? { nextMode: close.nextMode } : {}),
  };
}
