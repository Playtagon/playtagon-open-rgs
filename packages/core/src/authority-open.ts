import {RGSError, type AuthorityOpenContext, type GameMode, type OpenComplex, type OpenOutcome} from '@open-rgs/contract';
import {deriveIdempotencyKey} from './idempotency.js';
import {assertSafeAmount} from './money.js';

/** Identical terms for live OPEN and checkpoint adoption. No IO or session mutation. */
export function encodeRoundTerms(mode:GameMode, manifestCap:number|undefined, promoFunded:boolean, clientPrice:number, statePersistence?:string):string {
 const cap=mode.maxWinMultiplier??manifestCap;
 // v3 (rounded prices / durable checkpoints) and v2 must stay byte-identical to the
 // pre-merge encodings so rounds opened before the merge keep their terms.
 const head=mode.costRounding||statePersistence?`v3;round=${mode.costRounding??'exact'};state=${statePersistence??'volatile'}`:'v2';
 const authority=mode.resolutionAuthority
  ? `;authority=${encodeURIComponent(mode.resolutionAuthority)};recovery=external-authority;rounding=${mode.moneyRounding??'half-even'}`:'';
 return `${head};stake=${promoFunded?'promo':mode.stakeMultiplier};cap=${cap??'none'}${authority};cp=${clientPrice}`;
}

/** Private host/core helper. Admission supplies a trusted binding and a math-produced
 * opening; this only constructs the exact wallet request. It does not authorize a
 * bet, reserve liability, contact a wallet or mutate a session. Persist the returned
 * request in the same transaction as admission before dispatching it. */
export function authorityOpenRequest(input:{
 mode:GameMode; manifestCap?:number; modeId:string; sessionId:string;
 bet:number; betIndex:number; priceMultiplier:number; clientPrice:number; openKey:string;
 binding:AuthorityOpenContext; opening:OpenOutcome; statePersistence?:string;
}):OpenComplex {
 const {mode,binding,opening}=input;
 if(mode.math.kind!=='complex'||mode.math.authorityVersion!==1||!mode.resolutionAuthority||
    mode.recoveryMode!=='external-authority'||binding.authorityId!==mode.resolutionAuthority||
    !input.openKey||!input.sessionId||!input.modeId||!Number.isSafeInteger(input.betIndex)||input.betIndex<0||
    !Number.isSafeInteger(input.clientPrice)||input.clientPrice<1||input.priceMultiplier!==input.clientPrice*mode.stakeMultiplier||
    typeof opening.state!=='string'||mode.costRounding!==undefined)throw new RGSError('INVALID_ROUND','Invalid authority OPEN preparation');
 assertSafeAmount(input.bet,'bet');assertSafeAmount(input.priceMultiplier,'price');
 assertSafeAmount(input.bet*input.priceMultiplier,'cost');
 return {sessionId:input.sessionId,bet:input.bet,betIndex:input.betIndex,priceMultiplier:input.priceMultiplier,
  modeId:input.modeId,initialState:opening.state,...(mode.math.version?{mathVersion:mode.math.version}:{}),
  idempotencyKey:deriveIdempotencyKey(input.sessionId,'open',input.openKey),
  terms:encodeRoundTerms(mode,input.manifestCap,false,input.clientPrice,input.statePersistence)};
}
