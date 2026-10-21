import {afterEach, expect, it, vi} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore, storeError, type RunStore} from '../src/store/database.ts';
import {publishArtifact} from '../src/store/artifacts.ts';
import {QualificationCampaign} from '../src/qualification/campaign.ts';
import {fingerprint} from '../src/qualification/probes.ts';
import {targetFingerprint, type QualificationTarget} from '../src/qualification/ledger.ts';
import type {Result} from '../src/contracts/common.ts';

const stores:RunStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
const value=<T>(r:Result<T>):T=>{if(!r.ok)throw Error(r.error.code);return r.value;};
const hash='a'.repeat(64);
async function setup(){
 const store=openStore(mkdtempSync(join(tmpdir(),'ouroboros-accounting-')));stores.push(store);
 const runId=randomUUID(),repoId=randomUUID();
 const oldRunId=randomUUID(),oldRepoId=randomUUID();
 value(store.createRun(oldRepoId,{schemaVersion:1,id:oldRunId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));
 const oldOwner=value(store.claim(oldRepoId,oldRunId));let oldRevision=0;
 value(store.createRun(repoId,{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));
 const owner=value(store.claim(repoId,runId));let revision=0;const failed=randomUUID(),repaired=randomUUID(),allowed=randomUUID(),oldRequest=randomUUID(),repairRequest=randomUUID();
 const requestAction=randomUUID();value(store.intent(owner,{schemaVersion:1,id:requestAction,runId,kind:'HISTORICAL_APPROVAL',payload:{}}));value(store.appendQualification(owner,{schemaVersion:1,id:randomUUID(),runId,generation:owner.generation,actionId:requestAction,requestId:repairRequest,targetHash:'c'.repeat(64),kind:'REQUEST',payload:{request:{fixtureRoots:['fixture-root']}}},revision++));value(store.outcome(owner,requestAction,{schemaVersion:1,status:'RECONCILED',evidenceIds:[]}));
 for(const [actionId,requestId,targetHash,probeId,status,elapsedMs,outputBytes] of [[failed,oldRequest,'b'.repeat(64),'verifier.denied_sensitive_read','FAIL',60066,84],[repaired,repairRequest,'c'.repeat(64),'verifier.denied_sensitive_read','PASS',2039,29],[allowed,repairRequest,'c'.repeat(64),'verifier.allowed_command','PASS',1482,23]] as const){
  const actionOwner=actionId===failed?oldOwner:owner;
  value(store.intent(actionOwner,{schemaVersion:1,id:actionId,runId:actionOwner.runId,kind:'HISTORICAL_QUALIFICATION',payload:{}}));value(store.dispatch(actionOwner,actionId));
  for(const kind of ['ATTEMPT_INTENT','ATTEMPT_RESULT'] as const)value(store.appendQualification(actionOwner,{schemaVersion:1,id:randomUUID(),runId:actionOwner.runId,generation:actionOwner.generation,actionId,requestId,targetHash,kind,payload:{ordinal:0,probeId,observation:kind==='ATTEMPT_RESULT'?{status,elapsedMs,outputBytes,evidenceKind:'live',actualAttempt:true}:null}},actionId===failed?oldRevision++:revision++));
  value(store.outcome(actionOwner,actionId,{schemaVersion:1,status:'RECONCILED',evidenceIds:[]}));
 }
 value(store.release(oldOwner));value(store.reserveOutput(owner,null,4526));
 const target:QualificationTarget={schemaVersion:1,provider:'codex',environment:'windows',runtime:{path:'C:\\pinned\\codex.exe',version:'fixture',sha256:hash},adapter:{version:'fixture',sha256:hash},helper:{path:'C:\\pinned\\helper.exe',version:'fixture',sha256:hash},verifier:{path:'C:\\pinned\\codex.exe',version:'fixture',sha256:hash,wrapperHash:hash},os:{platform:'win32',architecture:'x64',release:'fixture',sha256:hash},policyHash:hash,startupConfigHash:hash,model:'new-target',effort:'high'};
 let authorized=true;
 const campaign=new QualificationCampaign(store,{now:()=>1000,authorizeCurrent:()=>true,authorizeAccounting:()=>authorized});
 const id=randomUUID(),identity={schemaVersion:2 as const,id,owner,target,targetHash:targetFingerprint(target),controllerHash:hash,protocolHash:hash,driverHash:hash,lineage:value(campaign.lineage(id))};value(campaign.create(identity));
 async function artifact(data:unknown){async function* bytes(){yield Buffer.from(JSON.stringify(data));}const a=value(await publishArtifact(store,bytes(),{schemaVersion:1,id:randomUUID(),owner,actionId:null,mediaType:'application/json',secrets:[]}));return {id:a.id,sha256:a.sha256};}
 const source=await artifact({userInstruction:'approved historical repair',approvedHash:hash,fixtureRoot:'fixture-root',coordinatorCorrectiveAttempt:1,correctiveLimit:2,priorFailedRequestId:oldRequest,noAutomaticRetry:true,stopAfterSlice:true});
 const result=await artifact({launched:true,sealHash:hash,requestId:repairRequest,passed:true,report:{targetHash:'c'.repeat(64)},outcome:{probes:[{probeId:'verifier.denied_sensitive_read',status:'PASS'},{probeId:'verifier.allowed_command',status:'PASS'}]}});
 const receipt=()=>({schemaVersion:2 as const,kind:'campaign-accounting' as const,id:randomUUID(),campaignId:id,owner,storeRootHash:fingerprint(store.root),historyHash:fingerprint(value(store.listQualifications())),targetHash:identity.targetHash,repairs:[{id:randomUUID(),failedActionId:failed,replacementActionIds:[repaired,allowed],approvalEvidence:source,resultEvidence:result}],preparation:[] as unknown[],preparationComplete:false});
 return {store,campaign,owner,identity,receipt,artifact,source,setAuthorized:(v:boolean)=>{authorized=v;}};
}

it('reconciles the ordinal-zero historical repair without changing old records or new-target probe credit',async()=>{
 const f=await setup(),before=value(f.store.listQualifications());
 const ref=await f.artifact(f.receipt());value(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:ref}));
 const s=value(f.campaign.snapshot(f.identity.id));expect(s.consumed).toEqual({actions:3,activeMs:63587,outputBytes:4610});expect(s.correctionUsage).toBe(1);expect(s.unsuccessfulCorrections).toBe(0);expect(s.correctionRequired).toBe(false);
 expect(value(f.store.listQualifications()).slice(0,before.length)).toEqual(before);expect(value(f.campaign.aggregate(f.identity.id)).every(p=>p.status==='UNTESTED')).toBe(true);
 const restarted=new QualificationCampaign(f.store,{authorizeCurrent:()=>true});expect(value(restarted.snapshot(f.identity.id)).correctionUsage).toBe(1);
 expect(s.accountingPending).toBe(true);
 expect(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:ref}).ok).toBe(false);
});

