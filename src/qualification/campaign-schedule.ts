import {isUnlimited,remainingAllowance,type CampaignRemaining} from './campaign-policy.ts';
import type { Result } from '../contracts/common.ts';
import { HashSchema,IdSchema } from '../contracts/common.ts';
import { CampaignActionSchema,CAMPAIGN_LIMITS,CAMPAIGN_BATCH_LIMITS,CampaignExecutionLimitsSchema,type CampaignAction } from './campaign.ts';
import type {z} from 'zod';
import { campaignRecipeHash,cleanupRecipeHash,type CampaignRecipe } from './campaign-runner.ts';
import { REQUIRED_CODEX_WINDOWS_PROBES,fingerprint } from './probes.ts';
import { requiredIntegralProcessMs,requiredStandaloneProcessMs,SUPERVISOR_DRAIN_TAIL_MS,OBSERVER_TERMINAL_FLUSH_MS } from './process-budget.ts';

export type CampaignCost={actions:number;activeMs:number;outputBytes:number};
export type CampaignRetainedState={historyHash:string;lineageHash:string;targetHash:string;consumed:CampaignCost;reserved:CampaignCost;
 correctionUsage:number;unsuccessfulCorrections:number;correctionRequired:boolean;
 externalLiabilities:Array<{id:string;bounds?:CampaignCost}>};
export type ScheduleEnvelope={kind:'preparation'|'control-positive'|'control-negative'|'diagnostic'|'outer-coordinator';targetHash:string;launchHash:string};
export type ScheduledAction={action:CampaignAction;recipe?:CampaignRecipe;envelope?:ScheduleEnvelope;
 process?:{kind:'integral'|'standalone';runtimeMs:number};startOffsetMs:number};
/** A group is one complete resource lifetime. Sharing a service/cleanup across
 * groups is refused: approval waits cannot turn its process time into free time. */
export type CampaignScheduleGroup={id:string;batchId:string;dependsOn:string[];wallMs:number;actions:ScheduledAction[]};
export type CampaignScheduleInput={targetHash:string;supersedesTargetHash?:string;retained:CampaignRetainedState;approvalTtlMs:number;groups:CampaignScheduleGroup[];
 proposedExecutionLimits?:z.infer<typeof CampaignExecutionLimitsSchema>;
 prerequisites:{preparationActionIds:string[];diagnosticActionIds:string[];metadataActionIds:string[];strictPositiveActionId:string;strictNegativeActionId:string;
 coordinatorActionIds:string[];startupEvidence:{coverageHash:string;targetHash:string;actionIds:string[]}}};
export type CampaignScheduleDeficit={scope:string;resource:keyof CampaignCost|'topLevelActions'|'approvalMs';required:number;available:number;deficit:number};
export type CampaignScheduleBatch={id:string;groupIds:string[];actionIds:string[];dependencies:string[];cleanupReservedFirst:string[];topLevelActions:number;wallMs:number;approvalTtlMs:number;cost:CampaignCost};
export type CampaignSchedule={schemaVersion:1;targetHash:string;retainedHash:string;inputHash:string;executionLimits?:z.infer<typeof CampaignExecutionLimitsSchema>;bill:Array<ScheduledAction&{groupId:string;catalogCredit:boolean;processes:Array<{identity:string;kind:'root'|'helper'|'standalone';maxMs:number}>}>;
 batches:CampaignScheduleBatch[];cost:CampaignCost;batchDeficits:CampaignScheduleDeficit[]};
