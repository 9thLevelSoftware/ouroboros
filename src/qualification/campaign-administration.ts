import {createHash} from 'node:crypto';
import {z} from 'zod';
import {HashSchema,IdSchema} from '../contracts/common.ts';
import {fingerprint} from './probes.ts';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),positive=count.positive();
const ref=z.strictObject({id:IdSchema,sha256:HashSchema});
const identity=z.strictObject({pid:positive,creationIdentity:z.string().min(1).max(256)});
export const CampaignAdministrativePolicySchema=z.strictObject({schemaVersion:z.literal(1),authorityHash:HashSchema,
 preparationInvocationIds:z.array(IdSchema).min(1).max(256),registrationInvocationId:IdSchema,registrationProcessCount:positive.max(8),unitWrapperProcessCount:positive.max(8),settlementProcessCount:positive.max(8)});
export const AdministrativeInvocationSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('administrative-invocation'),id:IdSchema,
 campaignId:IdSchema,targetHash:HashSchema,authorityHash:HashSchema,operationId:IdSchema.optional(),
 role:z.enum(['preparation','registration','unit-wrapper','settlement','observer','cleanup','audit']),
 identity,createdAt:positive,inputPinsHash:HashSchema,invocationHash:HashSchema,
 outputLimitBytes:positive.max(67108864),activeLimitMs:positive.max(3600000),boundsEvidence:ref});
export type AdministrativeInvocation=z.infer<typeof AdministrativeInvocationSchema>;
/** A control-plane receipt is normalized by the existing trusted coordinator
 * from genuine tool results. Its digest must be explicitly trusted at loading. */
export const AdministrativeControlPlaneTerminalSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('existing-control-plane-terminal'),authorityHash:HashSchema,
 invocationId:IdSchema,identity,initialIssuedAt:positive,observedAfterExitAt:positive,
 chain:z.array(z.strictObject({toolCallId:z.string().min(1).max(256),chunkId:z.string().min(1).max(256),sessionId:z.string().min(1).max(256).nullable(),exitCode:z.number().int().nullable(),rawResult:ref})).min(1).max(1024),
 unresolvedSessions:z.array(z.never()).length(0),unresolvedStreams:z.array(z.never()).length(0),
});
export const AdministrativeReceiptSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('administrative-terminal-receipt'),invocation:ref,
 terminal:z.discriminatedUnion('mode',[
  z.strictObject({mode:z.literal('control-plane-conservative'),evidence:ref,startedNoLaterThan:positive,observedExitedBy:positive,activeMsUpperBound:positive}),
  z.strictObject({mode:z.literal('owned-exact'),observerInvocationId:IdSchema,evidence:ref,completedAt:positive,activeMs:count,exitCode:z.number().int()}),
 ]),
 output:z.discriminatedUnion('mode',[
  z.strictObject({mode:z.literal('exact-streams'),rawOutputBytes:count,evidence:ref}),
  z.strictObject({mode:z.literal('enforced-upper-bound'),rawOutputBytesUpperBound:positive,evidence:ref}),
 ]),
});
export type AdministrativeReceipt=z.infer<typeof AdministrativeReceiptSchema>;
export const AdministrativeLedgerSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('administrative-evidence-ledger'),campaignId:IdSchema,targetHash:HashSchema,authorityHash:HashSchema,grantHash:HashSchema,historyHash:HashSchema,
 invocations:z.array(ref).min(1).max(4096),receipts:z.array(ref).min(1).max(4096)});
export type AdministrativeGateContext={campaignId:string;targetHash:string;grantHash:string;historyHash:string;nextUnitId:string;
 priorOperationId?:string;policy:z.infer<typeof CampaignAdministrativePolicySchema>};
type Validated={revalidate():void;ledgerHash:string;campaignId:string;targetHash:string;authorityHash:string;grantHash:string;historyHash:string;entries:Array<{invocation:AdministrativeInvocation;cost:{actions:number;activeMs:number;outputBytes:number}}>;
 total:{actions:number;activeMs:number;outputBytes:number}};
const accepted=new WeakMap<object,Validated>();
export type AcceptedAdministrativeEvidence=Readonly<{ledgerHash:string;total:Readonly<{actions:number;activeMs:number;outputBytes:number}>}>;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** No dispatch, file mutation, accounting import or self-declared completion.
 * External trust is an exact registered digest of genuine terminal tool data. */