it('refuses stale, foreign-store, changed-target, unsupported and unapproved receipts',async()=>{
 for(const mutation of ['stale','foreign','target','unsupported','unapproved']){
  const f=await setup(),r=f.receipt();if(mutation==='stale')r.historyHash=hash;if(mutation==='foreign')r.storeRootHash=hash;if(mutation==='target')r.targetHash=hash;if(mutation==='unsupported')(r as {kind:string}).kind='generic-cost-claim';if(mutation==='unapproved')f.setAuthorized(false);
  const ref=await f.artifact(r);expect(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:ref}).ok).toBe(false);expect(value(f.campaign.snapshot(f.identity.id)).correctionUsage).toBe(0);
 }
});

it('charges protected complete process bounds and refuses unknown/excess preparation costs and replays',async()=>{
 const f=await setup();
 const observation={schemaVersion:2,kind:'campaign-preparation-observation',operationId:randomUUID(),storeRootHash:fingerprint(f.store.root),category:'build',scope:'simulated build with complete two-process envelope',classificationEvidence:f.source,sourceEvidence:[f.source],exclusions:[],processes:[{createdAt:100,completedAt:6543},{createdAt:100,completedAt:6543}],processTreeComplete:true,rawOutputBytes:2105,outputComplete:true};
 const cost=await f.artifact(observation),r=f.receipt();r.preparation=[cost];r.preparationComplete=true;value(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(r)}));
 expect(value(f.campaign.snapshot(f.identity.id)).consumed).toEqual({actions:5,activeMs:76473,outputBytes:6715});
 expect(value(f.campaign.snapshot(f.identity.id)).accountingPending).toBe(false);
 const replay=f.receipt();replay.repairs=[];replay.preparation=[cost];expect(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(replay)}).ok).toBe(false);
 for(const change of [{processTreeComplete:false},{processes:[{createdAt:1,completedAt:2400001}]},{outputComplete:false}]){
  const g=await setup(),ref=await g.artifact({...observation,operationId:randomUUID(),storeRootHash:fingerprint(g.store.root),...change}),receipt=g.receipt();receipt.preparation=[ref];expect(g.campaign.reconcileAccounting(g.identity.id,{owner:g.owner,evidence:await g.artifact(receipt)}).ok).toBe(false);
 }
});

