import {CampaignAdministrativePolicySchema,requireAdministrativeGate,type AdministrativeGateContext,type AcceptedAdministrativeEvidence} from './campaign-administration.ts';
import {isUnlimited} from './campaign-policy.ts';
import {CAMPAIGN_EXECUTION_PROBE_ORDER} from './campaign-order.ts';
import {loadCampaignTerminal,validateCampaignTerminalTopology} from './campaign-terminal.ts';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {HashSchema,IdSchema,type Result} from '../contracts/common.ts';
import {OwnerTokenSchema} from '../contracts/evidence.ts';
import type {RunStore,QualificationEnvelope} from '../store/database.ts';
import {BatchApprovalSchema,CampaignExecutionLimitsSchema,type QualificationCampaign,type BatchApproval} from './campaign.ts';
import {CampaignCostSchema,exceedsAllowance} from './campaign-policy.ts';
import {CampaignAccountingSchema,HistoricalExecutionAccountingObservationSchema,PreparationAccountingObservationSchema,readAccountingEvidence} from './campaign-accounting.ts';
import type {CampaignExecutionProposal,CampaignExecutionSnapshot} from './campaign-execution.ts';
import {REQUIRED_CODEX_WINDOWS_PROBES,fingerprint} from './probes.ts';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const CampaignAuthorizationSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('reviewed-campaign-authorization'),id:IdSchema,campaignId:IdSchema,owner:OwnerTokenSchema,
 targetHash:HashSchema,identityHash:HashSchema,sourceCatalogHash:HashSchema,fixtureHash:HashSchema,endpointHash:HashSchema,controlsHash:HashSchema,
 probeCatalogHash:HashSchema,unitOrder:z.array(z.string()).length(34),executionPlanHash:HashSchema,resourceLimits:CampaignExecutionLimitsSchema,
 administration:CampaignAdministrativePolicySchema.optional(),coordinatorEnvelope:CampaignCostSchema,issuedAt:positive,expiresAt:positive,approvalInstruction:z.string().min(1).max(16384),
}).superRefine((g,ctx)=>{if(g.administration&&g.coordinatorEnvelope.actions!==g.administration.unitWrapperProcessCount)ctx.addIssue({code:'custom',message:'Every coordinator process requires an exact finite reservation'});if(isUnlimited(g.resourceLimits.campaignLimits)&&!g.administration)ctx.addIssue({code:'custom',message:'Unlimited successor requires external administrative policy'});if(g.expiresAt<=g.issuedAt||g.expiresAt-g.issuedAt>604800000||fingerprint(g.unitOrder)!==fingerprint(['metadata','strict-pair',...CAMPAIGN_EXECUTION_PROBE_ORDER])||g.probeCatalogHash!==fingerprint(REQUIRED_CODEX_WINDOWS_PROBES)||(g.coordinatorEnvelope.actions<1||g.coordinatorEnvelope.actions>4)||g.coordinatorEnvelope.activeMs===0||g.coordinatorEnvelope.outputBytes===0)ctx.addIssue({code:'custom',message:'Exact finite campaign lifetime, canonical probe order, catalog and coordinator envelope required'});});
export type CampaignAuthorization=z.infer<typeof CampaignAuthorizationSchema>;
export const DerivedCampaignBatchAuthorizationSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('derived-campaign-batch-authorization'),grantHash:HashSchema,operationId:IdSchema,
 historyHash:HashSchema,snapshotHash:HashSchema,unitId:z.string(),batchHash:HashSchema,proposalHash:HashSchema,issuedAt:positive,expiresAt:positive});