export type CampaignFeasibility={fits:boolean;reasons:string[];remaining:CampaignRemaining;required:CampaignCost;deficits:CampaignScheduleDeficit[]};
const zero=():CampaignCost=>({actions:0,activeMs:0,outputBytes:0});
const count=(value:number)=>Number.isSafeInteger(value)&&value>=0;
const cost=(value:CampaignCost)=>value&&Object.keys(value).sort().join()==='actions,activeMs,outputBytes'&&Object.values(value).every(count);
const add=(a:CampaignCost,b:CampaignCost):CampaignCost=>{const result={actions:a.actions+b.actions,activeMs:a.activeMs+b.activeMs,outputBytes:a.outputBytes+b.outputBytes};if(!cost(result))throw Error('COST_OVERFLOW');return result;};
const total=(actions:ScheduledAction[])=>actions.reduce((sum,entry)=>add(sum,{actions:1,activeMs:entry.action.maxMs,outputBytes:entry.action.maxOutputBytes}),zero());
function fail():Result<never>{return {ok:false,error:{code:'INVALID_CAMPAIGN_SCHEDULE',message:'Complete exact topology, process bounds and retained history required',evidenceIds:[]}};}
function retainedValid(state:CampaignRetainedState):boolean{return !!state&&[state.historyHash,state.lineageHash,state.targetHash].every(hash=>HashSchema.safeParse(hash).success)&&cost(state.consumed)&&cost(state.reserved)&&count(state.correctionUsage)&&count(state.unsuccessfulCorrections)&&state.unsuccessfulCorrections<=state.correctionUsage&&typeof state.correctionRequired==='boolean'&&Array.isArray(state.externalLiabilities)&&new Set(state.externalLiabilities.map(item=>item.id)).size===state.externalLiabilities.length&&state.externalLiabilities.every(item=>IdSchema.safeParse(item.id).success&&(item.bounds===undefined||cost(item.bounds)));}
const deficit=(scope:string,resource:CampaignScheduleDeficit['resource'],required:number,available:number):CampaignScheduleDeficit[]=>required>available?[{scope,resource,required,available,deficit:required-available}]:[];

/** Offline scheduling does not issue batch approval or confer catalog credit.
 * All runtime allowances are explicit input; this never shortens a deadline. */