it('retains committed charges after an interrupted metadata outcome and requires explicit recovery',async()=>{
 const f=await setup(),ref=await f.artifact(f.receipt());
 const outcome=vi.spyOn(f.store,'outcome').mockReturnValueOnce(storeError('SIMULATED_CRASH','metadata outcome interrupted'));
 expect(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:ref}).ok).toBe(false);outcome.mockRestore();
 const stopped=value(f.campaign.snapshot(f.identity.id));expect(stopped.correctionUsage).toBe(1);expect(stopped.reconciliationRequired).toBe(true);
 expect(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:ref}).ok).toBe(false);
 const pending=value(f.store.reconcileEvidence(f.owner.runId)).unknownActionIds;expect(pending).toHaveLength(1);
 value(f.store.outcome(f.owner,pending[0],{schemaVersion:1,status:'RECONCILED',evidenceIds:[ref.id]}));
 const recovered=value(new QualificationCampaign(f.store,{authorizeCurrent:()=>true}).snapshot(f.identity.id));expect(recovered.reconciliationRequired).toBe(false);expect(recovered.correctionUsage).toBe(1);expect(recovered.consumed).toEqual(stopped.consumed);
});

it('keeps preparation pending across campaign succession and cannot complete it with invented zero',async()=>{
 const f=await setup(),ref=await f.artifact(f.receipt());value(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:ref}));
 const unsupported=f.receipt();unsupported.repairs=[];unsupported.preparationComplete=true;
 expect(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(unsupported)}).ok).toBe(false);
 const id=randomUUID(),successor={...f.identity,id,supersedes:f.identity.id,lineage:value(f.campaign.lineage(id))};value(f.campaign.create(successor));
 const snapshot=value(f.campaign.snapshot(id));expect(snapshot.accountingPending).toBe(true);expect(snapshot.correctionUsage).toBe(1);expect(snapshot.consumed).toEqual({actions:3,activeMs:63587,outputBytes:4610});
 const cleanup={id:randomUUID(),kind:'cleanup' as const,topLevel:false,launchHash:hash,admissionHash:hash,maxMs:10,maxOutputBytes:10};
 expect(f.campaign.approve({schemaVersion:2,id:randomUUID(),campaignId:id,owner:f.owner,targetHash:f.identity.targetHash,fixtureHash:hash,endpointHash:hash,approvedAt:1000,expiresAt:2000,remaining:snapshot.remaining,actions:[cleanup]}).ok).toBe(false);
});

