import { afterEach, describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/orchestrator.js";
import { createAuditLog, memoryAuditSink } from "../src/audit-log.js";
import * as sessions from "../src/session.js";
import { defineGame, type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type ComplexMath, type ConnectionMeta, type PlatformEvent,
  type WalletOpenRound, type WalletSettledRound, type RoundAuthority, type OrchestratorAuthorityAPI,
  type AuthorityOpenContext, type AuthorityResolutionContext } from "@open-rgs/contract";
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
  /** The next closeComplex commits, then its response is lost. */
  loseNextCloseResponse = false;
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
    if (this.loseNextCloseResponse) { this.loseNextCloseResponse = false; throw new Error("socket hang up"); }
    return { roundId: req.roundId, balance: this.balance };
  }
  async findSettledClose(sessionId: string, requestKey: string): Promise<WalletSettledRound | undefined> {
    const roundId = this.requestRounds.get(`${sessionId}|${requestKey}`);
    return roundId ? this.settled.get(roundId) : undefined;
  }
  handler: ((e: PlatformEvent) => void) | undefined;
  onEvent(h: (e: PlatformEvent) => void) { this.handler = h; }
}


let seq = 0;
const ids: string[] = [];
afterEach(() => { for (const id of ids.splice(0)) sessions.remove(id); });
function setup(wallet = new DurableWallet(), sid = `authority-${++seq}`, floor = false) {
  ids.push(sid);
  const binding: AuthorityOpenContext = {
    authorityId: 'room', bindingId: 'binding', bindingHash: 'hash', roomId: 'room-1', roomRoundId: 'round-1',
    slot: 0, rulesVersion: 'rules-1', curveHash: 'curve-1', serverSeedCommit: 'commit', epochSaltRef: 'salt-ref',
    drawCommit: 'draw-commit', forcedCap100: '100000',
  };
  const decision: AuthorityResolutionContext = {
    authorityId: 'room', bindingHash: 'hash', decisionId: 'decision', decisionHash: 'decision-hash',
    roomRoundId: 'round-1', kind: 'auto_cashout', effectiveElapsedUs: '1000', target100: '200',
    draw52: 'secret-draw', rulesVersion: 'rules-1', curveHash: 'curve-1',
  };
  let payoutE8 = '200000000';
  let ready = false;
  let restore = true;
  const resolver: RoundAuthority = {
    async resolveOpen(input) {
      if (input.internalSid !== sid || input.bindingId !== binding.bindingId) throw new Error('binding mismatch');
      return binding;
    },
    async resolveDecision(input) {
      if (input.internalSid !== sid || (input.decisionId && input.decisionId !== decision.decisionId)) throw new Error('decision mismatch');
      const state = JSON.parse(input.state);
      if (state.bindingHash !== decision.bindingHash) throw new Error('state mismatch');
      return ready ? decision : null;
    },
    async authorizeRestore() { return restore; },
  };
  const math: ComplexMath = {
    kind: 'complex', authorityVersion: 1, name: 'authority-fixture', version: '1', rtp: 0.99,
    open(_, ctx) {
      if (!ctx.authority) throw new Error('missing trusted context');
      return { state: JSON.stringify({ bindingHash: ctx.authority.bindingHash }), ops: [], awaiting: { type: 'room' } };
    },
    step() { throw new Error('no client steps'); },
    isTerminal(state, d) { return !!d && JSON.parse(state).bindingHash === d.bindingHash; },
    close(state, d) {
      if (!d || JSON.parse(state).bindingHash !== d.bindingHash) throw new Error('not ready');
      return { multiplier: Number(payoutE8) / 100_000_000, multiplierE8: payoutE8, type: d.kind, ops: [], finalState: JSON.stringify({ bindingHash: d.bindingHash, decisionId: d.decisionId }) };
    },
    autoclose(state, d) { return this.close(state, d); },
    resume() { return { ops: [], awaiting: { type: 'room' } }; },
  };
  const manifest = defineGame({ id: 'crash-fixture', declaredRtp: 0.99, defaultMode: 'crash',
    maxWinMultiplier: 1000, autoclose: { idleMs: 1000, policy: 'math-decides' },
    modes: { crash: { math, stakeMultiplier: 1, ...(floor ? { moneyRounding: 'floor-e8' as const } : {}), resolutionAuthority: 'room', recoveryMode: 'external-authority' } } });
  let api!: OrchestratorAuthorityAPI;
  const sink = memoryAuditSink();
  const orch = createOrchestrator({ manifest, auditLog: createAuditLog(sink), platform: wallet, roundAuthority: resolver, onAuthorityAPI: a => { api = a; } });
  const conn: ConnectionMeta = { connectionId: sid, sessionId: null, demo: false };
  const open = () => api.openBoundRound({ internalSid: sid, modeId: 'crash', ladderIndex: 0, bindingId: 'binding', openKey: 'open-1' });
  const close = (roundId: string) => api.closeDecidedRound({ internalSid: sid, rgsRoundId: roundId, decisionId: 'decision' });
  return { sid, wallet, api, orch, conn, manifest, resolver, open, close, decision, sink,
    payout: (value: string) => { payoutE8 = value; }, ready: () => { ready = true; }, denyRestore: () => { restore = false; } };
}

