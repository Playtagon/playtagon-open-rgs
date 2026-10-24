import { afterEach, describe, expect, test } from 'bun:test';
import { defineGame, type ComplexMath, type ConnectionMeta, type OpenComplex, type UpdateComplex, type CloseComplex, type WalletOpenRound } from '@open-rgs/contract';
import { MockPlatform } from '@open-rgs/platform-mock';
import { createOrchestrator } from '../src/orchestrator.ts';
import { remove as forgetSession } from '../src/session.ts';
class Wallet extends MockPlatform {
  readonly durableRoundState = true;
  pending: WalletOpenRound | undefined;
  fail: 'before' | 'after' | null = null;
  barrier: Promise<void> | null = null;
  override async openComplex(req: OpenComplex) {
    const receipt = await super.openComplex(req);
    this.pending = { roundId: receipt.roundId, modeId: req.modeId!, bet: req.bet, state: req.initialState, mathVersion: req.mathVersion, terms: req.terms, ops: [], actionLog: [] };
    return receipt;
  }
  override async openSession(sid: string, connectionId: string) { return { ...await super.openSession(sid, connectionId), ...(this.pending ? { openRound: this.pending } : {}) }; }
  override async updateComplex(req: UpdateComplex) {
    if (this.barrier) await this.barrier;
    if (this.fail === 'before') throw new Error('database unavailable');
    if (req.previousState !== undefined && this.pending?.state !== req.previousState) throw new Error('checkpoint conflict');
    this.pending!.state = req.state;
    if (this.fail === 'after') throw new Error('response lost after commit');
  }
  override async closeComplex(req: CloseComplex) {
    if (req.expectedState !== undefined && this.pending?.state !== req.expectedState) throw new Error('stale settlement');
    const result = await super.closeComplex(req); this.pending = undefined; return result;
  }
}
const sids: string[] = [];
function setup(wallet = new Wallet({ startingBalance: 1000, allowedBets: [100], defaultBetIndex: 0 }), checkpointed = true) {
  let draws = 0;
  const view = (raw: string) => { const s = JSON.parse(raw); return { ops: [{ opened: s.opened }], ...(!s.done ? { awaiting: { type: 'pick' } } : {}) }; };
  const math: ComplexMath = {
    kind: 'complex', name: 'picks', version: '1', rtp: 0.99,
    open() { return { state: JSON.stringify({ opened: [], secret: [0], done: false }), ops: [{ opened: [] }], awaiting: { type: 'pick' } }; },
    step(raw, action) { const s = JSON.parse(raw); if (s.opened.includes(action.cell)) throw new Error('duplicate cell'); draws++; s.opened.push(action.cell); s.done = !!action.end; const state = JSON.stringify(s); return { state, ...view(state) }; },
    isTerminal(raw) { return JSON.parse(raw).done; }, close() { return { multiplier: 2, ops: [], type: 'win' }; }, resume: view,
  };
  const manifest = defineGame({ id: 'checkpointed', declaredRtp: 0.99, defaultMode: 'normal', ...(checkpointed ? { statePersistence: 'checkpointed' as const } : {}), modes: { normal: { math, stakeMultiplier: 1 } } });
  return { wallet, manifest, orch: createOrchestrator({ platform: wallet, manifest }), get draws() { return draws; } };
}
async function init(rt: ReturnType<typeof setup>) {
  const sid = `checkpointed-${crypto.randomUUID()}`; sids.push(sid); await rt.wallet.connect();
  const conn: ConnectionMeta = { connectionId: crypto.randomUUID(), sessionId: null, demo: true };
  await rt.orch.init({ sid }, conn); await rt.orch.openRound({}, conn); return { sid, conn };
}
afterEach(() => { for (const sid of sids.splice(0)) forgetSession(sid); });
describe('native interactive durable checkpoints', () => {
  test('does not acknowledge a step until the wallet checkpoint commits', async () => {
    const rt = setup(), { conn } = await init(rt);
    let release!: () => void, settled = false;
    rt.wallet.barrier = new Promise(r => { release = r; });
    const step = rt.orch.stepRound({ action: { type: 'pick', cell: 1 } }, conn).then(r => { settled = true; return r; });
    await Bun.sleep(1); expect(settled).toBe(false); expect(JSON.parse(rt.wallet.pending!.state!).opened).toEqual([]);
    release(); await step; expect(JSON.parse(rt.wallet.pending!.state!).opened).toEqual([1]);
  });
  test.each(['before', 'after'] as const)('checkpoint failure %s commit blocks actions; init re-reads the authoritative wallet', async fail => {
    const rt = setup(), { sid, conn } = await init(rt); rt.wallet.fail = fail;
    await expect(rt.orch.stepRound({ action: { type: 'pick', cell: 1 } }, conn)).rejects.toThrow();
    await expect(rt.orch.stepRound({ action: { type: 'pick', cell: 2 } }, conn)).rejects.toThrow(/Checkpoint/);
    await expect(rt.orch.closeRound({}, conn)).rejects.toThrow(/Checkpoint/);
    expect((await rt.orch.autocloseRound({ sessionId: sid, reason: 'test' })).closed).toBe(false);
    rt.wallet.fail = null;
    const recovered = await rt.orch.init({ sid }, conn);
    expect(recovered.resume!.ops).toEqual([{ opened: fail === 'after' ? [1] : [] }]);
    expect(JSON.stringify(recovered.resume)).not.toContain('secret');
    expect(rt.draws).toBe(1);
  });
  test('cold process resumes an active board from the latest checkpoint and settles once', async () => {
    const rt = setup(), { sid, conn } = await init(rt);
    await rt.orch.stepRound({ action: { type: 'pick', cell: 1 } }, conn); forgetSession(sid);
    const next = setup(rt.wallet), res = await next.orch.init({ sid }, conn);
    expect(res.resume!.awaiting!.type).toBe('pick'); expect(res.resume!.ops).toEqual([{ opened: [1] }]); expect(res.balance).toBe(900);
    await expect(next.orch.stepRound({ action: { type: 'pick', cell: 1 } }, conn)).rejects.toThrow(/duplicate/);
    await next.orch.stepRound({ action: { type: 'pick', cell: 2, end: true } }, conn);
    expect((await next.orch.closeRound({ idempotencyKey: 'close' }, conn)).balance).toBe(1100);
    expect((await next.orch.closeRound({ idempotencyKey: 'close' }, conn)).balance).toBe(1100);
  });
  test('compare-and-swap refuses delayed writes and stale settlement', async () => {
    const rt = setup(), { sid, conn } = await init(rt); const initial = rt.wallet.pending!.state!;
    await rt.orch.stepRound({ action: { type: 'pick', cell: 1 } }, conn);
    await expect(rt.wallet.updateComplex({ sessionId: sid, roundId: rt.wallet.pending!.roundId, previousState: initial, state: initial })).rejects.toThrow(/conflict/);
    expect(JSON.parse(rt.wallet.pending!.state!).opened).toEqual([1]);
  });
  test('legacy terms are never treated as acknowledged native checkpoints', async () => {
    const rt = setup(), { sid, conn } = await init(rt);
    rt.wallet.pending!.terms = 'v2;stake=1;cap=none;cp=1'; forgetSession(sid);
    await expect(setup(rt.wallet).orch.init({ sid }, conn)).rejects.toThrow(/Cannot safely resume/);
    expect(rt.wallet.pending).toBeDefined();
  });
});
