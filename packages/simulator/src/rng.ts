// Tiny deterministic PRNG for the SIMULATOR ONLY, reproducible RTP runs
// and the simulator's own strategy/tie-break choices.
//
// ⚠️  NOT for production. mulberry32 has 32-bit state (period 2^32, a few
// hours of spins at this project's throughput targets, after which the
// stream repeats), is fully determined by its seed, and is trivially
// predictable from a handful of outputs. Routing it into a production
// `loadTsMath({ rng })` would make real-money outcomes predictable.
// Production REQUIRES a certified CSPRNG (see Spec 03 / audit C5). To make
// that hard to get wrong, the returned function is tagged
// `__insecureSimulatorRng` and `loadTsMath` refuses it under
// NODE_ENV=production.

/** A seeded PRNG function, tagged as simulator-only so the math loader can
 *  reject it in production. */
export interface SeededRng {
  (): number;
  /** Marks this as a non-cryptographic simulator PRNG. loadTsMath throws
   *  if it sees this in production (unless allowInsecureRng). */
  readonly __insecureSimulatorRng?: true;
}

/** mulberry32, 32-bit state, period 2^32. Reproducible and fast; fine for
 *  simulation, catastrophic for real-money outcome determination. */
export function mulberry32(seed: number): SeededRng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, { __insecureSimulatorRng: true as const });
}

/** A simulator PRNG whose full state can be checkpointed and restored, so a
 *  long run split into chunks (and across processes) continues the exact same
 *  stream. Callable like {@link SeededRng}, returning a float in [0, 1). */
export interface StatefulSimulatorRng extends SeededRng {
  (): number;
  readonly __insecureSimulatorRng: true;
  /** The next raw 64-bit output. Advances the same stream as calling it. */
  nextUint64(): bigint;
  /** The four uint64 state words as canonical decimal strings. A copy: pass it
   *  back as `xoshiro256ss(seed, state)` to resume from exactly here. */
  snapshot(): readonly string[];
}

const TWO_POW_32 = 0x1_0000_0000;
const TWO_POW_53 = 0x20_0000_0000_0000;
const MAX_UINT64 = (1n << 64n) - 1n;
const UINT64_DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

/** xoshiro256** 1.0 (Blackman & Vigna), 256-bit state, period 2^256-1.
 *  The release-check generator: seeded from ALL 32 bytes of a seed (typically
 *  an HMAC-SHA256), decoded as four little-endian uint64 words s0..s3. Floats
 *  use the top 53 output bits, `(x >>> 11) / 2^53`, so every float is exact.
 *
 *  `state` (from {@link StatefulSimulatorRng.snapshot}) restores a checkpoint
 *  and takes precedence over the seed; the seed must still be 32 bytes.
 *  An all-zero state is rejected: xoshiro can never leave it.
 *
 *  ⚠️  Simulator-only, like mulberry32: fully determined by its seed and
 *  predictable from its outputs. Tagged `__insecureSimulatorRng` so the
 *  runtime loader refuses it in production. The period bounds when the
 *  generator STATE can repeat; it is not a claim that sampled payouts never
 *  repeat. Implemented on 32-bit halves so the hot path never touches BigInt. */
export function xoshiro256ss(seed: Uint8Array, state?: readonly string[]): StatefulSimulatorRng {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error(`xoshiro256ss: seed must be exactly 32 bytes, got ${seed instanceof Uint8Array ? seed.length : typeof seed}`);
  }
  // s[2i] = high 32 bits of word i, s[2i+1] = low 32 bits.
  const s = new Uint32Array(8);
  if (state !== undefined) {
    if (!Array.isArray(state) || state.length !== 4) {
      throw new Error("xoshiro256ss: state must be four uint64 decimal strings");
    }
    state.forEach((w, i) => {
      if (typeof w !== "string" || !UINT64_DECIMAL.test(w) || BigInt(w) > MAX_UINT64) {
        throw new Error(`xoshiro256ss: state word ${i} is not a canonical uint64 decimal string: ${String(w)}`);
      }
      const x = BigInt(w);
      s[2 * i] = Number(x >> 32n);
      s[2 * i + 1] = Number(x & 0xffff_ffffn);
    });
  } else {
    for (let i = 0; i < 4; i++) {
      const o = i * 8;
      s[2 * i + 1] = (seed[o]! | (seed[o + 1]! << 8) | (seed[o + 2]! << 16) | (seed[o + 3]! << 24)) >>> 0;
      s[2 * i] = (seed[o + 4]! | (seed[o + 5]! << 8) | (seed[o + 6]! << 16) | (seed[o + 7]! << 24)) >>> 0;
    }
  }
  if (s.every((w) => w === 0)) {
    throw new Error("xoshiro256ss: all-zero state is invalid (the generator would output zero forever)");
  }

  let outHi = 0;
  let outLo = 0;
  const step = (): void => {
    const s0h = s[0]!, s0l = s[1]!, s1h = s[2]!, s1l = s[3]!;
    const s2h = s[4]!, s2l = s[5]!, s3h = s[6]!, s3l = s[7]!;
    // result = rotl(s1 * 5, 7) * 9 (mod 2^64). Products of a uint32 by 5 or 9
    // stay below 2^36, exact in a double; `>>> 0` reduces mod 2^32.
    let p = s1l * 5;
    const m5l = p >>> 0;
    const m5h = (s1h * 5 + Math.floor(p / TWO_POW_32)) >>> 0;
    const rh = ((m5h << 7) | (m5l >>> 25)) >>> 0;
    const rl = ((m5l << 7) | (m5h >>> 25)) >>> 0;
    p = rl * 9;
    outLo = p >>> 0;
    outHi = (rh * 9 + Math.floor(p / TWO_POW_32)) >>> 0;
    // t = s1 << 17
    const th = ((s1h << 17) | (s1l >>> 15)) >>> 0;
    const tl = (s1l << 17) >>> 0;
    // s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3, 45)
    const n2h = s2h ^ s0h, n2l = s2l ^ s0l;
    const n3h = s3h ^ s1h, n3l = s3l ^ s1l;
    s[2] = s1h ^ n2h; s[3] = s1l ^ n2l;
    s[0] = s0h ^ n3h; s[1] = s0l ^ n3l;
    s[4] = n2h ^ th; s[5] = n2l ^ tl;
    // rotl 45 = swap halves (rotl 32), then rotl 13
    s[6] = (n3l << 13) | (n3h >>> 19);
    s[7] = (n3h << 13) | (n3l >>> 19);
  };

  const next = (): number => {
    step();
    return (outHi * 0x20_0000 + (outLo >>> 11)) / TWO_POW_53;
  };
  return Object.assign(next, {
    __insecureSimulatorRng: true as const,
    nextUint64(): bigint {
      step();
      return (BigInt(outHi) << 32n) | BigInt(outLo);
    },
    snapshot(): readonly string[] {
      return [0, 1, 2, 3].map((i) => ((BigInt(s[2 * i]!) << 32n) | BigInt(s[2 * i + 1]!)).toString());
    },
  });
}
