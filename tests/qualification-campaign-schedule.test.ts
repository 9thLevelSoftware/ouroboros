import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { planCampaignSchedule,checkCampaignFeasibility,type CampaignScheduleInput,type ScheduledAction,type CampaignRetainedState } from '../src/qualification/campaign-schedule.ts';
import { campaignRecipeHash,cleanupRecipeHash } from '../src/qualification/campaign-runner.ts';
import { CAMPAIGN_PROBE_ROUTES } from '../src/qualification/campaign-recipes.ts';
import { fingerprint } from '../src/qualification/probes.ts';
const h='a'.repeat(64);
const retained=():CampaignRetainedState=>({historyHash:h,lineageHash:h,targetHash:h,consumed:{actions:33,activeMs:247838,outputBytes:126974},reserved:{actions:0,activeMs:0,outputBytes:0},correctionUsage:2,unsuccessfulCorrections:1,correctionRequired:false,externalLiabilities:[]});
/** Synthetic process windows test arithmetic. They are not approved deadlines
 * and this fixture never launches/qualifies a real process. */
function fixture():CampaignScheduleInput{
 const input:CampaignScheduleInput={targetHash:h,retained:retained(),approvalTtlMs:600000,groups:[],prerequisites:{preparationActionIds:[],diagnosticActionIds:[],metadataActionIds:[],strictPositiveActionId:'',strictNegativeActionId:'',coordinatorActionIds:[],startupEvidence:{coverageHash:h,targetHash:h,actionIds:[]}}};
 const ids=[...CAMPAIGN_PROBE_ROUTES.map(route=>route.probeId),'strict-positive','strict-negative'];
 for(let index=0;index<ids.length;index+=2){
  const groupId=randomUUID(),batchId=randomUUID(),cleanupId=randomUUID(),actions:ScheduledAction[]=[];
  for(const id of ids.slice(index,index+2)){
   const actionId=randomUUID(),kind=id.startsWith('strict')?id as 'strict-positive'|'strict-negative':'probe',route=CAMPAIGN_PROBE_ROUTES.find(route=>route.probeId===id);
   const request:any={intent:{owner:{runId:randomUUID(),generation:1,actionId,role:route?.role==='verifier'?'verifier':'worker'},requestId:batchId,issuedAt:1000,expiresAt:16000,dispatchHash:h},argv:[],admissions:{},protectedInputs:{}};
   const recipe:any=kind!=='probe'?{kind:'strict',actionId,request}:route!.kind==='session'?{kind:'session',actionId,probeId:id,request}:{kind:'fixed',actionId,request,boundary:{role:route!.role,operation:route!.operation,executionId:actionId,fixtureRoot:'C:\\fixture',targetHash:h}};
   request.intent.dispatchHash=campaignRecipeHash(recipe);
   actions.push({action:{id:actionId,kind,topLevel:true,...(kind==='probe'?{probeId:id}:{}),launchHash:request.intent.dispatchHash,admissionHash:h,maxMs:60000,maxOutputBytes:100,cleanupId},recipe,process:{kind:'integral',runtimeMs:15000},startOffsetMs:0});
   if(kind==='strict-positive')input.prerequisites.strictPositiveActionId=actionId;if(kind==='strict-negative')input.prerequisites.strictNegativeActionId=actionId;
  }
  actions.push({action:{id:cleanupId,kind:'cleanup',topLevel:false,launchHash:cleanupRecipeHash(batchId,actions.map(entry=>entry.action)),admissionHash:h,maxMs:1,maxOutputBytes:1},startOffsetMs:30000});
  input.groups.push({id:groupId,batchId,dependsOn:input.groups.length?[input.groups.at(-1)!.id]:[],wallMs:30001,actions});
 }
 return input;
}
function planned(input=fixture()){const result=planCampaignSchedule(input);expect(result.ok,JSON.stringify(result)).toBe(true);if(!result.ok)throw Error(result.error.code);return result.value;}
function feasible(input=fixture()){const result=checkCampaignFeasibility(planned(input),input.retained);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.code);return result.value;}
it('bills exactly32 catalog actions plus independent strict roots and shared cleanup before effects',()=>{
 const input=fixture(),schedule=planned(input),result=feasible(input);
 expect(schedule.bill.filter(entry=>entry.catalogCredit)).toHaveLength(32);expect(schedule.cost).toEqual({actions:51,activeMs:2040017,outputBytes:3417});expect(result.fits).toBe(true);
 expect(schedule.batches).toHaveLength(17);expect(schedule.batches.every(batch=>batch.topLevelActions===2&&batch.cleanupReservedFirst.length===1)).toBe(true);
 expect(schedule.bill.filter(entry=>entry.recipe).flatMap(entry=>entry.processes)).toHaveLength(68);
 expect(result.remaining).toEqual({actions:63,activeMs:2152162,outputBytes:10358786});
});
it.each(['actions','activeMs','outputBytes'] as const)('reports the exact one-over %s deficit without changing allowances',resource=>{
 const input=fixture(),schedule=planned(input),limits={actions:96,activeMs:2400000,outputBytes:10485760};input.retained.consumed[resource]=limits[resource]-schedule.cost[resource]+1;
 const result=feasible(input);expect(result.fits).toBe(false);expect(result.deficits).toContainEqual({scope:'campaign',resource,required:schedule.cost[resource],available:schedule.cost[resource]-1,deficit:1});
});
it('does not collapse concurrent root/helper or independently launched observer lifetimes',()=>{
 const input=fixture(),group=input.groups[0],id=randomUUID(),cleanup=group.actions.at(-1)!,parent=group.actions[0].action;
 const observer:ScheduledAction={action:{id,kind:'preparation',topLevel:false,auxiliaryFor:parent.id,auxiliaryRole:'guardian',cleanupId:cleanup.action.id,launchHash:h,admissionHash:h,maxMs:31000,maxOutputBytes:1},envelope:{kind:'preparation',targetHash:h,launchHash:h},process:{kind:'standalone',runtimeMs:30000},startOffsetMs:0};
 group.actions.splice(2,0,observer);cleanup.startOffsetMs=31000;group.wallMs=31001;cleanup.action.launchHash=cleanupRecipeHash(group.batchId,group.actions.filter(entry=>entry.action.kind!=='cleanup').map(entry=>entry.action));
 const result=feasible(input);expect(result.deficits).toContainEqual({scope:group.batchId,resource:'activeMs',required:151001,available:150000,deficit:1001});
});
it.each(['unbounded-output','bounded-process'] as const)('preserves %s external liabilities',kind=>{
 const input=fixture();input.retained.externalLiabilities.push({id:randomUUID(),...(kind==='bounded-process'?{bounds:{actions:1,activeMs:21744,outputBytes:417558}}:{})});
 const result=feasible(input);expect(result.fits).toBe(kind==='bounded-process');expect(result.reasons).toEqual(kind==='unbounded-output'?['UNBOUNDED_EXTERNAL_LIABILITY']:[]);if(kind==='bounded-process')expect(result.remaining.activeMs).toBe(2130418);
});
it('requires rebuilt proposals after fresh history/target/correction changes',()=>{
 const input=fixture(),schedule=planned(input),fresh=structuredClone(input.retained);fresh.historyHash='b'.repeat(64);fresh.unsuccessfulCorrections=2;
 expect(checkCampaignFeasibility(schedule,fresh)).toMatchObject({ok:true,value:{fits:false,reasons:['RETAINED_STATE_CHANGED','CORRECTION_LIMIT_REACHED']}});
 input.targetHash='b'.repeat(64);expect(planCampaignSchedule(input).ok).toBe(false);
});
it.each(['missing-probe','duplicate','cleanup-early','process-underreserve','process-relabel','approval','dependency'] as const)('refuses or exposes %s without dispatch',fault=>{
 const input=fixture();
 if(fault==='missing-probe')input.groups[0].actions.splice(0,1);
 if(fault==='duplicate')input.groups[1].actions[0]=structuredClone(input.groups[0].actions[0]);
 if(fault==='cleanup-early')input.groups[0].actions.at(-1)!.startOffsetMs=1;
 if(fault==='process-underreserve')input.groups[0].actions[0].action.maxMs=59999;
 if(fault==='process-relabel')input.groups[0].actions[0].process!.kind='standalone';
 if(fault==='dependency')input.groups[0].dependsOn=[input.groups.at(-1)!.id];
 if(fault==='approval'){input.approvalTtlMs=30000;expect(feasible(input).deficits).toContainEqual({scope:input.groups[0].batchId,resource:'approvalMs',required:30001,available:30000,deficit:1});return;}
 const before=fingerprint(input);expect(planCampaignSchedule(input).ok).toBe(false);expect(fingerprint(input)).toBe(before);
});
it('calculates a larger explicitly proposed allowance without resetting retained costs or issuing approval',()=>{
 const input=fixture();input.proposedExecutionLimits={campaignLimits:{actions:192,activeMs:12000000,outputBytes:67108864},batchLimits:{topLevelActions:4,activeMs:600000,outputBytes:2097152,approvalTtlMs:600000},maxUnsuccessfulCorrections:3};
 input.retained.unsuccessfulCorrections=2;
 const group=input.groups[0];group.actions[0].action.maxMs=200000;group.actions[0].action.maxOutputBytes=1048576;
 const schedule=planned(input),result=feasible(input);expect(result.fits).toBe(true);expect(result.remaining).toEqual({actions:159,activeMs:11752162,outputBytes:66981890});
 expect(schedule.executionLimits).toEqual(input.proposedExecutionLimits);expect(schedule.bill.filter(action=>action.catalogCredit)).toHaveLength(32);
 input.retained.externalLiabilities=[{id:randomUUID()}];expect(feasible(input).reasons).toContain('UNBOUNDED_EXTERNAL_LIABILITY');
});
it('refuses proposed top-level, expiry and policy caps outside the bounded supported schema',()=>{
 const input=fixture();input.proposedExecutionLimits={campaignLimits:{actions:192,activeMs:12000000,outputBytes:67108864},batchLimits:{topLevelActions:4,activeMs:600000,outputBytes:2097152,approvalTtlMs:600000},maxUnsuccessfulCorrections:2};
 for(const mutation of [(value:any)=>value.batchLimits.topLevelActions=5,(value:any)=>value.batchLimits.approvalTtlMs=600001,(value:any)=>value.batchLimits.activeMs=600001,(value:any)=>value.campaignLimits.actions=1025]){const copy=structuredClone(input);mutation(copy.proposedExecutionLimits);expect(planCampaignSchedule(copy).ok).toBe(false);}
});