export function planCampaignSchedule(raw:CampaignScheduleInput):Result<CampaignSchedule>{
 try{
  const input=structuredClone(raw);
  // A proposal can calculate explicitly larger bounds, but issues no dispatch
  // authority. The campaign independently requires protected human approval.
  const limits=input.proposedExecutionLimits?CampaignExecutionLimitsSchema.parse(input.proposedExecutionLimits):{campaignLimits:{...CAMPAIGN_LIMITS},batchLimits:{...CAMPAIGN_BATCH_LIMITS},maxUnsuccessfulCorrections:2};
  if(!retainedValid(input.retained)||!HashSchema.safeParse(input.targetHash).success||input.targetHash!==input.retained.targetHash&&input.supersedesTargetHash!==input.retained.targetHash||!count(input.approvalTtlMs)||input.approvalTtlMs===0||input.approvalTtlMs>600000||!input.groups.length)return fail();
  const groups=new Map<string,CampaignScheduleGroup>(),entries=new Map<string,{entry:ScheduledAction;group:CampaignScheduleGroup}>(),seenGroups=new Set<string>();
  for(const group of input.groups){
   if(!IdSchema.safeParse(group.id).success||!IdSchema.safeParse(group.batchId).success||groups.has(group.id)||!Number.isSafeInteger(group.wallMs)||group.wallMs<=0||!group.actions.length||new Set(group.dependsOn).size!==group.dependsOn.length||group.dependsOn.some(id=>!seenGroups.has(id)))return fail();
   groups.set(group.id,group);seenGroups.add(group.id);
   for(const entry of group.actions){
    const action=CampaignActionSchema.parse(entry.action);
    if(entries.has(action.id)||!count(entry.startOffsetMs)||entry.startOffsetMs>=group.wallMs||action.kind==='cleanup'&&!!entry.process)return fail();
    if(action.kind==='cleanup'){
     if(entry.recipe||entry.envelope||action.topLevel||action.cleanupId||entry.startOffsetMs+action.maxMs>group.wallMs)return fail();
    }else{
     if(!entry.process||!Number.isSafeInteger(entry.process.runtimeMs)||entry.process.runtimeMs<=0||!['integral','standalone'].includes(entry.process.kind)||!!entry.recipe===!!entry.envelope)return fail();
     if(entry.recipe&&entry.process.kind!==(entry.recipe.kind==='auxiliary'?'standalone':'integral')||entry.envelope&&['control-positive','control-negative','diagnostic'].includes(entry.envelope.kind)&&entry.process.kind!=='integral')return fail();
     const required=entry.process.kind==='integral'?requiredIntegralProcessMs(1,1+entry.process.runtimeMs):requiredStandaloneProcessMs(1,1+entry.process.runtimeMs);
     const tail=entry.process.kind==='integral'?SUPERVISOR_DRAIN_TAIL_MS:OBSERVER_TERMINAL_FLUSH_MS;
     if(action.maxMs<required||entry.startOffsetMs+entry.process.runtimeMs+tail>group.wallMs)return fail();
     if(entry.recipe&&(entry.recipe.actionId!==action.id||campaignRecipeHash(entry.recipe)!==action.launchHash||
      ('request' in entry.recipe&&(entry.recipe.request.intent.requestId!==group.batchId||entry.recipe.request.intent.expiresAt-entry.recipe.request.intent.issuedAt!==entry.process.runtimeMs||entry.recipe.request.intent.dispatchHash!==action.launchHash))))return fail();
     if(entry.envelope&&(entry.envelope.launchHash!==action.launchHash||entry.envelope.targetHash!==input.targetHash))return fail();
    }
    entries.set(action.id,{entry:{...entry,action},group});
   }
  }
  for(const {entry,group} of entries.values()){
   const action=entry.action;
   if(action.kind==='cleanup'){
    const parents=group.actions.filter(parent=>parent.action.cleanupId===action.id).map(parent=>parent.action);
    if(!parents.length||action.launchHash!==cleanupRecipeHash(group.batchId,parents.length===1?parents[0]:parents))return fail();
    // Cleanup is reserved in the batch before effects, and occurs after every
    // parent has exhausted its declared execution/observation envelope.
    if(group.actions.some(parent=>parent.action.cleanupId===action.id&&parent.process&&entry.startOffsetMs<parent.startOffsetMs+parent.process.runtimeMs+(parent.process.kind==='integral'?SUPERVISOR_DRAIN_TAIL_MS:OBSERVER_TERMINAL_FLUSH_MS)))return fail();
   }else{
    const cleanup=entries.get(action.cleanupId??'');
    if(!cleanup||cleanup.group.id!==group.id||cleanup.entry.action.kind!=='cleanup')return fail();
    if(!action.topLevel&&(!action.auxiliaryFor||!group.actions.some(parent=>parent.action.id===action.auxiliaryFor&&parent.action.topLevel)))return fail();
   }
  }
  const catalog=[...entries.values()].filter(({entry})=>entry.action.kind==='probe');
  if(catalog.length!==32||REQUIRED_CODEX_WINDOWS_PROBES.some(probe=>catalog.filter(({entry})=>entry.action.probeId===probe.id).length!==1))return fail();
  for(const {entry} of catalog){if(!entry.recipe||!['session','fixed'].includes(entry.recipe.kind)||!entry.action.topLevel)return fail();
   const id=entry.recipe.kind==='session'?entry.recipe.probeId:entry.recipe.kind==='fixed'?`${entry.recipe.boundary.role}.${entry.recipe.boundary.role==='verifier'&&entry.recipe.boundary.operation==='allowed_edit'?'allowed_command':entry.recipe.boundary.operation}`:'';
   if(id!==entry.action.probeId)return fail();}
  const prerequisite=input.prerequisites,has=(id:string,kind:CampaignAction['kind'],envelope?:ScheduleEnvelope['kind'])=>{const entry=entries.get(id)?.entry;return !!entry&&entry.action.kind===kind&&(!envelope||entry.envelope?.kind===envelope);};
  if(!prerequisite.preparationActionIds.every(id=>has(id,'preparation','preparation'))||!prerequisite.diagnosticActionIds.every(id=>has(id,'preparation','diagnostic'))||!prerequisite.metadataActionIds.every(id=>has(id,'metadata'))||!has(prerequisite.strictPositiveActionId,'strict-positive')||!has(prerequisite.strictNegativeActionId,'strict-negative')||!prerequisite.coordinatorActionIds.every(id=>has(id,'preparation','outer-coordinator'))||!HashSchema.safeParse(prerequisite.startupEvidence.coverageHash).success||prerequisite.startupEvidence.targetHash!==input.targetHash||prerequisite.startupEvidence.actionIds.some(id=>!entries.has(id)))return fail();
  const batches:CampaignScheduleBatch[]=[],batchDeficits:CampaignScheduleDeficit[]=[],groupBatches=new Map<string,string>();
  for(const group of input.groups){
   const groupCost=total(group.actions),topLevel=group.actions.filter(entry=>entry.action.topLevel).length;
   let batch=batches.at(-1);
   if(!batch||batch.id!==group.batchId){
    if(batches.some(batch=>batch.id===group.batchId))return fail();
    batch={id:group.batchId,groupIds:[],actionIds:[],dependencies:[],cleanupReservedFirst:[],topLevelActions:0,wallMs:0,approvalTtlMs:input.approvalTtlMs,cost:zero()};batches.push(batch);
   }
   batch.groupIds.push(group.id);batch.actionIds.push(...group.actions.map(entry=>entry.action.id));batch.cleanupReservedFirst.push(...group.actions.filter(entry=>entry.action.kind==='cleanup').map(entry=>entry.action.id));batch.topLevelActions+=topLevel;batch.wallMs+=group.wallMs;batch.cost=add(batch.cost,groupCost);groupBatches.set(group.id,batch.id);
  }
  for(const batch of batches){
   batch.dependencies=[...new Set(batch.groupIds.flatMap(id=>groups.get(id)!.dependsOn.map(id=>groupBatches.get(id)!)).filter(id=>id!==batch.id))];
   batchDeficits.push(...deficit(batch.id,'topLevelActions',batch.topLevelActions,limits.batchLimits.topLevelActions),...deficit(batch.id,'activeMs',batch.cost.activeMs,limits.batchLimits.activeMs),...deficit(batch.id,'outputBytes',batch.cost.outputBytes,limits.batchLimits.outputBytes),...deficit(batch.id,'approvalMs',Math.max(batch.wallMs,batch.approvalTtlMs),limits.batchLimits.approvalTtlMs),...deficit(batch.id,'approvalMs',batch.wallMs,batch.approvalTtlMs));
  }
  const bill=[...entries.values()].map(({entry,group})=>({...entry,groupId:group.id,catalogCredit:entry.action.kind==='probe',processes:!entry.process?[]:entry.process.kind==='integral'?(['root','helper'] as const).map(kind=>({identity:`${entry.action.id}:${kind}`,kind,maxMs:entry.process!.runtimeMs+SUPERVISOR_DRAIN_TAIL_MS})):[{identity:`${entry.action.id}:standalone`,kind:'standalone' as const,maxMs:entry.process.runtimeMs+OBSERVER_TERMINAL_FLUSH_MS}]}));
  return {ok:true,value:{schemaVersion:1,targetHash:input.targetHash,retainedHash:fingerprint(input.retained),inputHash:fingerprint(input),executionLimits:limits,bill,batches,cost:bill.reduce((sum,entry)=>add(sum,{actions:1,activeMs:entry.action.maxMs,outputBytes:entry.action.maxOutputBytes}),zero()),batchDeficits}};
 }catch{return fail();}
}

