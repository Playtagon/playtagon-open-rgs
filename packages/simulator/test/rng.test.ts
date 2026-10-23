// xoshiro256** is the release-check generator: 256 bits of state seeded from
// all 32 bytes of an HMAC. The vectors below come from an independent Python
// big-int reference (see the fixture's `source`), not from this implementation.

import { describe, expect, test } from "bun:test";
import { xoshiro256ss, mulberry32 } from "../src/index.js";
import fixture from "./fixtures/xoshiro256-starstar.json";

/** The raw state as a 32-byte seed: four little-endian uint64 words. */
function seedFromState(state: readonly string[]): Uint8Array {
  const out = new Uint8Array(32);
  state.forEach((w, i) => {
    let x = BigInt(w);
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(x & 0xffn); x >>= 8n; }
  });
  return out;
}

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

describe("xoshiro256ss reference vectors", () => {
  test("state [1,2,3,4] produces 11520, 0, 1509978240", () => {
    const rng = xoshiro256ss(new Uint8Array(32), ["1", "2", "3", "4"]);
    expect([rng.nextUint64(), rng.nextUint64(), rng.nextUint64()]).toEqual([11520n, 0n, 1509978240n]);
  });

  for (const v of fixture.stateVectors) {
    test(`state vector: ${v.name}`, () => {
      const rng = xoshiro256ss(new Uint8Array(32), v.state);
      expect(v.uint64.map(() => rng.nextUint64().toString())).toEqual(v.uint64);
      expect(rng.snapshot()).toEqual(v.stateAfter);
      // the same state through the seed path decodes identically
      const viaSeed = xoshiro256ss(seedFromState(v.state));
      expect(viaSeed.snapshot()).toEqual(v.state);
    });

    test(`floats are the top 53 output bits: ${v.name}`, () => {
      const rng = xoshiro256ss(new Uint8Array(32), v.state);
      expect(v.floats.map(() => rng())).toEqual(v.floats);
    });
  }

  for (const v of fixture.seedVectors) {
    test(`all 32 seed bytes decode little-endian: ${v.name}`, () => {
      const rng = xoshiro256ss(hex(v.seedHex));
      expect(rng.snapshot()).toEqual(v.state);
      expect(v.uint64.map(() => rng.nextUint64().toString())).toEqual(v.uint64);
    });
  }

  test("changing any single seed byte changes the state", () => {
    const base = xoshiro256ss(hex(fixture.seedVectors[0]!.seedHex)).snapshot();
    for (let i = 0; i < 32; i++) {
      const s = hex(fixture.seedVectors[0]!.seedHex);
      s[i] = s[i]! ^ 0x80;
      expect(xoshiro256ss(s).snapshot()).not.toEqual(base);
    }
  });
});

describe("xoshiro256ss save / restore", () => {
  test("a snapshot resumes the exact stream", () => {
    const { seedHex, skip, snapshot, next } = fixture.saveRestore;
    const rng = xoshiro256ss(hex(seedHex));
    for (let i = 0; i < skip; i++) rng.nextUint64();
    expect(rng.snapshot()).toEqual(snapshot);
    const resumed = xoshiro256ss(hex(seedHex), rng.snapshot());
    expect(next.map(() => resumed.nextUint64().toString())).toEqual(next);
    expect(next.map(() => rng.nextUint64().toString())).toEqual(next);
  });

  test("floats and integers advance the same stream", () => {
    const a = xoshiro256ss(hex(fixture.seedVectors[2]!.seedHex));
    const b = xoshiro256ss(hex(fixture.seedVectors[2]!.seedHex));
    a(); a(); a();
    b.nextUint64(); b(); b.nextUint64();
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  test("a snapshot is a copy, not a live view", () => {
    const rng = xoshiro256ss(hex(fixture.seedVectors[0]!.seedHex));
    const before = rng.snapshot();
    rng();
    expect(rng.snapshot()).not.toEqual(before);
    expect(before).toEqual(fixture.seedVectors[0]!.state);
  });

  test("two generators from the same seed match", () => {
    const a = xoshiro256ss(hex(fixture.seedVectors[3]!.seedHex));
    const b = xoshiro256ss(hex(fixture.seedVectors[3]!.seedHex));
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
  });
});

describe("xoshiro256ss rejects unusable input", () => {
  test("an all-zero seed is rejected (the one state the generator cannot leave)", () => {
    expect(() => xoshiro256ss(hex(fixture.zero.seedHex))).toThrow(/zero/);
  });
  test("an all-zero restored state is rejected", () => {
    expect(() => xoshiro256ss(hex(fixture.seedVectors[0]!.seedHex), fixture.zero.state)).toThrow(/zero/);
  });
  test("a seed that is not exactly 32 bytes is rejected", () => {
    expect(() => xoshiro256ss(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(() => xoshiro256ss(new Uint8Array(33))).toThrow(/32 bytes/);
  });
  test("malformed restored words are rejected", () => {
    const seed = hex(fixture.seedVectors[0]!.seedHex);
    expect(() => xoshiro256ss(seed, ["1", "2", "3"])).toThrow();
    expect(() => xoshiro256ss(seed, ["1", "2", "3", "-4"])).toThrow();
    expect(() => xoshiro256ss(seed, ["1", "2", "3", "0x4"])).toThrow();
    expect(() => xoshiro256ss(seed, ["1", "2", "3", "01"])).toThrow();
    expect(() => xoshiro256ss(seed, ["1", "2", "3", "18446744073709551616"])).toThrow();
    expect(xoshiro256ss(seed, ["1", "2", "3", "18446744073709551615"]).snapshot()[3]).toBe("18446744073709551615");
  });
});

describe("xoshiro256ss safety and stream properties", () => {
  test("it is tagged as a simulator-only PRNG, like mulberry32", () => {
    const rng = xoshiro256ss(hex(fixture.seedVectors[0]!.seedHex));
    expect(rng.__insecureSimulatorRng).toBe(true);
    expect(mulberry32(1).__insecureSimulatorRng).toBe(true);
  });

  test("floats stay in [0, 1)", () => {
    const rng = xoshiro256ss(hex(fixture.seedVectors[1]!.seedHex));
    for (let i = 0; i < 100_000; i++) {
      const x = rng();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  test("the state does not return to its start over a long stream", () => {
    // The mathematical period is 2^256-1 (every non-zero state lies on one
    // cycle). That bounds when the STATE can repeat; it is not a claim that
    // individual sampled payouts never repeat. Here we only show a
    // representative stream does not cycle back to its starting state.
    expect(fixture.periodBound).toBe("2^256-1");
    const rng = xoshiro256ss(hex(fixture.seedVectors[2]!.seedHex));
    const start = rng.snapshot().join(",");
    for (let i = 0; i < 2_000_000; i++) {
      rng();
      if ((i & 0xffff) === 0) expect(rng.snapshot().join(",")).not.toBe(start);
    }
    expect(rng.snapshot().join(",")).not.toBe(start);
  });

  test("the legacy mulberry32 stream is unchanged", () => {
    const r = mulberry32(42);
    expect([r(), r(), r()]).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  });
});
