import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HashSchema, IdSchema, type Result } from '../contracts/common.ts';
import { OwnerTokenSchema, type OwnerToken, type ActionIntent } from '../contracts/evidence.ts';
import { storeError, type RunStore, type QualificationEnvelope } from '../store/database.ts';
import { fingerprint, REQUIRED_CODEX_WINDOWS_PROBES } from './probes.ts';
import { assessPhaseAdmission, type PhaseAdmission, type StartupIntent } from './codex-startup-authority.ts';
import { ExecutionOwnerSchema,WindowsOwnershipReceiptSchema,type OwnershipReceipt } from '../contracts/execution.ts';
import {QualificationTerminalSchema} from '../contracts/qualification-observation.ts';
import {isTerminalDrained} from './session-drivers.ts';
import {PendingDispatchPayloadSchema} from './pending-dispatch.ts';
import {assertIntegralProcessBudget} from './process-budget.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { QualificationTargetSchema, targetFingerprint, type QualificationTarget } from './ledger.ts';
import {AccountingEvidenceSchema,CampaignAccountingSchema,deriveAccounting,readAccountingEvidence,type AccountingEvidence,type CampaignAccounting} from './campaign-accounting.ts';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.positive();
const Allowance = z.strictObject({ actions: count, activeMs: count, outputBytes: count });
export const CAMPAIGN_LIMITS = Object.freeze({ actions: 96, activeMs: 2400000, outputBytes: 10485760 });
export const CAMPAIGN_BATCH_LIMITS = Object.freeze({topLevelActions:4 as const,activeMs:150000,outputBytes:262144,approvalTtlMs:600000});
// Larger envelopes are readable only so an explicitly authorized immutable
// allowance can select them. Absent that allowance the original limits apply.
export const CampaignExecutionLimitsSchema=z.strictObject({
 campaignLimits:z.strictObject({actions:positive.max(1024),activeMs:positive.max(86400000),outputBytes:positive.max(1073741824)}),
 batchLimits:z.strictObject({topLevelActions:z.literal(4),activeMs:positive.max(600000),outputBytes:positive.max(67108864),approvalTtlMs:positive.max(600000)}),
 maxUnsuccessfulCorrections:count.max(1024),
}).superRefine((limits,ctx)=>{if(limits.batchLimits.activeMs>limits.campaignLimits.activeMs||limits.batchLimits.outputBytes>limits.campaignLimits.outputBytes)ctx.addIssue({code:'custom',message:'Batch cannot exceed campaign allowance'});});
export const CampaignExecutionPolicySchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('human-execution-allowance'),id:IdSchema,
 campaignId:IdSchema,owner:OwnerTokenSchema,storeRootHash:HashSchema,historyHash:HashSchema,targetHash:HashSchema,
 approvalInstruction:z.string().min(1).max(16384),limits:CampaignExecutionLimitsSchema,
 continuation:z.strictObject({supersedesCampaignId:IdSchema,priorTargetHash:HashSchema,failedActionIds:z.array(IdSchema).max(1024)}).optional()});
export type CampaignExecutionPolicy=z.infer<typeof CampaignExecutionPolicySchema>;
const defaultExecutionLimits=()=>({campaignLimits:{...CAMPAIGN_LIMITS},batchLimits:{...CAMPAIGN_BATCH_LIMITS},maxUnsuccessfulCorrections:2});
export const CampaignLineageSchema=z.strictObject({storeRootHash:HashSchema,historyHash:HashSchema,rootId:IdSchema});
export const CampaignIdentitySchema = z.strictObject({ schemaVersion: z.literal(2), id: IdSchema, owner: OwnerTokenSchema,
 target:QualificationTargetSchema,targetHash: HashSchema, controllerHash: HashSchema, protocolHash: HashSchema, driverHash: HashSchema,lineage:CampaignLineageSchema,supersedes:IdSchema.optional(),executionPolicy:AccountingEvidenceSchema.optional() });
export type CampaignIdentity = z.infer<typeof CampaignIdentitySchema>;
export const CampaignActionSchema = z.strictObject({ id: IdSchema, kind: z.enum(['startup', 'metadata', 'strict-positive', 'strict-negative', 'endpoint', 'preparation', 'probe', 'cleanup']),
 topLevel: z.boolean(), probeId: z.string().optional(), launchHash: HashSchema, admissionHash: HashSchema,
 maxMs: positive.max(600000), maxOutputBytes: positive.max(67108864), cleanupId: IdSchema.optional(),auxiliaryFor:IdSchema.optional(),auxiliaryRole:z.enum(['guardian','controller','endpoint']).optional() });
export type CampaignAction = z.infer<typeof CampaignActionSchema>;
export const CampaignProbeEvidenceSchema=z.strictObject({schemaVersion:z.literal(2),kind:z.literal('campaign-probe'),targetHash:HashSchema,
 probeId:z.string(),role:z.enum(['worker','verifier','controller']),launchHash:HashSchema,status:z.enum(['PASS','FAIL','UNTESTED']),actualAttempt:z.boolean(),
 evidenceKind:z.enum(['fixture','live','fault_injection']),proof:z.json().optional()});
export const BatchApprovalSchema = z.strictObject({ schemaVersion: z.literal(2), id: IdSchema, campaignId: IdSchema, owner: OwnerTokenSchema,
 targetHash: HashSchema, fixtureHash: HashSchema, endpointHash: HashSchema, approvedAt: positive, expiresAt: positive,
 remaining: Allowance, actions: z.array(CampaignActionSchema).min(1).max(1024),
 correction: z.strictObject({ candidateId: IdSchema, evidenceIds: z.array(IdSchema).min(1), affectedActionId: IdSchema,
  replacementActionId:IdSchema.optional() }).optional() });
export type BatchApproval = z.infer<typeof BatchApprovalSchema>;
const Usage = z.strictObject({ elapsedMs: count, outputBytes: count, status: z.enum(['PASS', 'FAIL', 'UNTESTED']), evidenceKind: z.enum(['fixture', 'live', 'fault_injection']),
 evidence: z.array(z.strictObject({ id: IdSchema, sha256: HashSchema, category: z.string().min(1) })).optional() });
type Usage = z.infer<typeof Usage>;
const ProcessIdentity=z.strictObject({pid:positive,creationIdentity:z.string().min(1)});
const RecoveryMeter=z.strictObject({kind:z.enum(['root','helper']),identity:ProcessIdentity,activeMs:count});
const RecoveryExecution=z.strictObject({kind:z.literal('owned-execution'),launchHash:HashSchema,ownership:WindowsOwnershipReceiptSchema,terminal:z.json(),
 brokerInventory:z.strictObject({inventoryComplete:z.literal(true),active:z.array(z.string()).length(0),unresolved:z.array(z.string()).length(0)}),processMeters:z.array(RecoveryMeter).length(2).optional()});