export type DerivedCampaignBatchAuthorization=z.infer<typeof DerivedCampaignBatchAuthorizationSchema>;
const OperationSchema=z.strictObject({schemaVersion:z.literal(1),grantHash:HashSchema,operationId:IdSchema,unitId:z.string(),snapshotHash:HashSchema,consumed:CampaignCostSchema,accountingIds:z.array(IdSchema),beganAt:positive});
const SettlementSchema=z.strictObject({schemaVersion:z.literal(1),grantHash:HashSchema,operationId:IdSchema,unitId:z.string(),batchId:IdSchema,accountingId:IdSchema,settledAt:positive});
const must=<T>(r:Result<T>):T=>{if(!r.ok)throw Error(r.error.code);return r.value;};
const same=(a:unknown,b:unknown)=>fingerprint(a)===fingerprint(b);
function terminal(s:CampaignExecutionSnapshot){if(s.fenced||s.superseded||s.reconciliationRequired||s.accountingPending||s.correctionRequired||s.reserved.actions||s.reserved.activeMs||s.reserved.outputBytes||s.unsuccessfulCorrections>=s.executionLimits.maxUnsuccessfulCorrections)throw Error('CAMPAIGN_CONTINUATION_NOT_TERMINAL');}

/** Durable campaign authorization with one outstanding operation. Journal
 * metadata is reconciled immediately; an unfinished operation remains visible
 * after a crash and is never inferred successful or automatically retried. */
