import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {isUnlimited,type CampaignRemaining} from './campaign-policy.ts';
import {HashSchema, IdSchema} from '../contracts/common.ts';
import {OwnerTokenSchema} from '../contracts/evidence.ts';
import type {QualificationEnvelope, RunStore} from '../store/database.ts';
import {fingerprint} from './probes.ts';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AccountingEvidenceSchema=z.strictObject({id:IdSchema,sha256:HashSchema});
export type AccountingEvidence=z.infer<typeof AccountingEvidenceSchema>;
export const CampaignAccountingSchema=z.strictObject({schemaVersion:z.literal(2),kind:z.literal('campaign-accounting'),id:IdSchema,campaignId:IdSchema,
 owner:OwnerTokenSchema,storeRootHash:HashSchema,historyHash:HashSchema,targetHash:HashSchema,
 repairs:z.array(z.strictObject({id:IdSchema,failedActionId:IdSchema,replacementActionIds:z.array(IdSchema).min(1).max(96),approvalEvidence:AccountingEvidenceSchema,resultEvidence:AccountingEvidenceSchema})).max(2),
 preparation:z.array(AccountingEvidenceSchema).max(96),historicalExecutions:z.array(AccountingEvidenceSchema).max(1024).optional(),preparationComplete:z.boolean()});
export type CampaignAccounting=z.infer<typeof CampaignAccountingSchema>;
export const PreparationAccountingObservationSchema=z.strictObject({schemaVersion:z.literal(2),kind:z.literal('campaign-preparation-observation'),operationId:IdSchema,storeRootHash:HashSchema,
 category:z.enum(['fixture-preparation','auxiliary-execution','cleanup','build']),scope:z.string().min(1),classificationEvidence:AccountingEvidenceSchema,
 sourceEvidence:z.array(AccountingEvidenceSchema).min(1),exclusions:z.array(z.strictObject({scope:z.string().min(1),reason:z.string().min(1),evidence:AccountingEvidenceSchema})),
 processes:z.array(z.strictObject({createdAt:count,completedAt:count})).min(1).max(96),processTreeComplete:z.literal(true),rawOutputBytes:count,outputComplete:z.literal(true)});
const HistoricalProcessSchema=z.strictObject({kind:z.enum(['root','helper','standalone','descendant']),pid:count.positive(),creationIdentity:z.string().min(1).max(256),createdAt:count,completedAt:count});
/** Historical costs remain costs rather than qualification proof. Integral
 * root/helper pairs count as one dispatched action; every process lifetime is
 * still charged. A source-backed upper bound never asserts raw observation. */
export const HistoricalExecutionAccountingObservationSchema=z.strictObject({schemaVersion:z.literal(2),kind:z.literal('campaign-historical-execution-observation'),operationId:IdSchema,storeRootHash:HashSchema,
 category:z.enum(['functional-execution','outer-controller','auxiliary-execution','fixture-preparation','cleanup']),scope:z.string().min(1).max(4096),
 classificationEvidence:AccountingEvidenceSchema,sourceEvidence:z.array(AccountingEvidenceSchema).min(1).max(1024),exclusions:z.array(z.strictObject({scope:z.string().min(1),reason:z.string().min(1),evidence:AccountingEvidenceSchema})).max(1024),
 accountingMode:z.enum(['measured','conservative-upper-bound']),rawOutputBytes:count,rawOutputComplete:z.boolean(),outputAccountingComplete:z.literal(true),processTreeComplete:z.literal(true),
 groups:z.array(z.strictObject({actionId:IdSchema,kind:z.enum(['integral','standalone']),processes:z.array(HistoricalProcessSchema).min(1).max(1024)})).min(1).max(1024),
}).superRefine((observation,ctx)=>{
 const actions=new Set<string>(),processes=new Set<string>();
 if(observation.accountingMode==='measured'&&!observation.rawOutputComplete||observation.accountingMode==='conservative-upper-bound'&&observation.rawOutputBytes===0)ctx.addIssue({code:'custom',message:'Complete measured output or a positive attributable upper bound required'});
 for(const group of observation.groups){
  if(actions.has(group.actionId))ctx.addIssue({code:'custom',message:'Historical action replay'});actions.add(group.actionId);
  const kinds=group.processes.map(process=>process.kind);
  if(group.kind==='integral'&&(kinds.filter(kind=>kind==='root').length!==1||kinds.filter(kind=>kind==='helper').length!==1||kinds.includes('standalone'))||group.kind==='standalone'&&(kinds.filter(kind=>kind==='standalone').length!==1||kinds.includes('root')||kinds.includes('helper')))ctx.addIssue({code:'custom',message:'Complete typed process topology required'});
  for(const process of group.processes){const identity=fingerprint({pid:process.pid,creationIdentity:process.creationIdentity});if(processes.has(identity)||process.completedAt<process.createdAt)ctx.addIssue({code:'custom',message:'Unique process identities and valid complete intervals required'});processes.add(identity);}
 }
});
export type HistoricalExecutionAccountingObservation=z.infer<typeof HistoricalExecutionAccountingObservationSchema>;
// These are supported historical document formats, not vendor certificates.
const HistoricalApproval=z.object({userInstruction:z.string().min(1),approvedHash:HashSchema,fixtureRoot:z.string().min(1),coordinatorCorrectiveAttempt:count.positive().max(2),
 correctiveLimit:z.literal(2),priorFailedRequestId:IdSchema,noAutomaticRetry:z.literal(true),stopAfterSlice:z.literal(true)});