/** A fresh history mismatch always requires rebuilding the proposal. Unknown
 * output/lifetime liabilities block feasibility; they are never silently zero. */
export function checkCampaignFeasibility(schedule:CampaignSchedule,retained:CampaignRetainedState):Result<CampaignFeasibility>{
 try{
  if(!retainedValid(retained)||!cost(schedule.cost))return fail();
  const limits=schedule.executionLimits?CampaignExecutionLimitsSchema.parse(schedule.executionLimits):{campaignLimits:{...CAMPAIGN_LIMITS},batchLimits:{...CAMPAIGN_BATCH_LIMITS},maxUnsuccessfulCorrections:2};
  const reasons:string[]=[];
  if(schedule.retainedHash!==fingerprint(retained))reasons.push('RETAINED_STATE_CHANGED');
  if(retained.unsuccessfulCorrections>=limits.maxUnsuccessfulCorrections)reasons.push('CORRECTION_LIMIT_REACHED');
  if(retained.correctionRequired)reasons.push('CORRECTIVE_APPROVAL_REQUIRED');
  if(retained.externalLiabilities.some(item=>!item.bounds))reasons.push('UNBOUNDED_EXTERNAL_LIABILITY');
  const liabilities=retained.externalLiabilities.reduce((sum,item)=>add(sum,item.bounds??zero()),zero()),prior=add(add(retained.consumed,retained.reserved),liabilities);
  const remaining=remainingAllowance(limits.campaignLimits,prior,zero());
  const deficits=[...schedule.batchDeficits,...(isUnlimited(remaining)?[]:(Object.keys(CAMPAIGN_LIMITS) as Array<keyof CampaignCost>).flatMap(resource=>deficit('campaign',resource,schedule.cost[resource],remaining[resource])))];
  return {ok:true,value:{fits:!reasons.length&&!deficits.length,reasons,remaining,required:{...schedule.cost},deficits}};
 }catch{return fail();}
}