export function loadAdministrativeEvidence(input:{ledger:z.infer<typeof AdministrativeLedgerSchema>;readArtifact(reference:z.infer<typeof ref>):Uint8Array;
 authorizeLedger(ledgerHash:string):boolean;authorizeControlPlane(terminalHash:string):boolean;
 authorizeOwnedObservation?(invocation:Readonly<AdministrativeInvocation>,receipt:Readonly<AdministrativeReceipt>,observer:Readonly<AdministrativeInvocation>):boolean;
 authorizeOutput(invocation:Readonly<AdministrativeInvocation>,receipt:Readonly<AdministrativeReceipt>):boolean;}):AcceptedAdministrativeEvidence{
 const ledger=AdministrativeLedgerSchema.parse(input.ledger),ledgerHash=fingerprint(ledger);
 if(input.authorizeLedger(ledgerHash)!==true)throw Error('ADMINISTRATIVE_LEDGER_NOT_ACCEPTED');
 const checked=new Map<string,z.infer<typeof ref>>();
 const bytes=(r:z.infer<typeof ref>)=>{checked.set(r.id,r);const b=input.readArtifact(r);if(b.length>1048576||hash(b)!==r.sha256)throw Error('ADMINISTRATIVE_BYTES_CHANGED');return b;};
 const json=(r:z.infer<typeof ref>)=>JSON.parse(Buffer.from(bytes(r)).toString('utf8'));
 const invocations=ledger.invocations.map(r=>({ref:r,value:AdministrativeInvocationSchema.parse(json(r))})),receipts=ledger.receipts.map(r=>({ref:r,value:AdministrativeReceiptSchema.parse(json(r))}));
 if(new Set(invocations.map(i=>i.value.id)).size!==invocations.length||new Set(invocations.map(i=>fingerprint(i.value.identity))).size!==invocations.length||new Set(receipts.map(r=>r.value.invocation.id)).size!==receipts.length||receipts.length!==invocations.length)throw Error('ADMINISTRATIVE_REPLAY_OR_INCOMPLETE');
 const byId=new Map(invocations.map(i=>[i.value.id,i]));
 const entries:Validated['entries']=[];
 for(const i of invocations){
  const v=i.value,r=receipts.find(r=>r.value.invocation.id===i.ref.id)?.value;
  if(i.ref.id!==v.id||v.campaignId!==ledger.campaignId||v.targetHash!==ledger.targetHash||v.authorityHash!==ledger.authorityHash||!r||r.invocation.sha256!==i.ref.sha256)throw Error('ADMINISTRATIVE_INVOCATION_BINDING_CHANGED');
  bytes(v.boundsEvidence);let activeMs:number;
  if(r.terminal.mode==='control-plane-conservative'){
   const t=AdministrativeControlPlaneTerminalSchema.parse(json(r.terminal.evidence));
   if(input.authorizeControlPlane(r.terminal.evidence.sha256)!==true||t.authorityHash!==ledger.authorityHash||t.invocationId!==v.id||fingerprint(t.identity)!==fingerprint(v.identity)||t.initialIssuedAt>v.createdAt||t.observedAfterExitAt<v.createdAt||r.terminal.startedNoLaterThan!==t.initialIssuedAt||r.terminal.observedExitedBy!==t.observedAfterExitAt||r.terminal.activeMsUpperBound!==t.observedAfterExitAt-t.initialIssuedAt||t.chain.at(-1)!.exitCode!==0||t.chain.slice(0,-1).some(c=>c.exitCode!==null)||new Set(t.chain.map(c=>c.toolCallId)).size!==t.chain.length||new Set(t.chain.map(c=>c.chunkId)).size!==t.chain.length)throw Error('ADMINISTRATIVE_CONTROL_PLANE_UNPROVEN');
   const sessions=t.chain.map(c=>c.sessionId).filter((s):s is string=>s!==null);if(new Set(sessions).size>1)throw Error('ADMINISTRATIVE_SESSION_CHANGED');
   for(const c of t.chain)bytes(c.rawResult);
   activeMs=r.terminal.activeMsUpperBound;
  }else{
   const observer=byId.get(r.terminal.observerInvocationId)?.value;
   if(!observer||observer.id===v.id||input.authorizeOwnedObservation?.(Object.freeze(v),Object.freeze(r),Object.freeze(observer))!==true||r.terminal.exitCode!==0||r.terminal.completedAt<v.createdAt||r.terminal.activeMs!==r.terminal.completedAt-v.createdAt)throw Error('ADMINISTRATIVE_OWNED_EXIT_UNPROVEN');
   bytes(r.terminal.evidence);activeMs=r.terminal.activeMs;
  }
  bytes(r.output.evidence);if(input.authorizeOutput(Object.freeze(v),Object.freeze(r))!==true)throw Error('ADMINISTRATIVE_OUTPUT_UNPROVEN');
  const outputBytes=r.output.mode==='exact-streams'?r.output.rawOutputBytes:r.output.rawOutputBytesUpperBound;
  if(activeMs>v.activeLimitMs||outputBytes>v.outputLimitBytes||r.output.mode==='enforced-upper-bound'&&outputBytes!==v.outputLimitBytes)throw Error('ADMINISTRATIVE_LIMIT_EXCEEDED');
  entries.push({invocation:v,cost:{actions:1,activeMs,outputBytes}});
 }
 // Owned observers themselves must terminate through an independently observed
 // chain ending at the existing control plane, never an observer cycle.
 for(const i of invocations){const seen=new Set<string>();let cursor=i.value.id;for(;;){if(seen.has(cursor))throw Error('ADMINISTRATIVE_OBSERVER_CYCLE');seen.add(cursor);const current=byId.get(cursor)!,r=receipts.find(r=>r.value.invocation.id===current.ref.id)!.value;if(r.terminal.mode==='control-plane-conservative')break;cursor=r.terminal.observerInvocationId;}}
 const total=entries.reduce((sum,e)=>({actions:sum.actions+e.cost.actions,activeMs:sum.activeMs+e.cost.activeMs,outputBytes:sum.outputBytes+e.cost.outputBytes}),{actions:0,activeMs:0,outputBytes:0});
 if(Object.values(total).some(n=>!Number.isSafeInteger(n)))throw Error('ADMINISTRATIVE_COUNTER_OVERFLOW');
 const value=Object.freeze({ledgerHash,total:Object.freeze({...total})});accepted.set(value,{revalidate:()=>{for(const r of checked.values())bytes(r);},ledgerHash,campaignId:ledger.campaignId,targetHash:ledger.targetHash,authorityHash:ledger.authorityHash,grantHash:ledger.grantHash,historyHash:ledger.historyHash,entries,total});return value;
}
export function requireAdministrativeGate(evidence:AcceptedAdministrativeEvidence|undefined,context:AdministrativeGateContext){
 const data=evidence&&accepted.get(evidence);if(!data||data.campaignId!==context.campaignId||data.targetHash!==context.targetHash||data.authorityHash!==context.policy.authorityHash||data.grantHash!==context.grantHash||data.historyHash!==context.historyHash)throw Error('ADMINISTRATIVE_TERMINAL_GATE_REQUIRED');
 data.revalidate();
 const byId=new Map(data.entries.map(e=>[e.invocation.id,e.invocation]));
 if(context.policy.preparationInvocationIds.some(id=>byId.get(id)?.role!=='preparation')||byId.get(context.policy.registrationInvocationId)?.role!=='registration'||data.entries.filter(e=>e.invocation.role==='registration').length<context.policy.registrationProcessCount)throw Error('ADMINISTRATIVE_PREPARATION_CHAIN_INCOMPLETE');
 if(context.priorOperationId&&!(['unit-wrapper','settlement'] as const).every(role=>data.entries.filter(e=>e.invocation.role===role&&e.invocation.operationId===context.priorOperationId).length>=(role==='unit-wrapper'?context.policy.unitWrapperProcessCount:context.policy.settlementProcessCount)))throw Error('ADMINISTRATIVE_PREVIOUS_UNIT_INCOMPLETE');
 return {ledgerHash:data.ledgerHash,total:{...data.total}};
}
/** Final accounting joins sidecars with campaign process identities. A process
 * is counted once; a larger attributable conservative measurement adds only
 * its difference. No caller completion flag or fabricated opaque object works. */