const RecoveryAuxiliary=z.strictObject({kind:z.literal('auxiliary-exit'),launchHash:HashSchema,owner:ExecutionOwnerSchema,identity:ProcessIdentity,
 createdAt:positive,completedAt:positive,activeMs:count,exitCode:z.number().int(),outputComplete:z.literal(true)});
const RecoveryMember=z.union([RecoveryExecution,RecoveryAuxiliary]);
const RecoveryObservation=z.union([RecoveryMember,z.strictObject({kind:z.literal('cleanup-topology'),members:z.array(RecoveryMember).min(1).max(96)})]);
const FailureSchema=z.strictObject({actionId:IdSchema,kind:CampaignActionSchema.shape.kind,probeId:z.string().optional(),evidenceKind:Usage.shape.evidenceKind,evidence:Usage.shape.evidence});
type Failure=z.infer<typeof FailureSchema>;
// Older approvals remain readable. Only an unambiguous compatible action can
// be inferred for those rows; coordinator envelopes never substitute for an
// explicitly selected diagnostic result.
function correctionReplacement(batch:BatchApproval,failure:Failure):string|undefined{
 const compatible=batch.actions.filter(action=>action.kind===failure.kind&&action.kind!=='cleanup'&&action.probeId===failure.probeId);
 const selected=batch.correction?.replacementActionId;
 return selected?compatible.find(action=>action.id===selected)?.id:compatible.length===1?compatible[0].id:undefined;
}
type Entry = { batch: BatchApproval; action: CampaignAction;startedAt:number; result?: Usage; unknown: boolean };
type State = { identity: CampaignIdentity; target:QualificationTarget;targetHash: string; batches: BatchApproval[]; entries: Entry[]; fenced: boolean; reconciliationRequired: boolean;
 historical: z.infer<typeof Allowance>; correctionUsage: number; unsuccessfulCorrections: number; correctionRequired: boolean;failures:Failure[];historicalFailures:Failure[];continuedFailureIds:string[];executionLimits:z.infer<typeof CampaignExecutionLimitsSchema>;correctionIds:string[];accountingIds:string[];accountingSources:Set<string>;accountingPending:boolean;superseded:boolean; revision: number };