describe('private external-authority rounds', () => {
  test('startup rejects authority without a resolver', () => {
    const x = setup();
    expect(() => createOrchestrator({ manifest: x.manifest, platform: x.wallet })).toThrow();
  });
  test('public open cannot spoof authority, and private API is not on the public API object', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn);
    expect('openBoundRound' in x.orch).toBe(false);
    await expect(x.orch.openRound({ mode: 'crash', params: { authority: { bindingId: 'binding' } } }, x.conn)).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    expect(x.wallet.balance).toBe(100000);
  });
  test('private open replays once and rejects a changed body with the same key', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn);
    const a = await x.open(); expect(await x.open()).toEqual(a);
    expect(x.wallet.balance).toBe(99900);
    await expect(x.api.openBoundRound({ internalSid: x.sid, modeId: 'crash', ladderIndex: 0, bindingId: 'other', openKey: 'open-1' })).rejects.toMatchObject({ code: 'INVALID_FORMAT' });
  });
  test('client step/close are forbidden; admin autoclose waits for a real decision', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open();
    await expect(x.orch.stepRound({ action: { type: 'room' } }, x.conn)).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(x.orch.closeRound({}, x.conn)).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(x.close(a.roundId)).rejects.toMatchObject({ code: 'AUTHORITY_NOT_READY' });
    expect((await x.orch.autocloseRound({ sessionId: x.sid, roundId: a.roundId, reason: 'idle' })).closed).toBe(false);
    expect(x.wallet.credits).toEqual([]);
    expect(sessions.get(x.sid)?.openRound?.roundId).toBe(a.roundId);
    x.ready();
    expect((await x.orch.autocloseRound({ sessionId: x.sid, roundId: a.roundId, reason: 'retry' })).closed).toBe(true);
    expect((await x.close(a.roundId)).win).toBe(200);
    expect(x.wallet.credits).toEqual([200]);
  });
  test('receipt stores finalState, never the private decision/draw; retry after restart pays once', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open(); x.ready();
    x.wallet.loseNextCloseResponse = true;
    await expect(x.close(a.roundId)).rejects.toThrow();
    const recorded = x.wallet.settled.get(a.roundId)!;
    expect(JSON.parse(recorded.finalState!)).toEqual({ bindingHash: 'hash', decisionId: 'decision' });
    expect(JSON.stringify(recorded)).not.toContain('secret-draw');
    sessions.remove(x.sid);
    const y = setup(x.wallet, x.sid); y.ready(); await y.orch.init({ sid: y.sid }, y.conn);
    expect((await y.close(a.roundId)).win).toBe(200);
    expect(x.wallet.credits).toEqual([200]);
  });
  test('live authority binding restores without pretending the outcome was fixed at open', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open();
    sessions.remove(x.sid);
    const y = setup(x.wallet, x.sid);
    await y.api.restoreBoundRound({ internalSid: y.sid, rgsRoundId: a.roundId });
    expect(sessions.get(y.sid)?.openRound?.awaiting?.type).toBe('room');
    y.ready(); expect((await y.close(a.roundId)).win).toBe(200);
  });
  test('unapproved restore fails closed and leaves the wallet round untouched', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open();
    sessions.remove(x.sid);
    const y = setup(x.wallet, x.sid); y.denyRestore();
    await expect(y.api.restoreBoundRound({ internalSid: y.sid, rgsRoundId: a.roundId })).rejects.toMatchObject({ code: 'AUTHORITY_NOT_READY' });
    expect(sessions.get(y.sid)).toBeUndefined();
    expect(x.wallet.open.get(y.sid)?.roundId).toBe(a.roundId);
  });
  test('a stale round id or different decision cannot settle the current bet', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn); await x.open(); x.ready();
    await expect(x.close('stale')).rejects.toMatchObject({ code: 'INVALID_ROUND' });
    await expect(x.api.closeDecidedRound({ internalSid: x.sid, rgsRoundId: 'round-1', decisionId: 'other' })).rejects.toThrow();
    expect(x.wallet.credits).toEqual([]);
  });
});