export function administrativeAdditionalCosts(evidence:AcceptedAdministrativeEvidence,alreadyAccounted:readonly {identity:z.infer<typeof identity>;activeMs:number;outputBytes:number}[]){
 const data=accepted.get(evidence);if(!data)throw Error('ADMINISTRATIVE_TERMINAL_GATE_REQUIRED');data.revalidate();
 const charged=new Map<string,{activeMs:number;outputBytes:number}>();
 for(const p of alreadyAccounted){identity.parse(p.identity);count.parse(p.activeMs);count.parse(p.outputBytes);const key=fingerprint(p.identity);if(charged.has(key))throw Error('ADMINISTRATIVE_CHARGED_IDENTITY_REPLAY');charged.set(key,p);}
 const additional=data.entries.reduce((sum,e)=>{const old=charged.get(fingerprint(e.invocation.identity));return {actions:sum.actions+(old?0:1),activeMs:sum.activeMs+Math.max(0,e.cost.activeMs-(old?.activeMs??0)),outputBytes:sum.outputBytes+Math.max(0,e.cost.outputBytes-(old?.outputBytes??0))};},{actions:0,activeMs:0,outputBytes:0});
 if(Object.values(additional).some(n=>!Number.isSafeInteger(n)))throw Error('ADMINISTRATIVE_COUNTER_OVERFLOW');
 return {administrative:{...data.total},additional,ledgerHash:data.ledgerHash};
}