export class CampaignAuthorizationJournal{
 readonly campaign:QualificationCampaign;
 readonly options:{now():number;authorizeGrant(grant:Readonly<CampaignAuthorization>):boolean;current():{sourceCatalogHash:string;fixtureHash:string;endpointHash:string;controlsHash:string};validateProposal(proposal:Readonly<CampaignExecutionProposal>,snapshot:CampaignExecutionSnapshot):boolean;administrativeGate?(context:Readonly<AdministrativeGateContext>):AcceptedAdministrativeEvidence|undefined};
 constructor(campaign:QualificationCampaign,options:CampaignAuthorizationJournal['options']){this.campaign=campaign;this.options=options;}
 get store():RunStore{return this.campaign.store;}
 #rows(){return must(this.store.listQualifications());}
 #append(g:CampaignAuthorization,kind:QualificationEnvelope['kind'],payload:unknown){
  const rows=this.#rows(),id=randomUUID();
  must(this.store.intent(g.owner,{schemaVersion:1,id,runId:g.owner.runId,kind,payload:{campaignId:g.campaignId,grantHash:fingerprint(g)}}));
  must(this.store.appendQualification(g.owner,{schemaVersion:1,id:randomUUID(),runId:g.owner.runId,generation:g.owner.generation,actionId:id,requestId:g.campaignId,targetHash:g.targetHash,kind,payload:JSON.parse(JSON.stringify(payload))},rows.filter(r=>r.runId===g.owner.runId).length,rows.length));
  must(this.store.outcome(g.owner,id,{schemaVersion:1,status:'RECONCILED',evidenceIds:[]}));
 }
 #current(raw:CampaignAuthorization){
  const g=CampaignAuthorizationSchema.parse(raw),at=this.options.now(),s=must(this.campaign.snapshot(g.campaignId));
  if(!Number.isSafeInteger(at)||at<g.issuedAt||at>=g.expiresAt||!same(s.identity.owner,g.owner)||s.targetHash!==g.targetHash||fingerprint(s.identity)!==g.identityHash||!same(g.resourceLimits,s.executionLimits)||!same(this.options.current(),{sourceCatalogHash:g.sourceCatalogHash,fixtureHash:g.fixtureHash,endpointHash:g.endpointHash,controlsHash:g.controlsHash})||this.options.authorizeGrant(Object.freeze(structuredClone(g)))!==true)throw Error('CAMPAIGN_GRANT_CHANGED_OR_EXPIRED');
  return {g,s,at};
 }
 register(raw:CampaignAuthorization):void{
  const {g,s}=this.#current(raw);terminal(s);
  if(this.#rows().some(r=>r.requestId===g.campaignId&&r.kind==='CAMPAIGN_GRANT'))throw Error('CAMPAIGN_GRANT_REPLAY');
  const recovery=must(this.store.reconcileEvidence(g.owner.runId));if(!recovery.allowsReady)throw Error('CAMPAIGN_PENDING_OR_UNKNOWN_ACTIONS');
  this.#append(g,'CAMPAIGN_GRANT',g);
 }
 #state(g:CampaignAuthorization){
  const rows=this.#rows().filter(r=>r.requestId===g.campaignId),registered=rows.filter(r=>r.kind==='CAMPAIGN_GRANT');
  if(registered.length!==1||!same(registered[0]!.payload,g))throw Error('CAMPAIGN_REGISTERED_GRANT_REQUIRED');
  const operations=rows.filter(r=>r.kind==='CAMPAIGN_OPERATION').map(r=>OperationSchema.parse(r.payload)),settlements=rows.filter(r=>r.kind==='CAMPAIGN_SETTLEMENT').map(r=>SettlementSchema.parse(r.payload));
  if(new Set(operations.map(o=>o.operationId)).size!==operations.length||settlements.length>operations.length||settlements.some((s,i)=>!same({operationId:s.operationId,unitId:s.unitId,grantHash:s.grantHash},{operationId:operations[i]?.operationId,unitId:operations[i]?.unitId,grantHash:fingerprint(g)}))||operations.some((o,i)=>o.unitId!==g.unitOrder[i]||o.grantHash!==fingerprint(g)))throw Error('CAMPAIGN_JOURNAL_REPLAY_OR_ORDER_CHANGED');
  return {rows,operations,settlements};
 }
 /** Call before plan/proposal construction. Failure leaves a durable blocker. */
 beginNext(raw:CampaignAuthorization,requestedOperationId?:string):{operationId:string;unitId:string}{
  const {g,s,at}=this.#current(raw);terminal(s);const state=this.#state(g);
  if(state.operations.length!==state.settlements.length)throw Error('CAMPAIGN_INCOMPLETE_OPERATION');
  if(!must(this.store.reconcileEvidence(g.owner.runId)).allowsReady)throw Error('CAMPAIGN_PENDING_OR_UNKNOWN_ACTIONS');
  const unitId=g.unitOrder[state.operations.length];if(!unitId)throw Error('CAMPAIGN_SEQUENCE_COMPLETE');
  if(isUnlimited(g.resourceLimits.campaignLimits)){if(!g.administration)throw Error('ADMINISTRATIVE_POLICY_REQUIRED');const context:AdministrativeGateContext={campaignId:g.campaignId,targetHash:g.targetHash,grantHash:fingerprint(g),historyHash:fingerprint(this.#rows()),nextUnitId:unitId,policy:g.administration,...(state.operations.at(-1)?{priorOperationId:state.operations.at(-1)!.operationId}:{})};requireAdministrativeGate(this.options.administrativeGate?.(Object.freeze(structuredClone(context))),context);}
  const operationId=requestedOperationId??randomUUID();if(!IdSchema.safeParse(operationId).success||state.operations.some(o=>o.operationId===operationId))throw Error('CAMPAIGN_OPERATION_REPLAY');this.#append(g,'CAMPAIGN_OPERATION',{schemaVersion:1,grantHash:fingerprint(g),operationId,unitId,snapshotHash:fingerprint(s),consumed:s.consumed,accountingIds:s.accountingAdjustmentIds,beganAt:at});return {operationId,unitId};
 }
 derive(raw:CampaignAuthorization,operationId:string,proposal:CampaignExecutionProposal):DerivedCampaignBatchAuthorization{
  const {g,s,at}=this.#current(raw);terminal(s);const state=this.#state(g),o=state.operations.at(-1),b=BatchApprovalSchema.parse(proposal.runtime.batch);
  if(state.rows.some(r=>r.kind==='CAMPAIGN_BATCH_AUTHORIZATION'&&(r.payload as {operationId?:string}).operationId===operationId))throw Error('CAMPAIGN_BATCH_AUTHORIZATION_REPLAY');
  if(typeof this.options.validateProposal!=='function'||this.options.validateProposal(Object.freeze(structuredClone(proposal)),s)!==true)throw Error('CAMPAIGN_PROPOSAL_NOT_CANONICAL');
  if(!o||state.operations.length!==state.settlements.length+1||o.operationId!==operationId||o.unitId!==proposal.unit.id||o.snapshotHash!==fingerprint(s)||g.executionPlanHash!==proposal.planHash||!same(b.owner,g.owner)||b.campaignId!==g.campaignId||b.targetHash!==g.targetHash||b.fixtureHash!==g.fixtureHash||b.endpointHash!==g.endpointHash||b.approvedAt>at||at-b.approvedAt>Math.min(5000,g.resourceLimits.batchLimits.approvalTtlMs)||b.expiresAt>g.expiresAt||b.expiresAt-at>g.resourceLimits.batchLimits.approvalTtlMs||b.expiresAt<=at||proposal.deficits.length)throw Error('CAMPAIGN_DERIVATION_BINDING_CHANGED');
  const total=b.actions.reduce((sum,a)=>({actions:sum.actions+1,activeMs:sum.activeMs+a.maxMs,outputBytes:sum.outputBytes+a.maxOutputBytes}),{...g.coordinatorEnvelope});
  if(exceedsAllowance(total,s.remaining)||total.activeMs>g.resourceLimits.batchLimits.activeMs||total.outputBytes>g.resourceLimits.batchLimits.outputBytes||b.actions.filter(a=>a.topLevel).length+g.coordinatorEnvelope.actions>g.resourceLimits.batchLimits.topLevelActions)throw Error('CAMPAIGN_DERIVATION_BATCH_LIMIT');
  const derived=DerivedCampaignBatchAuthorizationSchema.parse({schemaVersion:1,kind:'derived-campaign-batch-authorization',grantHash:fingerprint(g),operationId,historyHash:fingerprint(this.#rows()),snapshotHash:fingerprint(s),unitId:o.unitId,batchHash:fingerprint(b),proposalHash:fingerprint(proposal),issuedAt:at,expiresAt:b.expiresAt});
  this.#append(g,'CAMPAIGN_BATCH_AUTHORIZATION',derived);return derived;
 }
 authorizeDerived(raw:CampaignAuthorization,rawDerived:DerivedCampaignBatchAuthorization,proposal:CampaignExecutionProposal):boolean{
  try{const d=DerivedCampaignBatchAuthorizationSchema.parse(rawDerived),{g,s,at}=this.#current(raw),state=this.#state(g),o=state.operations.at(-1);
   const all=this.#rows(),last=all.at(-1);
   return last?.kind==='CAMPAIGN_BATCH_AUTHORIZATION'&&same(last.payload,d)&&!!o&&state.operations.length===state.settlements.length+1&&o.operationId===d.operationId&&o.unitId===d.unitId&&d.grantHash===fingerprint(g)&&d.proposalHash===fingerprint(proposal)&&d.batchHash===fingerprint(proposal.runtime.batch)&&d.historyHash===fingerprint(all.slice(0,-1))&&d.snapshotHash===fingerprint(s)&&at>=d.issuedAt&&at<d.expiresAt;
  }catch{return false;}
 }
 /** Settle only after host exit/output/process-tree accounting was independently
  * charged through campaign.reconcileAccounting; a result boolean is insufficient. */
 settle(raw:CampaignAuthorization,input:{operationId:string;batchId:string;accountingId:string}):void{
  const {g,s,at}=this.#current(raw);terminal(s);const state=this.#state(g),o=state.operations.at(-1);
  if(!o||state.operations.length!==state.settlements.length+1||o.operationId!==input.operationId||o.accountingIds.includes(input.accountingId)||!s.accountingAdjustmentIds.includes(input.accountingId))throw Error('CAMPAIGN_SETTLEMENT_REQUIRES_NEW_ACCOUNTING');
  const b=state.rows.find(r=>r.kind==='BATCH_APPROVAL'&&(r.payload as {id?:string}).id===input.batchId);if(!b)throw Error('CAMPAIGN_SETTLEMENT_BATCH_MISSING');
  const batch=BatchApprovalSchema.parse(b.payload),authorization=state.rows.filter(r=>r.kind==='CAMPAIGN_BATCH_AUTHORIZATION'&&(r.payload as {operationId?:string}).operationId===o.operationId);
  if(authorization.length!==1||DerivedCampaignBatchAuthorizationSchema.parse(authorization[0]!.payload).batchHash!==fingerprint(batch)||DerivedCampaignBatchAuthorizationSchema.parse(authorization[0]!.payload).unitId!==o.unitId||state.rows.indexOf(b)<=state.rows.indexOf(authorization[0]!))throw Error('CAMPAIGN_SETTLEMENT_AUTHORIZATION_MISSING');
  if(!batch.actions.length||batch.actions.some(a=>!state.rows.some(r=>r.kind==='CAMPAIGN_RESULT'&&r.actionId===a.id&&(r.payload as {batchId?:string;usage?:{status?:string}}).batchId===batch.id&&(r.payload as {usage?:{status?:string}}).usage?.status==='PASS')))throw Error('CAMPAIGN_SETTLEMENT_RESULTS_INCOMPLETE');
  const terminals=batch.actions.filter(a=>a.kind!=='cleanup').map(action=>{const result=state.rows.find(r=>r.kind==='CAMPAIGN_RESULT'&&r.actionId===action.id)!,usage=(result.payload as {usage:{elapsedMs:number;outputBytes:number;evidence?:Array<{id:string;sha256:string;category:string}>}}).usage;return {action,terminal:loadCampaignTerminal(this.store,batch,action,usage.evidence??[],usage)};});
  const cleanupUsage=new Map(batch.actions.filter(a=>a.kind==='cleanup').map(action=>{const result=state.rows.find(r=>r.kind==='CAMPAIGN_RESULT'&&r.actionId===action.id)!;return [action.id,(result.payload as {usage:{outputBytes:number}}).usage] as const;}));
  validateCampaignTerminalTopology(terminals,cleanupUsage);
  const receiptRow=state.rows.find(r=>r.kind==='CAMPAIGN_ACCOUNTING'&&CampaignAccountingSchema.safeParse(readAccountingEvidence(this.store,g.owner.runId,r.payload as {id:string;sha256:string})).data?.id===input.accountingId);
  if(!receiptRow)throw Error('CAMPAIGN_SETTLEMENT_ACCOUNTING_MISSING');
  const receipt=CampaignAccountingSchema.parse(readAccountingEvidence(this.store,g.owner.runId,receiptRow.payload as {id:string;sha256:string}));
  const observations=[...receipt.preparation,...receipt.historicalExecutions??[]].map(ref=>readAccountingEvidence(this.store,g.owner.runId,ref));
  if(!observations.some(raw=>{const p=PreparationAccountingObservationSchema.safeParse(raw);if(p.success)return p.data.operationId===o.operationId&&p.data.category==='auxiliary-execution';const h=HistoricalExecutionAccountingObservationSchema.safeParse(raw);return h.success&&h.data.operationId===o.operationId&&h.data.category==='outer-controller';}))throw Error('CAMPAIGN_SETTLEMENT_COORDINATOR_UNACCOUNTED');
  if(!must(this.store.reconcileEvidence(g.owner.runId)).allowsReady)throw Error('CAMPAIGN_PENDING_OR_UNKNOWN_ACTIONS');
  this.#append(g,'CAMPAIGN_SETTLEMENT',{schemaVersion:1,grantHash:fingerprint(g),...input,unitId:o.unitId,settledAt:at});
 }
}