const zero = () => ({ actions: 0, activeMs: 0, outputBytes: 0 });
const equal = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b);
const clone = <T>(v: T): T => structuredClone(v);
function freeze<T>(v: T): Readonly<T> { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
const json = (v: unknown): z.infer<ReturnType<typeof z.json>> => JSON.parse(JSON.stringify(v));

/** V2 is an additive domain over the existing append-only qualification table.
 * Legacy v1 requests and their two-probe verifier retain their original rules.
 * Every separately dispatched process/auxiliary is an action; RPCs are charged
 * within its bounded process envelope. Reservations sum process lifetimes,
 * including concurrent services, rather than elapsed controller wall time. */
export class QualificationCampaign {
 // Ephemeral current-controller handles permit approved concurrent processes.
 // They are deliberately absent after restart; history cannot reconstruct them.
 readonly #inFlight = new Set<string>();
 readonly store:RunStore;
 readonly options:{now?:()=>number;authorizeCurrent(batch:Readonly<BatchApproval>,action:Readonly<CampaignAction>):boolean;authorizeAccounting?(receipt:Readonly<CampaignAccounting>):boolean;authorizeExecutionPolicy?(policy:Readonly<CampaignExecutionPolicy>):boolean};
 constructor(store: RunStore, options: { now?: () => number;
  authorizeCurrent(batch: Readonly<BatchApproval>, action: Readonly<CampaignAction>): boolean;authorizeAccounting?(receipt:Readonly<CampaignAccounting>):boolean;authorizeExecutionPolicy?(policy:Readonly<CampaignExecutionPolicy>):boolean }) {this.store=store;this.options=options;}
 #executionPolicy(identity:CampaignIdentity):CampaignExecutionPolicy|undefined{
  if(!identity.executionPolicy)return undefined;
  const policy=CampaignExecutionPolicySchema.parse(readAccountingEvidence(this.store,identity.owner.runId,identity.executionPolicy));
  if(policy.campaignId!==identity.id||!equal(policy.owner,identity.owner)||policy.storeRootHash!==identity.lineage.storeRootHash||policy.historyHash!==identity.lineage.historyHash||policy.targetHash!==identity.targetHash)throw Error('Execution allowance binding mismatch');
  return policy;
 }
 #now() { return (this.options.now ?? Date.now)(); }
 #append(owner: OwnerToken, campaignId: string, actionId: string, targetHash: string, kind: QualificationEnvelope['kind'], payload: unknown, revision: number,globalRevision?:number,pendingDispatchPayload?:ActionIntent['payload']): Result<void> {
  return this.store.appendQualification(owner, { schemaVersion: 1, id: randomUUID(), runId: owner.runId, generation: owner.generation, actionId, requestId: campaignId, targetHash, kind, payload: json(payload) }, revision,globalRevision,pendingDispatchPayload);
 }
 #metadata(owner: OwnerToken, campaignId: string, targetHash: string, kind: QualificationEnvelope['kind'], payload: unknown, revision: number,globalRevision?:number): Result<void> {
  const id = randomUUID(); const intended = this.store.intent(owner, { schemaVersion: 1, id, runId: owner.runId, kind, payload: { campaignId, targetHash } });
  if (!intended.ok) return intended;
  const appended = this.#append(owner, campaignId, id, targetHash, kind, payload, revision,globalRevision); if (!appended.ok) return appended;
  return this.store.outcome(owner, id, { schemaVersion: 1, status: 'RECONCILED', evidenceIds: [] });
 }
 #currentPending(actionId:string,s:State){
  const action=this.store.loadAction(actionId);if(!action.ok||action.value.state!=='INTENDED'||action.value.kind!=='PENDING_EXECUTION')return undefined;
  const parsed=PendingDispatchPayloadSchema.safeParse(action.value.payload);if(!parsed.success)return undefined;const {descriptor}=parsed.data;
  const parent=s.entries.find(entry=>entry.action.id===descriptor.parentActionId&&this.#inFlight.has(entry.action.id)&&!entry.result&&!entry.unknown);
  if(!parent||!equal(descriptor.owner,s.identity.owner)||descriptor.targetHash!==s.targetHash||parent.batch.targetHash!==s.targetHash||descriptor.actionId!==actionId||action.value.runId!==descriptor.owner.runId||action.value.generation!==descriptor.owner.generation||parsed.data.ownerHash!==fingerprint(descriptor.owner)||parsed.data.descriptorHash!==fingerprint(descriptor)||descriptor.launchHash!==fingerprint(descriptor.launch)||descriptor.launch.role!=='pending-canary'||descriptor.launch.authorization.kind!=='qualification'||descriptor.launch.authorization.probeId!=='auxiliary.preparation'||descriptor.launch.authorization.requestId!==parent.batch.id)return undefined;
  return {record:action.value,descriptor,parent};
 }
 /** Derived from the actual store, never from caller-supplied usage counters.
  * The anchor is part of the immutable approval. Foreign-store continuation is
  * refused; copying a target or changing run/repository UUIDs cannot reset it. */
 lineage(initialId:string):Result<z.infer<typeof CampaignLineageSchema>>{
  if(!IdSchema.safeParse(initialId).success)return storeError('INVALID_CAMPAIGN','Explicit initial campaign identity required');
  const rows=this.store.listQualifications();if(!rows.ok)return rows;
  try{const prior=rows.value.filter(r=>r.kind==='CAMPAIGN').at(-1);const rootId=prior?CampaignIdentitySchema.parse((prior.payload as {identity:unknown}).identity).lineage.rootId:initialId;
   return {ok:true,value:{storeRootHash:fingerprint(this.store.root),historyHash:fingerprint(rows.value),rootId}};
  }catch{return storeError('INVALID_LEDGER','Lineage is corrupt or unsupported');}
 }
 create(input: CampaignIdentity): Result<void> {
  const parsed = CampaignIdentitySchema.safeParse(input); if (!parsed.success || parsed.data.owner.generation < 1||targetFingerprint(parsed.data.target)!==parsed.data.targetHash) return storeError('INVALID_CAMPAIGN', 'Explicit versioned complete campaign identity required');
  const identity = parsed.data, records = this.store.listQualifications(); if (!records.ok) return records;
  const anchor=this.lineage(identity.id);if(!anchor.ok)return anchor;if(!equal(anchor.value,identity.lineage))return storeError('LINEAGE_CHANGED','Exact durable store history anchor required; foreign history is unsupported');
  if (records.value.some(r =>r.requestId===identity.id)) return storeError('CAMPAIGN_EXISTS', 'Existing campaign identities are immutable');
  const relevantRuns=new Set([identity.owner.runId,...records.value.map(r=>r.runId)]);
  for(const runId of relevantRuns){const recovered=this.store.reconcileEvidence(runId);if(!recovered.ok)return recovered;if(recovered.value.unknownActionIds.length)return storeError('RECOVERY_REQUIRED','Reconcile every historical owned action before campaign succession');}
  let historical = zero(); let correctionUsage = 0, unsuccessfulCorrections = 0;let failures:Failure[]=[],historicalFailures:Failure[]=[];let correctionIds:string[]=[];let accountingIds:string[]=[],accountingSources:string[]=[];let accountingPending=false;let incremental=records.value;
  const priorRow=records.value.filter(r=>r.kind==='CAMPAIGN').at(-1);
  if(priorRow){if(identity.supersedes!==priorRow.requestId)return storeError('CAMPAIGN_EXISTS','Explicit terminal campaign supersession required');const prior=this.#state(priorRow.requestId);if(!prior.ok)return prior;
   if(prior.value.entries.some(e=>!e.result)||prior.value.reconciliationRequired)return storeError('RECOVERY_REQUIRED','Prior campaign is not terminal');
   historical=this.#usage(prior.value).consumed;correctionUsage=prior.value.correctionUsage;unsuccessfulCorrections=prior.value.unsuccessfulCorrections;failures=clone(prior.value.failures);historicalFailures=clone(prior.value.historicalFailures);correctionIds=clone(prior.value.correctionIds);accountingIds=clone(prior.value.accountingIds);accountingSources=[...prior.value.accountingSources];accountingPending=prior.value.accountingPending;
   incremental=records.value.slice(records.value.indexOf(priorRow)+1);
  }else if(identity.supersedes||identity.lineage.rootId!==identity.id)return storeError('INVALID_LINEAGE','Initial campaign cannot claim an absent predecessor');
  // Import from immutable stored history, never caller-provided counters. All
  // targets/requests in the owned run count, including successful corrections.
  const legacyFailures=new Map<string,Failure>();const perRun=new Map<string,{activeMs:number;outputBytes:number;corrections:number}>();
  for (const row of incremental) {
   if (row.kind === 'ATTEMPT_INTENT') historical.actions++;
   if (row.kind !== 'ATTEMPT_RESULT') continue;
   const p = row.payload as { ordinal?: unknown;probeId?:string; observation?: { elapsedMs?: unknown; outputBytes?: unknown; status?: unknown;evidenceKind?:Usage['evidenceKind'];evidence?:Usage['evidence'] } };
   if (!p.observation || !count.safeParse(p.observation.elapsedMs).success || !count.safeParse(p.observation.outputBytes).success || !count.safeParse(p.ordinal).success)
    return storeError('INVALID_LEDGER', 'Historical accounting is not attributable');
   const runUsage=perRun.get(row.runId)??{activeMs:0,outputBytes:0,corrections:0};runUsage.activeMs+=p.observation.elapsedMs as number;runUsage.outputBytes+=p.observation.outputBytes as number;
   const key=fingerprint({target:row.targetHash,probeId:p.probeId??'legacy',kind:p.observation.evidenceKind??'fixture'});
   if(p.observation.status==='PASS')legacyFailures.delete(key);else {const failure:Failure={actionId:row.actionId,kind:p.probeId?'probe':'preparation',...(p.probeId?{probeId:p.probeId}:{}),evidenceKind:p.observation.evidenceKind??'fixture',evidence:p.observation.evidence};legacyFailures.set(key,failure);historicalFailures.push(failure);}
   if ((p.ordinal as number) > 0) {runUsage.corrections++;correctionIds.push(row.actionId);if (p.observation.status !== 'PASS') unsuccessfulCorrections++;}perRun.set(row.runId,runUsage);
  }
  if(!priorRow)for(const runId of relevantRuns)if(!perRun.has(runId))perRun.set(runId,{activeMs:0,outputBytes:0,corrections:0});
  for(const [runId,usage]of perRun){const run=this.store.loadRun(runId);if(!run.ok)return run;historical.activeMs+=Math.max(usage.activeMs,run.value.cumulativeBudgets.activeMs);historical.outputBytes+=Math.max(usage.outputBytes,run.value.cumulativeBudgets.outputBytes);correctionUsage+=Math.max(usage.corrections,run.value.repairCount);}
  failures.push(...legacyFailures.values());
  try{
   const policy=this.#executionPolicy(identity);
   if(policy){
    if(policy.limits.maxUnsuccessfulCorrections>unsuccessfulCorrections+2)throw Error('At most two additional unsuccessful corrections per allowance');
    if(policy.continuation){
     const prior=priorRow&&this.#state(priorRow.requestId);
     if(!prior||!prior.ok||policy.continuation.supersedesCampaignId!==identity.supersedes||policy.continuation.supersedesCampaignId!==prior.value.identity.id||policy.continuation.priorTargetHash!==prior.value.targetHash||policy.continuation.priorTargetHash===identity.targetHash||!equal([...policy.continuation.failedActionIds].sort(),failures.map(f=>f.actionId).sort())||new Set(policy.continuation.failedActionIds).size!==policy.continuation.failedActionIds.length)throw Error('Exact changed-target continuation required');
    }else if(policy.limits.maxUnsuccessfulCorrections>2)throw Error('Raised correction ceiling requires explicit changed-target continuation');
    if(this.options.authorizeExecutionPolicy?.(freeze(clone(policy)))!==true)return storeError('EXECUTION_POLICY_NOT_AUTHORIZED','Explicit protected human allowance and trusted authorization required');
   }
  }catch{return storeError('INVALID_EXECUTION_POLICY','Unchanged protected allowance, exact lineage and bounded continuation required');}
  return this.#metadata(identity.owner, identity.id, identity.targetHash, 'CAMPAIGN', { identity, historical, correctionUsage, unsuccessfulCorrections,failures,historicalFailures,correctionIds,accountingIds,accountingSources,accountingPending, historicalDigest: fingerprint(records.value) }, records.value.filter(r=>r.runId===identity.owner.runId).length,records.value.length);
 }
 #state(id: string): Result<State> {
  const records = this.store.listQualifications(); if (!records.ok) return records;
  try {
   const rows = records.value.filter(r => r.requestId === id), initial = rows.filter(r => r.kind === 'CAMPAIGN');
   if (initial.length !== 1) return storeError('CAMPAIGN_NOT_FOUND', 'One immutable v2 campaign required');
   const seed = z.strictObject({ identity: CampaignIdentitySchema, historical: Allowance, correctionUsage: count, unsuccessfulCorrections: count,failures:z.array(FailureSchema),historicalFailures:z.array(FailureSchema).optional().default([]),correctionIds:z.array(IdSchema),accountingIds:z.array(IdSchema).optional().default([]),accountingSources:z.array(z.string()).optional().default([]),accountingPending:z.boolean().optional().default(false), historicalDigest: HashSchema }).parse(initial[0].payload);
   if(targetFingerprint(seed.identity.target)!==seed.identity.targetHash)throw Error('Complete target mismatch');
   if(seed.identity.lineage.storeRootHash!==fingerprint(this.store.root)||seed.identity.lineage.historyHash!==seed.historicalDigest||fingerprint(records.value.slice(0,records.value.indexOf(initial[0])))!==seed.historicalDigest)throw Error('Durable lineage mismatch');
   const policy=this.#executionPolicy(seed.identity),continuedFailureIds=policy?.continuation?.failedActionIds??[];
   if(policy&&policy.limits.maxUnsuccessfulCorrections>seed.unsuccessfulCorrections+2||continuedFailureIds.some(id=>!seed.failures.some(f=>f.actionId===id)))throw Error('Invalid continuation allowance');
   const historicalFailures=[...new Map([...seed.historicalFailures,...seed.failures].map(f=>[f.actionId,f])).values()];
   const s: State = { ...seed,historicalFailures,continuedFailureIds,executionLimits:policy?.limits??defaultExecutionLimits(),target:seed.identity.target, targetHash: seed.identity.targetHash, batches: [], entries: [], fenced: false, reconciliationRequired: false, correctionRequired:seed.failures.length>0,accountingSources:new Set(seed.accountingSources),superseded:false, revision: records.value.filter(r => r.runId === seed.identity.owner.runId).length };const unsuccessfulCandidates=new Set<string>();const outstanding=new Map(seed.failures.filter(f=>!continuedFailureIds.includes(f.actionId)).map(f=>[f.actionId,f]));
   for (const row of rows) {
    if (row.runId !== seed.identity.owner.runId) throw Error('Run mismatch');
    if (row.kind === 'BATCH_APPROVAL') { const b = BatchApprovalSchema.parse(row.payload); if (b.campaignId !== id || b.targetHash !== s.targetHash || s.batches.some(prior => prior.id === b.id)) throw Error('Batch mismatch'); s.batches.push(b); if (b.correction){if(s.correctionIds.includes(b.correction.candidateId))throw Error('Correction replay');s.correctionUsage++;s.correctionIds.push(b.correction.candidateId);} }
    if (row.kind === 'CAMPAIGN_DISPATCH') {
     const p = z.strictObject({ batchId: IdSchema, action: CampaignActionSchema,startedAt:positive }).parse(row.payload), batch = s.batches.find(b => b.id === p.batchId);
     if (!batch || !batch.actions.some(a => equal(a, p.action)) || s.entries.some(e => e.action.id === p.action.id) || row.actionId !== p.action.id) throw Error('Dispatch mismatch');
     s.entries.push({ batch, action: p.action,startedAt:p.startedAt, unknown: false });
    }
    if (row.kind === 'CAMPAIGN_RESULT') {
     const p = z.strictObject({ batchId: IdSchema, actionId: IdSchema, usage: Usage }).parse(row.payload), e = s.entries.find(e => e.action.id === p.actionId && e.batch.id === p.batchId);
     if (!e || e.result) throw Error('Result mismatch'); e.result = p.usage;
     if (p.usage.status !== 'PASS') { s.fenced = true; s.correctionRequired = true;const failure={actionId:e.action.id,kind:e.action.kind,...(e.action.probeId?{probeId:e.action.probeId}:{}),evidenceKind:p.usage.evidenceKind,evidence:p.usage.evidence};outstanding.set(e.action.id,failure);s.historicalFailures.push(failure); if (e.batch.correction && e.action.kind !== 'cleanup'&&!unsuccessfulCandidates.has(e.batch.correction.candidateId)){s.unsuccessfulCorrections++;unsuccessfulCandidates.add(e.batch.correction.candidateId);} }
     else if(e.batch.correction){
      const affected=outstanding.get(e.batch.correction.affectedActionId);
       if(affected&&correctionReplacement(e.batch,affected)===e.action.id&&affected.evidenceKind===p.usage.evidenceKind)outstanding.delete(affected.actionId);
     }
    }
    if (row.kind === 'CAMPAIGN_FENCE') { s.fenced = true; const p = row.payload as { unknownActionId?: string }; if (p.unknownActionId) { const e = s.entries.find(e => e.action.id === p.unknownActionId); if (e) e.unknown = true; s.reconciliationRequired = true; } }
    if (row.kind === 'CAMPAIGN_RECONCILIATION') { const p = row.payload as { targetHash: string;target?:QualificationTarget }; if (!HashSchema.safeParse(p.targetHash).success||p.target&&targetFingerprint(p.target)!==p.targetHash||p.targetHash!==s.targetHash&&!p.target||s.identity.executionPolicy&&p.targetHash!==s.identity.targetHash) throw Error('Invalid reconciliation');if(p.target)s.target=QualificationTargetSchema.parse(p.target); s.targetHash = p.targetHash; s.fenced = false; s.reconciliationRequired = false; }
    if(row.kind==='CAMPAIGN_ACCOUNTING'){
     const ref=AccountingEvidenceSchema.parse(row.payload),receipt=CampaignAccountingSchema.parse(readAccountingEvidence(this.store,s.identity.owner.runId,ref));
     if(s.accountingIds.includes(receipt.id))throw Error('Accounting replay');
     const derived=deriveAccounting(this.store,records.value.slice(0,records.value.indexOf(row)),receipt,{campaignId:id,owner:s.identity.owner,targetHash:s.targetHash,failures:[...outstanding.values()],correctionIds:s.correctionIds,correctionUsage:s.correctionUsage,unsuccessfulCorrections:s.unsuccessfulCorrections,consumed:this.#usage(s).consumed,limits:s.executionLimits.campaignLimits,maxUnsuccessfulCorrections:s.executionLimits.maxUnsuccessfulCorrections,usedSources:s.accountingSources});
     for(const key of ['actions','activeMs','outputBytes'] as const)s.historical[key]+=derived.charges[key];
     s.correctionUsage+=derived.correctionIds.length;s.unsuccessfulCorrections+=derived.unsuccessful;s.correctionIds.push(...derived.correctionIds);s.accountingSources=derived.usedSources;s.accountingIds.push(receipt.id);s.accountingPending=!receipt.preparationComplete;
     for(const actionId of derived.resolvedActionIds)outstanding.delete(actionId);
    }
   }
   s.failures=[...outstanding.values()];s.correctionRequired=s.failures.length>0;
   s.superseded=records.value.some(row=>row.kind==='CAMPAIGN'&&row.requestId!==id&&(row.payload as {identity?:{supersedes?:string}}).identity?.supersedes===id);if(s.superseded)s.fenced=true;
   if (s.entries.some(e => !e.result && !this.#inFlight.has(e.action.id))) s.reconciliationRequired = true;
   const recovery=this.store.reconcileEvidence(seed.identity.owner.runId);if(!recovery.ok)return recovery;
   if(recovery.value.unknownActionIds.some(actionId=>!this.#inFlight.has(actionId)&&!this.#currentPending(actionId,s)))s.reconciliationRequired=true;
   return { ok: true, value: s };
  } catch { return storeError('INVALID_LEDGER', 'Campaign history is malformed; no migration or reset is permitted'); }
 }
 #usage(s: State) {
  const consumed = clone(s.historical), reserved = zero();
  for (const b of s.batches) for (const a of b.actions) {
   const e = s.entries.find(e => e.action.id === a.id);
   if (e?.result) { consumed.actions++; consumed.activeMs += e.result.elapsedMs; consumed.outputBytes += e.result.outputBytes; }
   else { reserved.actions++; reserved.activeMs += a.maxMs; reserved.outputBytes += a.maxOutputBytes; }
  }
  const limits=s.executionLimits.campaignLimits;
  const remaining = { actions: Math.max(0, limits.actions - consumed.actions - reserved.actions), activeMs: Math.max(0, limits.activeMs - consumed.activeMs - reserved.activeMs), outputBytes: Math.max(0, limits.outputBytes - consumed.outputBytes - reserved.outputBytes) };
  return { consumed, reserved, remaining };
 }
 snapshot(id: string) { const s = this.#state(id); return s.ok ? { ok: true as const, value: this.#publicSnapshot(s.value) } : s; }
 #publicSnapshot(s: State) { return { ...this.#usage(s),identity:clone(s.identity),executionLimits:clone(s.executionLimits),historicalFailures:clone(s.historicalFailures),continuedFailureIds:clone(s.continuedFailureIds),outstandingFailureIds:s.failures.map(f=>f.actionId),target:clone(s.target), targetHash: s.targetHash, fenced: s.fenced,superseded:s.superseded, reconciliationRequired: s.reconciliationRequired,accountingPending:s.accountingPending, correctionRequired:s.correctionRequired,correctionUsage: s.correctionUsage, unsuccessfulCorrections: s.unsuccessfulCorrections,accountingAdjustmentIds:clone(s.accountingIds) }; }
 /** Explicit reviewed accounting only. No dispatch, target change, budget reset
  * or probe PASS is conferred by resolving a historical corrective attempt. */
 reconcileAccounting(campaignId:string,approval:{owner:OwnerToken;evidence:AccountingEvidence}):Result<void>{
  const found=this.#state(campaignId);if(!found.ok)return found;const s=found.value;
  if(s.superseded||s.reconciliationRequired||s.entries.some(e=>!e.result)||this.#usage(s).reserved.actions||!equal(approval.owner,s.identity.owner))return storeError('RECOVERY_REQUIRED','Exact current owner and terminal campaign required for accounting');
  const records=this.store.listQualifications();if(!records.ok)return records;
  try{
   const ref=AccountingEvidenceSchema.parse(approval.evidence),receipt=CampaignAccountingSchema.parse(readAccountingEvidence(this.store,s.identity.owner.runId,ref));
   if(s.accountingIds.includes(receipt.id))throw Error('Accounting replay');
   deriveAccounting(this.store,records.value,receipt,{campaignId,owner:s.identity.owner,targetHash:s.targetHash,failures:s.failures,correctionIds:s.correctionIds,correctionUsage:s.correctionUsage,unsuccessfulCorrections:s.unsuccessfulCorrections,consumed:this.#usage(s).consumed,limits:s.executionLimits.campaignLimits,maxUnsuccessfulCorrections:s.executionLimits.maxUnsuccessfulCorrections,usedSources:s.accountingSources});
   if(this.options.authorizeAccounting?.(freeze(clone(receipt)))!==true)return storeError('ACCOUNTING_NOT_AUTHORIZED','Exact evidence-bound accounting review required');
   return this.#metadata(approval.owner,campaignId,s.targetHash,'CAMPAIGN_ACCOUNTING',ref,s.revision,records.value.length);
  }catch{return storeError('INVALID_ACCOUNTING_EVIDENCE','Complete protected evidence, unchanged lineage and conservative attributable bounds required');}
 }
 approve(input: BatchApproval): Result<void> {
  const parsed = BatchApprovalSchema.safeParse(input); if (!parsed.success) return storeError('INVALID_BATCH', 'Explicit bounded v2 approval required');
  const b = parsed.data, found = this.#state(b.campaignId); if (!found.ok) return found; const s = found.value, total = b.actions.reduce((n, a) => ({ actions: n.actions + 1, activeMs: n.activeMs + a.maxMs, outputBytes: n.outputBytes + a.maxOutputBytes }), zero());
  const remaining = this.#usage(s).remaining, usedIds = s.batches.flatMap(prior => prior.actions.map(a => a.id)),limits=s.executionLimits.batchLimits;
  const invalidClassification=b.actions.some(a=>{
   if(a.kind==='cleanup')return a.topLevel||!!a.auxiliaryFor||!!a.auxiliaryRole;
   if(!['preparation','endpoint'].includes(a.kind))return !a.topLevel||!!a.auxiliaryFor||!!a.auxiliaryRole;
   if(a.topLevel)return !!a.auxiliaryFor||!!a.auxiliaryRole;
   return !a.auxiliaryFor||!(a.kind==='endpoint'?a.auxiliaryRole==='endpoint':['guardian','controller'].includes(a.auxiliaryRole??''))||!b.actions.some(parent=>parent.id===a.auxiliaryFor&&parent.topLevel&&['startup','metadata','strict-positive','strict-negative','probe'].includes(parent.kind));
  });
  if (s.fenced || s.reconciliationRequired || s.accountingPending || s.entries.some(e=>!e.result)) return storeError('RECOVERY_REQUIRED', 'Campaign stopped, accounting incomplete or already executing; explicit reconciliation required after uncertainty');
  if (!equal(b.owner,s.identity.owner) || b.targetHash !== s.targetHash || !equal(b.remaining, remaining) || b.approvedAt > this.#now() || b.expiresAt <= this.#now() || b.expiresAt <= b.approvedAt || b.expiresAt - b.approvedAt > limits.approvalTtlMs ||
   invalidClassification||b.actions.filter(a => a.topLevel).length > limits.topLevelActions || total.activeMs > limits.activeMs || total.outputBytes > limits.outputBytes || total.actions > remaining.actions || total.activeMs > remaining.activeMs || total.outputBytes > remaining.outputBytes ||
   new Set(b.actions.map(a => a.id)).size !== b.actions.length || b.actions.some(a => usedIds.includes(a.id) || a.kind !== 'cleanup' && (!a.cleanupId || !b.actions.some(c => c.id === a.cleanupId && c.kind === 'cleanup')) || a.kind === 'cleanup' && (a.topLevel || a.cleanupId) || a.probeId && (a.kind !== 'probe' || !REQUIRED_CODEX_WINDOWS_PROBES.some(p => p.id === a.probeId))))
   return storeError('INVALID_BATCH', 'Scope, expiry, reserve, target or cumulative allowance mismatch');
  if (s.unsuccessfulCorrections >= s.executionLimits.maxUnsuccessfulCorrections || s.correctionRequired && !b.correction) return storeError('CORRECTION_APPROVAL_REQUIRED', 'Separate corrective approval required; unsuccessful corrections cannot exceed the explicit allowance');
   if (b.correction && (!s.failures.some(f=>f.actionId===b.correction!.affectedActionId&&b.correction!.evidenceIds.every(id=>f.evidence?.some(ref=>ref.id===id))&&!!correctionReplacement(b,f)) || s.correctionIds.includes(b.correction.candidateId))) return storeError('INVALID_CORRECTION', 'New affected corrective candidate, exact replacement action and evidence required');
  return this.#metadata(b.owner, b.campaignId, b.targetHash, 'BATCH_APPROVAL', b, s.revision);
 }
 #batch(id: string): Result<{ s: State; b: BatchApproval }> {
  const records = this.store.listQualifications(); if (!records.ok) return records; const row = records.value.find(r => r.kind === 'BATCH_APPROVAL' && (r.payload as { id?: string }).id === id);
  if (!row) return storeError('BATCH_NOT_FOUND', 'Exact approval missing'); const s = this.#state(row.requestId); if (!s.ok) return s; const b = s.value.batches.find(b => b.id === id)!; return { ok: true, value: { s: s.value, b } };
 }
 #fence(s: State, b: BatchApproval, reason: string, unknownActionId?: string): Result<void> { return this.#metadata(b.owner, s.identity.id, b.targetHash, 'CAMPAIGN_FENCE', { reason, ...(unknownActionId ? { unknownActionId } : {}) }, s.revision); }
 dispatch(batchId: string, raw: CampaignAction, current: { fixtureHash: string; endpointHash: string; targetHash: string; phase?: { intent: StartupIntent; admission: PhaseAdmission; owned?: OwnershipReceipt; observationHash?: string } }): Result<void> {
  const found = this.#batch(batchId); if (!found.ok) return found; const { s, b } = found.value, action = b.actions.find(a => a.id === raw.id);
  // A cleanup descriptor can only operate on the already owned execution. Its
  // exact stop/drain reservation survives ordinary launch-approval expiry; it
  // is not permission to create any new runtime or substitute another action.
  const terminalCleanup = action?.kind === 'cleanup' && b.actions.some(a => a.cleanupId === action.id && s.entries.some(e => e.action.id === a.id));
  let authorized = terminalCleanup; try { if (!authorized) authorized = !!action && this.options.authorizeCurrent(freeze(clone(b)), freeze(clone(action))) === true; } catch { /* uncertainty refuses */ }
  const phase = current.phase;
  const runtimeAction = action && ['startup','metadata','strict-positive','strict-negative','probe'].includes(action.kind);
  const phaseCurrent = () => !runtimeAction || !!phase && phase.admission.intentHash === fingerprintPhase(phase.intent) && action!.admissionHash === fingerprint(phase.admission) && phase.intent.dispatchHash===action!.launchHash&&phase.intent.requestId===b.id&&phase.intent.dispatchAuthorization.kind==='qualification'&&phase.intent.dispatchAuthorization.requestId===b.id&&phase.intent.dispatchAuthorization.probeId===(action!.probeId??(action!.kind==='strict-positive'?'auxiliary.strict-positive':action!.kind==='strict-negative'?'auxiliary.strict-negative':`auxiliary.${action!.kind}`))&&phase.intent.owner.actionId === action!.id && phase.intent.owner.runId === b.owner.runId && phase.intent.owner.generation === b.owner.generation && assessPhaseAdmission(phase.intent,phase.admission,this.#now(),phase.admission.phase,phase.owned,phase.observationHash).authorized;
  if (!action || !equal(action, raw) || !equal({ fixtureHash: current.fixtureHash, endpointHash: current.endpointHash, targetHash: current.targetHash }, { fixtureHash: b.fixtureHash, endpointHash: b.endpointHash, targetHash: b.targetHash }) || b.targetHash !== s.targetHash || !terminalCleanup && this.#now() >= b.expiresAt || !authorized || !phaseCurrent() || s.entries.some(e => e.action.id === raw.id) || (s.fenced || s.reconciliationRequired||s.correctionRequired&&!b.correction) && action.kind !== 'cleanup') {
   this.#fence(s, b, 'DISPATCH_AUTHORITY_REFUSED'); return storeError('EXECUTION_NOT_AUTHORIZED', 'Exact fresh action, owner, phase admission and launch required');
  }
  const existing=this.store.loadAction(action.id);let pendingPayload:ActionIntent['payload']|undefined;
  if(existing.ok){const pending=this.#currentPending(action.id,s);let bounded=false;if(pending)try{assertIntegralProcessBudget(this.#now(),pending.descriptor.launch.deadline,action.maxMs);bounded=true;}catch{/* The integral launch may not borrow its future cleanup reserve. */}if(!pending||!bounded||action.kind!=='preparation'||pending.parent.batch.id!==b.id||pending.descriptor.launchHash!==action.launchHash||pending.descriptor.launch.deadline<=this.#now()||pending.descriptor.launch.deadline>Math.min(b.expiresAt,this.#now()+action.maxMs)){this.#fence(s,b,'PENDING_ADOPTION_REFUSED');return storeError('EXECUTION_NOT_AUTHORIZED','Only a current exact approved bounded pending child may be adopted');}pendingPayload=existing.value.payload;}
  else {if(existing.error.code!=='ACTION_NOT_FOUND')return existing;const intended = this.store.intent(b.owner, { schemaVersion: 1, id: action.id, runId: b.owner.runId, kind: 'CAMPAIGN_ACTION', payload: { campaignId: b.campaignId, batchId, launchHash: action.launchHash, admissionHash: action.admissionHash } }); if (!intended.ok) return intended;}
  const appended = this.#append(b.owner, b.campaignId, action.id, b.targetHash, 'CAMPAIGN_DISPATCH', { batchId, action,startedAt:this.#now() }, s.revision,undefined,pendingPayload); if (!appended.ok) return appended;
  // The durable intent is still owned by this controller while its final
  // authority callback inspects the store. A different controller has no such
  // in-memory handle and continues to require reconciliation after a crash.
  this.#inFlight.add(action.id);
  // Repeat at the actual store dispatch boundary. A callback is responsible for
  // obtaining current typed phase admission; historical approvals never suffice.
  try { if (!terminalCleanup && (this.#now() >= b.expiresAt || !phaseCurrent() || this.options.authorizeCurrent(freeze(clone(b)), freeze(clone(action))) !== true)) { this.unknown(batchId, action.id); return storeError('EXECUTION_NOT_AUTHORIZED', 'Current phase admission expired before dispatch'); } } catch { this.unknown(batchId, action.id); return storeError('EXECUTION_NOT_AUTHORIZED', 'Current authority unavailable'); }
  if(pendingPayload!==undefined)return {ok:true,value:undefined};
  const dispatched = this.store.dispatch(b.owner, action.id);
  if(!dispatched.ok){this.unknown(batchId,action.id);return dispatched;}
  return {ok:true,value:undefined};
 }
 finish(batchId: string, actionId: string, input: Usage): Result<void> {
  const found = this.#batch(batchId); if (!found.ok) return found; const { s, b } = found.value, e = s.entries.find(e => e.batch.id === batchId && e.action.id === actionId), parsed = Usage.safeParse(input);
  if (!e || e.result || !parsed.success) return storeError('INVALID_RESULT', 'One attributable result per dispatch required');
  const action = this.store.loadAction(actionId); if (!action.ok) return action;
  if(parsed.success)parsed.data.elapsedMs=Math.max(parsed.data.elapsedMs,this.#now()-e.startedAt);
  if (action.value.state !== 'DISPATCHED' || e.unknown || parsed.data.elapsedMs > e.action.maxMs || parsed.data.outputBytes > e.action.maxOutputBytes) { this.unknown(batchId, actionId); return storeError('RECOVERY_REQUIRED', 'Unknown or exceeded action remains fully reserved'); }
  // Store outcome precedes release of the campaign reservation. A crash between
  // these writes leaves the conservative reservation and needs reconciliation;
  // it can never make an unresolved process appear free in campaign accounting.
  const outcome = this.store.outcome(b.owner, actionId, { schemaVersion: 1, status: parsed.data.status === 'PASS' ? 'SUCCEEDED' : 'FAILED', evidenceIds: parsed.data.evidence?.map(ref=>ref.id)??[] }); if (!outcome.ok) return outcome;
  const appended=this.#append(b.owner, b.campaignId, actionId, b.targetHash, 'CAMPAIGN_RESULT', { batchId, actionId, usage: parsed.data }, s.revision);this.#inFlight.delete(actionId);return appended;
 }
 unknown(batchId: string, actionId: string): Result<void> {
  const found = this.#batch(batchId); if (!found.ok) return found; const { s, b } = found.value;
  if (!s.entries.some(e => e.action.id === actionId && !e.result)) return storeError('INVALID_ACTION', 'Unresolved owned action required');
  const action = this.store.loadAction(actionId); if (!action.ok) return action;
  if (action.value.state === 'INTENDED' || action.value.state === 'DISPATCHED') { const unknown = this.store.unknown(b.owner, actionId); if (!unknown.ok) return unknown; }
  this.#inFlight.delete(actionId);
  return this.#fence(s, b, 'OUTCOME_UNKNOWN', actionId);
 }
 /** Explicit controller recovery consumes independently persisted observations;
  * it records a known outcome only, and never dispatches the operation again. */
 resolveUnknown(batchId:string,actionId:string,approval:{id:string;evidence:Array<{id:string;sha256:string}>}):Result<void>{
  const found=this.#batch(batchId);if(!found.ok)return found;const {s,b}=found.value,e=s.entries.find(e=>e.batch.id===batchId&&e.action.id===actionId);
  if(!e||e.result||!IdSchema.safeParse(approval.id).success||!approval.evidence.length)return storeError('RECOVERY_REQUIRED','Unresolved action and explicit recovery evidence required');
  let usage:Usage|undefined;
  try{for(const ref of approval.evidence){const artifact=this.store.loadArtifact(ref.id);if(!artifact.ok||artifact.value.runId!==b.owner.runId||artifact.value.actionId!==actionId||artifact.value.sha256!==ref.sha256||artifact.value.truncated||artifact.value.producerStopRequired)throw Error('Invalid recovery artifact');
   const bytes=readFileSync(join(this.store.root,'artifacts',ref.sha256));if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('Invalid recovery bytes');
   const p=z.strictObject({schemaVersion:z.literal(2),kind:z.literal('campaign-recovery'),campaignId:IdSchema,batchId:IdSchema,actionId:IdSchema,launchHash:HashSchema,targetHash:HashSchema,owner:OwnerTokenSchema,
    reconciled:z.literal(true),rootExited:z.literal(true),outputComplete:z.literal(true),membershipEmpty:z.literal(true),brokersReconciled:z.literal(true),observation:RecoveryObservation,usage:Usage}).parse(JSON.parse(bytes.toString('utf8')));
   if(p.campaignId!==b.campaignId||p.batchId!==batchId||p.actionId!==actionId||p.launchHash!==e.action.launchHash||p.targetHash!==b.targetHash||!equal(p.owner,b.owner)||usage&&!equal(usage,p.usage))throw Error('Recovery binding mismatch');usage=p.usage;
   const expected=e.action.kind==='cleanup'?s.entries.filter(parent=>parent.batch.id===batchId&&parent.action.cleanupId===actionId).map(parent=>parent.action):[e.action];
   const observations=p.observation.kind==='cleanup-topology'?p.observation.members:[p.observation];
   if(!expected.length||observations.length!==expected.length)throw Error('Recovery topology incomplete');
   const seen=new Set<string>();let minimumMs=0,minimumOutput=0,conservative=false,rawProven=true;
   for(const observation of observations){const owner=observation.kind==='owned-execution'?observation.ownership:observation.owner;
    const approved=expected.find(action=>action.id===owner.actionId);if(!approved||seen.has(owner.actionId)||owner.runId!==b.owner.runId||owner.generation!==b.owner.generation||observation.launchHash!==approved.launchHash)throw Error('Recovery creation owner mismatch');seen.add(owner.actionId);
    if(observation.kind==='owned-execution'){
     if(approved.kind==='preparation'||!isTerminalDrained(observation.terminal,observation.ownership,approved.probeId??''))throw Error('Actual complete terminal evidence required');
     const outer=QualificationTerminalSchema.safeParse(observation.terminal);
     const meters=outer.success&&!outer.data.processMeterError?outer.data.processMeters.filter(m=>m.kind==='root'||m.kind==='helper').map(m=>({kind:m.kind as 'root'|'helper',identity:m.identity,activeMs:m.activeMs})):observation.processMeters;
     if(!meters||meters.length!==2||new Set(meters.map(m=>m.kind)).size!==2)conservative=true;
     else for(const meter of meters){const pid=meter.kind==='root'?observation.ownership.pid:observation.ownership.helperPid,creation=meter.kind==='root'?observation.ownership.creationIdentity:observation.ownership.helperCreationIdentity;if(meter.identity.pid!==pid||meter.identity.creationIdentity!==creation)throw Error('Recovery process meter mismatch');minimumMs+=meter.activeMs;}
     if(outer.success)minimumOutput+=outer.data.totalRawBytes;else rawProven=false;
    }else{
     if(approved.kind!=='preparation'||!approved.auxiliaryRole||owner.role!==`qualification-${approved.auxiliaryRole}`||observation.completedAt<observation.createdAt||observation.completedAt>this.#now())throw Error('Actual auxiliary exit evidence required');
     minimumMs+=Math.max(observation.activeMs,observation.completedAt-observation.createdAt);rawProven=false;
    }
   }
   if(conservative){usage.elapsedMs=Math.max(usage.elapsedMs,e.action.maxMs);usage.outputBytes=Math.max(usage.outputBytes,e.action.maxOutputBytes);usage.status='FAIL';}
   else {usage.elapsedMs=Math.max(usage.elapsedMs,minimumMs);usage.outputBytes=Math.max(usage.outputBytes,minimumOutput);}
   if(!rawProven)usage.outputBytes=Math.max(usage.outputBytes,e.action.maxOutputBytes);
   if(usage.elapsedMs>e.action.maxMs||usage.outputBytes>e.action.maxOutputBytes)usage.status='FAIL';
  }}catch{return storeError('INVALID_RECOVERY_EVIDENCE','Exact protected recovery observations required');}
  if(!usage)return storeError('INVALID_RECOVERY_EVIDENCE','Recovery usage missing');
  const action=this.store.loadAction(actionId);if(!action.ok)return action;
  if(action.value.state!=='OBSERVED'){const reconciled=this.store.outcome(b.owner,actionId,{schemaVersion:1,status:'RECONCILED',evidenceIds:approval.evidence.map(ref=>ref.id)});if(!reconciled.ok)return reconciled;}
  return this.#append(b.owner,b.campaignId,actionId,b.targetHash,'CAMPAIGN_RESULT',{batchId,actionId,usage},s.revision);
 }
 reconcile(campaignId: string, approval: { id: string; owner: OwnerToken; evidenceIds: string[]; targetHash: string;target?:QualificationTarget }): Result<void> {
  const found = this.#state(campaignId); if (!found.ok) return found; const s = found.value;
  if(s.identity.executionPolicy&&approval.targetHash!==s.identity.targetHash)return storeError('EXECUTION_POLICY_TARGET_CHANGED','Changed target requires a separately authorized immutable continuation');
  if (!IdSchema.safeParse(approval.id).success || !HashSchema.safeParse(approval.targetHash).success || !approval.evidenceIds.length || approval.evidenceIds.some(id => !IdSchema.safeParse(id).success) || s.entries.some(e => !e.result)||approval.target&&(!QualificationTargetSchema.safeParse(approval.target).success||targetFingerprint(approval.target)!==approval.targetHash)||approval.targetHash!==s.targetHash&&!approval.target) return storeError('RECOVERY_REQUIRED', 'Resolve every owned action with independently retained evidence and complete target first');
  const recovery = this.store.reconcileEvidence(approval.owner.runId); if (!recovery.ok) return recovery;
  if (recovery.value.unknownActionIds.length || approval.owner.runId !== s.identity.owner.runId) return storeError('RECOVERY_REQUIRED', 'Store reconciliation remains incomplete');
  return this.#metadata(approval.owner, campaignId, approval.targetHash, 'CAMPAIGN_RECONCILIATION', approval, s.revision);
 }
 /** Aggregate catalog evidence only for a complete compatible target and class.
  * Auxiliary actions never increase the 32-probe count. */
 aggregate(campaignId: string) {
  const state = this.#state(campaignId); if (!state.ok) return state;
  return { ok: true as const, value: REQUIRED_CODEX_WINDOWS_PROBES.map(probe => {
   const entries = state.value.entries.filter(e => e.batch.targetHash === state.value.targetHash && e.action.probeId === probe.id);
   const latest = entries.at(-1); const refs = latest?.result?.evidence ?? [];let operationProven=false;
   const valid = latest && latest.action.kind === 'probe' && latest.result?.evidenceKind === probe.evidenceKind && probe.evidenceCategories.every(category => refs.some(ref => ref.category === category)) && refs.length > 0 && refs.every(ref => {
    const artifact = this.store.loadArtifact(ref.id); if (!artifact.ok || artifact.value.runId !== latest.batch.owner.runId || artifact.value.actionId !== latest.action.id || artifact.value.sha256 !== ref.sha256 || artifact.value.truncated || artifact.value.producerStopRequired) return false;
    try { const bytes=readFileSync(join(this.store.root,'artifacts',ref.sha256));if(bytes.length!==artifact.value.storedBytes||createHash('sha256').update(bytes).digest('hex')!==ref.sha256)return false;
     if(ref.category==='operation'){const proof=CampaignProbeEvidenceSchema.safeParse(JSON.parse(bytes.toString('utf8')));if(!proof.success||proof.data.targetHash!==latest.batch.targetHash||proof.data.probeId!==probe.id||proof.data.role!==probe.role||proof.data.launchHash!==latest.action.launchHash||proof.data.status!==latest.result!.status||proof.data.evidenceKind!==probe.evidenceKind||!proof.data.actualAttempt)return false;operationProven=true;}return true;
    }catch{return false;}
   });
   return { id: probe.id, status: valid&&operationProven ? latest.result!.status : 'UNTESTED', actionIds: entries.map(e => e.action.id) };
  }) };
 }
}
import { startupTargetHash as fingerprintPhase } from './codex-startup-authority.ts';
