import { afterEach, describe, expect, test } from 'bun:test';
import { defineGame, roundedStakeCost, type ComplexMath, type ConnectionMeta, type OpenComplex, type UpdateComplex, type CloseComplex, type WalletOpenRound } from '@open-rgs/contract';
import { MockPlatform } from '@open-rgs/platform-mock';
import { createOrchestrator } from '../src/orchestrator.ts';
import { remove as forgetSession } from '../src/session.ts';

const PRICE = 14.935064935064934;
const sids: string[] = [];
class Wallet extends MockPlatform {
  pending: WalletOpenRound | undefined;
  opens = 0;
  closes = 0;
  override async openComplex(req: OpenComplex) {
    const result = await super.openComplex(req);
    this.opens++;
    this.pending = { roundId: result.roundId, bet: req.bet, modeId: req.modeId!, state: req.initialState,
      mathVersion: req.mathVersion, terms: req.terms, ops: [], actionLog: [] };
    return result;
  }
  override async updateComplex(req: UpdateComplex) { if (this.pending) this.pending.state = req.state; }
  override async openSession(sid: string, connectionId: string) {
    return { ...await super.openSession(sid, connectionId), ...(this.pending ? { openRound: this.pending } : {}) };
  }
  override async closeComplex(req: CloseComplex) {
    const result = await super.closeComplex(req);
    this.pending = undefined; this.closes++;
    return result;
  }
}
function setup(balance = 10_000, cap = 100, rounding = true, wallet = new Wallet({ startingBalance: balance, currency: 'FUN', allowedBets: [100], defaultBetIndex: 0 })) {
  let opens = 0;
  const math: ComplexMath = {
    kind: 'complex', name: 'rounded-test', version: '1', rtp: 0.99,
    open(_prev, ctx) { opens++; return { state: JSON.stringify({ denominator: ctx.settlementPriceMultiplier ?? ctx.priceMultiplier }), ops: [], awaiting: { type: 'endRound' } }; },
    step(state) { return { state, ops: [] }; }, isTerminal() { return true; },
    close(state) { return { multiplier: 20 / JSON.parse(state).denominator, ops: [], type: 'win' }; },
    resume() { return { ops: [], awaiting: { type: 'endRound' } }; },
  };
  const manifest = defineGame({ id: 'rounded', declaredRtp: 0.99, defaultMode: 'buy', maxWinMultiplier: cap,
    modes: { buy: { math, stakeMultiplier: PRICE, ...(rounding ? { costRounding: 'half-up' as const } : {}) } } });
  return { wallet, manifest, orch: createOrchestrator({ platform: wallet, manifest }), get draws() { return opens; } };
}
async function init(rt: ReturnType<typeof setup>) {
  const sid = `rounded-${crypto.randomUUID()}`; sids.push(sid);
  await rt.wallet.connect();
  const conn: ConnectionMeta = { connectionId: crypto.randomUUID(), sessionId: null, demo: false };
  await rt.orch.init({ sid }, conn);
  return { sid, conn };
}
afterEach(() => { for (const sid of sids.splice(0)) forgetSession(sid); });

describe('explicit rounded mode cost', () => {
  test('helper refuses free/unsafe costs and uses half-up only at the debit boundary', () => {
    expect(roundedStakeCost(100, PRICE)).toBe(1494);
    expect(roundedStakeCost(1, 1.5)).toBe(2);
    expect(roundedStakeCost(100, 1.005)).toBe(101);
    expect(roundedStakeCost(100_000_000, 1e-7)).toBe(10);
    for (const [bet, price] of [[0, 2], [1, 0.1], [NaN, 2], [1, Infinity], [Number.MAX_SAFE_INTEGER, 2]]) expect(() => roundedStakeCost(bet!, price!)).toThrow();
  });
  test('wallet support is mandatory and cannot be enabled by client params', async () => {
    const rt = setup();
    Object.defineProperty(rt.wallet, 'supportedCostRounding', { value: undefined });
    expect(() => createOrchestrator({ platform: rt.wallet, manifest: rt.manifest })).toThrow(/requires wallet/);
    const plain = setup(10_000, 100, false), { conn } = await init(plain);
    const result = await plain.orch.openRound({ mode: 'buy', params: { costRounding: 'half-up' } }, conn);
    expect(result.balance).toBe(10_000 - 100 * PRICE);
    expect(result.cost).toBeUndefined();
  });
  test('debit, balance check, normalization, repeated OPEN/CLOSE and resume share the actual cost', async () => {
    const rt = setup(1494), { sid, conn } = await init(rt);
    const req = { mode: 'buy', idempotencyKey: 'open' };
    const opened = await rt.orch.openRound(req, conn);
    expect(opened.cost).toBe(1494); expect(opened.priceMultiplier).toBe(PRICE); expect(opened.balance).toBe(0);
    expect((await rt.orch.openRound(req, conn)).roundId).toBe(opened.roundId);
    expect(rt.wallet.opens).toBe(1);
    expect((await rt.orch.init({ sid }, conn)).resume?.cost).toBe(1494);
    const closed = await rt.orch.closeRound({ idempotencyKey: 'close' }, conn);
    expect(closed.win).toBe(2000); expect(closed.balance).toBe(2000);
    expect((await rt.orch.closeRound({ idempotencyKey: 'close' }, conn)).balance).toBe(2000);
    expect(rt.wallet.closes).toBe(1);
  });
  test('insufficient rounded cost is refused before math or wallet', async () => {
    const rt = setup(1493), { conn } = await init(rt);
    await expect(rt.orch.openRound({ mode: 'buy' }, conn)).rejects.toThrow(/cost 1494/);
    expect(rt.wallet.opens).toBe(0); expect(rt.draws).toBe(0);
  });
  test('max-win cap applies to the integer paid cost', async () => {
    const rt = setup(10_000, 1), { conn } = await init(rt);
    await rt.orch.openRound({ mode: 'buy' }, conn);
    expect((await rt.orch.closeRound({}, conn)).win).toBe(1494);
  });
  test('cold adoption keeps the rounding terms and stored normalization', async () => {
    const rt = setup(), { sid, conn } = await init(rt);
    const first = await rt.orch.openRound({ mode: 'buy' }, conn);
    expect(rt.wallet.pending!.terms).toContain('v3;round=half-up');
    forgetSession(sid);
    const next = setup(10_000, 100, true, rt.wallet);
    const recovered = await next.orch.init({ sid }, { ...conn, connectionId: crypto.randomUUID() });
    expect(recovered.resume?.roundId).toBe(first.roundId);
    expect(recovered.resume?.cost).toBe(1494);
    expect((await next.orch.closeRound({}, conn)).win).toBe(2000);
    expect(next.draws).toBe(0);
  });
  test('a different rounding policy cannot silently adopt an old round', async () => {
    const rt = setup(), { sid, conn } = await init(rt);
    await rt.orch.openRound({ mode: 'buy' }, conn); forgetSession(sid);
    const next = setup(10_000, 100, false, rt.wallet);
    expect((await next.orch.init({ sid }, { ...conn, connectionId: crypto.randomUUID() })).resume).toBeUndefined();
    expect(rt.wallet.pending).toBeDefined();
    expect(rt.wallet.closes).toBe(0);
  });
});