const HistoricalResult=z.object({launched:z.literal(true),sealHash:HashSchema,requestId:IdSchema,passed:z.boolean(),report:z.object({targetHash:HashSchema}),outcome:z.object({probes:z.array(z.object({probeId:z.string(),status:z.enum(['PASS','FAIL','UNTESTED'])})).min(1)})});

/** Only immutable, complete, run-owned controller artifacts are accepted. The
 * controller must separately authorize the exact parsed receipt after review. */
function accountingBytes(store:RunStore,runId:string,ref:AccountingEvidence):Buffer{
 const artifact=store.loadArtifact(ref.id);if(!artifact.ok||artifact.value.runId!==runId||artifact.value.actionId!==null||artifact.value.sha256!==ref.sha256||artifact.value.truncated||artifact.value.producerStopRequired||artifact.value.redactionApplied)throw Error('Invalid accounting artifact');
 const bytes=readFileSync(join(store.root,'artifacts',ref.sha256));if(bytes.length!==artifact.value.storedBytes||createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('Invalid accounting bytes');
 return bytes;
}
export function readAccountingEvidence(store:RunStore,runId:string,ref:AccountingEvidence):unknown{return JSON.parse(accountingBytes(store,runId,ref).toString('utf8'));}
type Context={campaignId:string;owner:z.infer<typeof OwnerTokenSchema>;targetHash:string;failures:Array<{actionId:string}>;correctionIds:string[];correctionUsage:number;unsuccessfulCorrections:number;consumed:{actions:number;activeMs:number;outputBytes:number};limits:CampaignRemaining;maxUnsuccessfulCorrections?:number;usedSources:Set<string>};
export function deriveAccounting(store:RunStore,rows:QualificationEnvelope[],receipt:CampaignAccounting,context:Context){
 if(receipt.campaignId!==context.campaignId||fingerprint(receipt.owner)!==fingerprint(context.owner)||receipt.targetHash!==context.targetHash||receipt.storeRootHash!==fingerprint(store.root)||receipt.historyHash!==fingerprint(rows))throw Error('Accounting binding mismatch');
 const historical=receipt.historicalExecutions??[];
 if(!receipt.repairs.length&&!receipt.preparation.length&&!historical.length||receipt.preparationComplete&&!receipt.preparation.length&&!historical.length)throw Error('Empty or unsupported complete preparation adjustment');
 const used=new Set(context.usedSources),resolvedActionIds:string[]=[],correctionIds:string[]=[];let unsuccessful=0;
 const consume=(key:string)=>{if(used.has(key))throw Error('Accounting source replay');used.add(key);};
 const charges={actions:0,activeMs:0,outputBytes:0};
 for(const repair of receipt.repairs){
  if(context.correctionIds.includes(repair.id)||correctionIds.includes(repair.id))throw Error('Correction replay');
  consume(`failure:${repair.failedActionId}`);consume(`approval:${repair.approvalEvidence.sha256}`);consume(`result:${repair.resultEvidence.sha256}`);
  if(!context.failures.some(f=>f.actionId===repair.failedActionId))throw Error('Outstanding historical failure required');
  const failed=rows.find(r=>r.kind==='ATTEMPT_RESULT'&&r.actionId===repair.failedActionId);if(!failed)throw Error('Historical failure missing');
  const failure=z.object({ordinal:z.literal(0),probeId:z.string(),observation:z.object({status:z.enum(['FAIL','UNTESTED']),evidenceKind:z.literal('live')})}).parse(failed.payload);
  const approval=HistoricalApproval.parse(readAccountingEvidence(store,context.owner.runId,repair.approvalEvidence));
  const result=HistoricalResult.parse(readAccountingEvidence(store,context.owner.runId,repair.resultEvidence));
  if(approval.priorFailedRequestId!==failed.requestId||approval.approvedHash!==result.sealHash||approval.coordinatorCorrectiveAttempt!==context.correctionUsage+correctionIds.length+1)throw Error('Historical approval mismatch');
  const replacements=rows.filter(r=>r.kind==='ATTEMPT_RESULT'&&r.requestId===result.requestId);
  const request=rows.find(r=>r.kind==='REQUEST'&&r.requestId===result.requestId);
  const requestPayload=z.object({request:z.object({fixtureRoots:z.array(z.string())})}).parse(request?.payload);
  if(!requestPayload.request.fixtureRoots.includes(approval.fixtureRoot)||result.requestId===failed.requestId||replacements.length!==repair.replacementActionIds.length||new Set(repair.replacementActionIds).size!==replacements.length||replacements.some(r=>!repair.replacementActionIds.includes(r.actionId)||r.targetHash!==result.report.targetHash||r.targetHash!==request!.targetHash||r.runId!==request!.runId||r.generation!==request!.generation)||new Set(result.outcome.probes.map(p=>p.probeId)).size!==replacements.length)throw Error('Historical replacement mismatch');
  let successful=true,affected=false;
  for(const replacement of replacements){
   consume(`replacement:${replacement.actionId}`);
   const p=z.object({ordinal:z.literal(0),probeId:z.string(),observation:z.object({status:z.enum(['PASS','FAIL','UNTESTED']),evidenceKind:z.literal('live'),actualAttempt:z.literal(true)})}).parse(replacement.payload);
   if(!result.outcome.probes.some(probe=>probe.probeId===p.probeId&&probe.status===p.observation.status))throw Error('Result does not corroborate ledger');
   successful&&=p.observation.status==='PASS';affected||=p.probeId===failure.probeId&&p.observation.status==='PASS';
  }
  if(result.passed!==successful||result.outcome.probes.length!==replacements.length)throw Error('Result status mismatch');
  if(successful&&affected)resolvedActionIds.push(repair.failedActionId);else unsuccessful++;
  correctionIds.push(repair.id);
 }
 for(const ref of receipt.preparation){
  consume(`preparation:${ref.sha256}`);const observation=PreparationAccountingObservationSchema.parse(readAccountingEvidence(store,context.owner.runId,ref));
  consume(`operation:${observation.operationId}`);if(observation.storeRootHash!==receipt.storeRootHash)throw Error('Foreign preparation');
  accountingBytes(store,context.owner.runId,observation.classificationEvidence);
  for(const source of observation.sourceEvidence){consume(`preparation-source:${source.sha256}`);accountingBytes(store,context.owner.runId,source);}
  for(const exclusion of observation.exclusions)accountingBytes(store,context.owner.runId,exclusion.evidence);
  charges.actions+=observation.processes.length;charges.outputBytes+=observation.rawOutputBytes;
  for(const process of observation.processes){if(process.completedAt<process.createdAt)throw Error('Invalid process bound');charges.activeMs+=process.completedAt-process.createdAt;}
 }
 for(const ref of historical){
  consume(`historical-execution:${ref.sha256}`);const observation=HistoricalExecutionAccountingObservationSchema.parse(readAccountingEvidence(store,context.owner.runId,ref));
  consume(`operation:${observation.operationId}`);if(observation.storeRootHash!==receipt.storeRootHash)throw Error('Foreign historical accounting');
  accountingBytes(store,context.owner.runId,observation.classificationEvidence);
  for(const source of observation.sourceEvidence){consume(`preparation-source:${source.sha256}`);accountingBytes(store,context.owner.runId,source);}
  for(const exclusion of observation.exclusions)accountingBytes(store,context.owner.runId,exclusion.evidence);
  charges.actions+=observation.groups.length;charges.outputBytes+=observation.rawOutputBytes;
  for(const group of observation.groups){
   if(rows.some(row=>row.actionId===group.actionId&&['ATTEMPT_INTENT','CAMPAIGN_DISPATCH'].includes(row.kind)))throw Error('Historical action already charged in the ledger');
   consume(`historical-action:${group.actionId}`);
   for(const process of group.processes){consume(`historical-process:${fingerprint({pid:process.pid,creationIdentity:process.creationIdentity})}`);charges.activeMs+=process.completedAt-process.createdAt;}
  }
 }
 for(const key of ['actions','activeMs','outputBytes'] as const)if(!Number.isSafeInteger(charges[key])||!Number.isSafeInteger(context.consumed[key]+charges[key])||(!isUnlimited(context.limits)&&context.consumed[key]+charges[key]>context.limits[key]))throw Error('Accounting exceeds allowance');
 if(context.unsuccessfulCorrections+unsuccessful>(context.maxUnsuccessfulCorrections??2))throw Error('Correction ceiling exceeded');
 return {charges,correctionIds,unsuccessful,resolvedActionIds,usedSources:used};
}