it('preserves separate correction usage and the two-unsuccessful-correction stop after historical success',async()=>{
 const f=await setup(),r=f.receipt();r.preparationComplete=true;
 r.preparation=[await f.artifact({schemaVersion:2,kind:'campaign-preparation-observation',operationId:randomUUID(),storeRootHash:fingerprint(f.store.root),category:'fixture-preparation',scope:'simulated complete fixture process',classificationEvidence:f.source,sourceEvidence:[f.source],exclusions:[],processes:[{createdAt:1,completedAt:2}],processTreeComplete:true,rawOutputBytes:0,outputComplete:true})];
 value(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(r)}));
 let affected:string|undefined;
 for(let n=0;n<3;n++){
  const cleanup={id:randomUUID(),kind:'cleanup' as const,topLevel:false,launchHash:hash,admissionHash:hash,maxMs:10,maxOutputBytes:10};
  const action={...cleanup,id:randomUUID(),kind:'preparation' as const,topLevel:true,cleanupId:cleanup.id};
  const b={schemaVersion:2 as const,id:randomUUID(),campaignId:f.identity.id,owner:f.owner,targetHash:f.identity.targetHash,fixtureHash:hash,endpointHash:hash,approvedAt:1000,expiresAt:2000,remaining:value(f.campaign.snapshot(f.identity.id)).remaining,actions:[action,cleanup],...(affected?{correction:{candidateId:randomUUID(),affectedActionId:affected,evidenceIds:[f.source.id]}}:{})};
  value(f.campaign.approve(b));value(f.campaign.dispatch(b.id,action,{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));value(f.campaign.finish(b.id,action.id,{elapsedMs:1,outputBytes:0,status:'FAIL',evidenceKind:'fixture',evidence:[{...f.source,category:'simulated-controller-observation'}]}));
  value(f.campaign.dispatch(b.id,cleanup,{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));value(f.campaign.finish(b.id,cleanup.id,{elapsedMs:1,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));
  value(f.campaign.reconcile(f.identity.id,{id:randomUUID(),owner:f.owner,evidenceIds:[f.source.id],targetHash:f.identity.targetHash}));affected=action.id;
 }
 const stopped=value(f.campaign.snapshot(f.identity.id));expect(stopped.correctionUsage).toBe(3);expect(stopped.unsuccessfulCorrections).toBe(2);
 const cleanup={id:randomUUID(),kind:'cleanup' as const,topLevel:false,launchHash:hash,admissionHash:hash,maxMs:10,maxOutputBytes:10};
 const attempt=f.campaign.approve({schemaVersion:2,id:randomUUID(),campaignId:f.identity.id,owner:f.owner,targetHash:f.identity.targetHash,fixtureHash:hash,endpointHash:hash,approvedAt:1000,expiresAt:2000,remaining:stopped.remaining,actions:[cleanup],correction:{candidateId:randomUUID(),affectedActionId:affected!,evidenceIds:[f.source.id]}});
 expect(attempt.ok).toBe(false);if(!attempt.ok)expect(attempt.error.code).toBe('CORRECTION_APPROVAL_REQUIRED');
});

async function historicalObservation(f:Awaited<ReturnType<typeof setup>>,mode:'measured'|'conservative-upper-bound'='measured'){
 const source=await f.artifact({kind:'SIMULATED historical process/output evidence',observationId:randomUUID()});
 return {schemaVersion:2,kind:'campaign-historical-execution-observation',operationId:randomUUID(),storeRootHash:fingerprint(f.store.root),category:'functional-execution',scope:'SIMULATED completed execution; no live provider',classificationEvidence:f.source,sourceEvidence:[source],exclusions:[],accountingMode:mode,rawOutputBytes:mode==='measured'?42:512,rawOutputComplete:mode==='measured',outputAccountingComplete:true,processTreeComplete:true,groups:[{actionId:randomUUID(),kind:'integral',processes:[{kind:'root',pid:123,creationIdentity:'root-start-123',createdAt:100,completedAt:150},{kind:'helper',pid:124,creationIdentity:'helper-start-124',createdAt:90,completedAt:160}]},{actionId:randomUUID(),kind:'standalone',processes:[{kind:'standalone',pid:125,creationIdentity:'standalone-start-125',createdAt:80,completedAt:180}]}]};
}
async function historicalReceipt(f:Awaited<ReturnType<typeof setup>>,observation:unknown){const receipt:any=f.receipt();receipt.repairs=[];receipt.historicalExecutions=[await f.artifact(observation)];receipt.preparationComplete=true;return receipt;}
it('charges integral history as one action while charging every actual root helper and standalone interval',async()=>{
 const f=await setup(),before=value(f.campaign.snapshot(f.identity.id)),observation=await historicalObservation(f),receipt=await historicalReceipt(f,observation);
 value(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(receipt)}));
 const current=value(f.campaign.snapshot(f.identity.id));expect(current.consumed).toEqual({actions:before.consumed.actions+2,activeMs:before.consumed.activeMs+220,outputBytes:before.consumed.outputBytes+42});
 expect(current.correctionUsage).toBe(before.correctionUsage);expect(current.unsuccessfulCorrections).toBe(before.unsuccessfulCorrections);expect(current.outstandingFailureIds).toEqual(before.outstandingFailureIds);expect(value(f.campaign.aggregate(f.identity.id)).every(p=>p.status==='UNTESTED')).toBe(true);
 const restarted=new QualificationCampaign(f.store,{authorizeCurrent:()=>false});expect(value(restarted.snapshot(f.identity.id)).consumed).toEqual(current.consumed);
});
it('retains an explicit conservative output upper bound without claiming actual raw stream completeness',async()=>{
 const f=await setup(),observation=await historicalObservation(f,'conservative-upper-bound'),before=value(f.campaign.snapshot(f.identity.id));
 const receipt=await historicalReceipt(f,observation);value(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(receipt)}));
 expect(value(f.campaign.snapshot(f.identity.id)).consumed.outputBytes).toBe(before.consumed.outputBytes+512);
 const artifact=value(f.store.loadArtifact(receipt.historicalExecutions[0].id));expect(artifact.sha256).toBe(receipt.historicalExecutions[0].sha256);
});
it.each(['duplicate-action','duplicate-process','missing-helper','wrong-standalone','incomplete-tree','missing-output','zero-upper','incomplete-accounting','unmeasured-zero','negative-interval','missing-source','existing-action','excess-budget'] as const)('refuses %s grouped historical accounting',async fault=>{
 const f=await setup(),observation:any=await historicalObservation(f);
 if(fault==='duplicate-action')observation.groups[1].actionId=observation.groups[0].actionId;
 if(fault==='duplicate-process')observation.groups[1].processes[0]={...observation.groups[0].processes[0],kind:'standalone'};
 if(fault==='missing-helper')observation.groups[0].processes.pop();
 if(fault==='wrong-standalone')observation.groups[1].processes[0].kind='root';
 if(fault==='incomplete-tree')observation.processTreeComplete=false;
 if(fault==='missing-output')delete observation.rawOutputBytes;
 if(fault==='zero-upper'){observation.accountingMode='conservative-upper-bound';observation.rawOutputBytes=0;observation.rawOutputComplete=false;}
 if(fault==='incomplete-accounting')observation.outputAccountingComplete=false;
 if(fault==='unmeasured-zero'){observation.rawOutputBytes=0;observation.rawOutputComplete=false;}
 if(fault==='negative-interval')observation.groups[0].processes[0].completedAt=99;
 if(fault==='missing-source')observation.sourceEvidence=[];
 if(fault==='existing-action')observation.groups[0].actionId=f.receipt().repairs[0].failedActionId;
 if(fault==='excess-budget')observation.rawOutputBytes=10485761;
 const before=value(f.campaign.snapshot(f.identity.id)),receipt=await historicalReceipt(f,observation);expect(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(receipt)}).ok).toBe(false);expect(value(f.campaign.snapshot(f.identity.id)).consumed).toEqual(before.consumed);
});
it.each(['action','process','source'] as const)('rejects historical %s replay across separately retained receipts',async replay=>{
 const f=await setup(),first=await historicalObservation(f);value(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(await historicalReceipt(f,first))}));
 const second=await historicalObservation(f);second.groups.forEach((group,index)=>group.processes.forEach((process,ordinal)=>{process.pid+=100;process.creationIdentity+=`-new-${index}-${ordinal}`;}));
 if(replay==='action')second.groups[0].actionId=first.groups[0].actionId;
 if(replay==='process')second.groups[0].processes[0]=structuredClone(first.groups[0].processes[0]);
 if(replay==='source')second.sourceEvidence=first.sourceEvidence;
 const before=value(f.campaign.snapshot(f.identity.id));expect(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:await f.artifact(await historicalReceipt(f,second))}).ok).toBe(false);expect(value(f.campaign.snapshot(f.identity.id)).consumed).toEqual(before.consumed);
});