describe('authority integration boundaries', () => {
  test('an old settled retry cannot clear a newer open bet', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn); const old = await x.open(); x.ready();
    await x.close(old.roundId);
    const newer = await x.api.openBoundRound({ internalSid: x.sid, modeId: 'crash', ladderIndex: 0, bindingId: 'binding', openKey: 'open-2' });
    expect((await x.close(old.roundId)).win).toBe(200);
    expect(sessions.get(x.sid)?.openRound?.roundId).toBe(newer.roundId);
    expect(x.wallet.credits).toEqual([200]);
  });
  test('client cannot recover a private settlement using its request token', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open(); x.ready(); await x.close(a.roundId);
    await expect(x.orch.closeRound({ idempotencyKey: `authority-close:${a.roundId}` }, x.conn)).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    expect(x.wallet.credits).toEqual([200]);
  });
  test('resolver must return the requested binding, before any wallet debit', async () => {
    const x = setup(); x.resolver.resolveOpen = async () => ({ authorityId: 'other', bindingId: 'binding' } as AuthorityOpenContext);
    await x.orch.init({ sid: x.sid }, x.conn);
    await expect(x.open()).rejects.toMatchObject({ code: 'INVALID_ROUND' });
    expect(x.wallet.balance).toBe(100000);
  });
  test('restore refuses changed commercial terms even with an approved binding', async () => {
    const x = setup(); await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open();
    x.wallet.open.get(x.sid)!.terms = 'v2;stake=1;cap=1000;cp=1'; // missing authority pin
    sessions.remove(x.sid); const y = setup(x.wallet, x.sid);
    await expect(y.api.restoreBoundRound({ internalSid: y.sid, rgsRoundId: a.roundId })).rejects.toMatchObject({ code: 'AUTHORITY_NOT_READY' });
    expect(x.wallet.credits).toEqual([]);
  });
  test('the cap preserves the public-safe decision checkpoint', async () => {
    const { applyMaxWinCapClose } = await import('../src/orchestrator.js');
    const outcome = applyMaxWinCapClose({ multiplier: 2000, type: 'win', ops: [], finalState: 'safe-state' }, 100, 1000);
    expect(outcome.multiplier).toBe(1000);
    expect(outcome.finalState).toBe('safe-state');
  });
  test('ordinary complex math cannot be silently used as authority-capable math', () => {
    const x = setup();
    const math = { ...x.manifest.modes.crash!.math, authorityVersion: undefined };
    const manifest = { ...x.manifest, modes: { crash: { ...x.manifest.modes.crash!, math } } };
    expect(() => createOrchestrator({ manifest, platform: x.wallet, roundAuthority: x.resolver })).toThrow();
  });
});


test('floor-e8 settlement flows through wallet CLOSE, cap and replay without floats', async () => {
  const x = setup(undefined, undefined, true); x.payout('101500000');
  await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open(); x.ready();
  expect((await x.close(a.roundId)).win).toBe(101); // legacy half-even would pay 102
  expect((await x.close(a.roundId)).win).toBe(101);
  expect(x.wallet.credits).toEqual([101]);
  x.payout('200000000000');
  const b = await x.api.openBoundRound({ internalSid: x.sid, modeId: 'crash', ladderIndex: 0, bindingId: 'binding', openKey: 'open-cap' });
  expect((await x.close(b.roundId)).win).toBe(100000);
  expect(JSON.parse(x.wallet.settled.get(b.roundId)!.finalState!).decisionId).toBe('decision');
});
test('floor-e8 terms cannot be adopted by a half-even runtime', async () => {
  const x = setup(undefined, undefined, true); await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open();
  sessions.remove(x.sid); const y = setup(x.wallet, x.sid, false);
  await expect(y.api.restoreBoundRound({ internalSid: y.sid, rgsRoundId: a.roundId })).rejects.toMatchObject({ code: 'AUTHORITY_NOT_READY' });
  expect(x.wallet.credits).toEqual([]);
});
test('bad E8 outcome never credits the wallet', async () => {
  const x = setup(undefined, undefined, true); await x.orch.init({ sid: x.sid }, x.conn); const a = await x.open(); x.ready();
  x.payout('01');
  await expect(x.close(a.roundId)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  expect(x.wallet.credits).toEqual([]);
  expect(sessions.get(x.sid)?.openRound?.roundId).toBe(a.roundId);
});

test('authority OPEN receipt cannot overwrite a newer wallet balance event', async () => {
  const x = setup();
  const original = x.wallet.openComplex.bind(x.wallet);
  x.wallet.openComplex = async req => {
    const receipt = await original(req);
    x.wallet.balance += 1000;
    x.wallet.handler?.({ type: 'balanceChanged', sessionId: x.sid, balance: x.wallet.balance, reason: 'deposit', seq: 1 });
    return receipt; // old post-debit balance, delayed behind the deposit event
  };
  await x.orch.init({ sid: x.sid }, x.conn);
  await x.open();
  expect(sessions.get(x.sid)?.balance).toBe(100900);
});

 test('lost authority OPEN response is unknown, and checkpoint restore does not debit again', async () => {
  const x = setup();
  const original = x.wallet.openComplex.bind(x.wallet);
  x.wallet.openComplex = async req => { await original(req); throw new Error('lost response after commit'); };
  await x.orch.init({ sid: x.sid }, x.conn);
  await expect(x.open()).rejects.toMatchObject({ code: 'OPEN_FAILED' });
  expect(x.wallet.balance).toBe(99900);
  expect(x.sink.events.at(-1)?.outcomeStatus).toBe('open-unknown');
  const roundId = x.wallet.open.get(x.sid)!.roundId;
  sessions.remove(x.sid);
  await x.api.restoreBoundRound({ internalSid: x.sid, rgsRoundId: roundId });
  expect(sessions.get(x.sid)?.openRound?.roundId).toBe(roundId);
  expect(sessions.get(x.sid)?.balance).toBe(99900);
  expect(x.wallet.balance).toBe(99900);
 });
