import { afterEach, expect, it } from 'vitest';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {fingerprint} from '../src/qualification/probes.ts';
import { openStore, type RunStore } from '../src/store/database.ts';
import type { Result } from '../src/contracts/common.ts';
import { publishArtifact } from '../src/store/artifacts.ts';
import { targetFingerprint, type QualificationTarget } from '../src/qualification/ledger.ts';

const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const hash = 'a'.repeat(64);
const value = <T>(r: Result<T>): T => { if (!r.ok) throw Error(r.error.code); return r.value; };
async function fixture(seed?: (store: RunStore, owner: import('../src/contracts/evidence.ts').OwnerToken)=>void,prior?:(store:RunStore)=>void) {
 // A missing implementation must fail an assertion, rather than module loading.
 const modules = import.meta.glob('../src/qualification/campaign.ts');
 expect(Object.keys(modules)).toHaveLength(1);
 const { QualificationCampaign } = await modules['../src/qualification/campaign.ts']() as typeof import('../src/qualification/campaign.ts');
 const store = openStore(mkdtempSync(join(tmpdir(), 'ouroboros-campaign-'))); stores.push(store);
 prior?.(store);
 const runId = randomUUID(), repoId = randomUUID();
 value(store.createRun(repoId, { schemaVersion: 1, id: runId, taskId: randomUUID(), phase: 'CREATED', blocker: null, generation: 0, baselineRef: null, candidateRef: null, sessionRef: null, repairCount: 0, cumulativeBudgets: { activeMs: 0, outputBytes: 0, tokens: null, requests: null, money: null }, pendingActionIds: [] }));
 const owner = value(store.claim(repoId, runId)); let now = 1000; let current = true;
 seed?.(store,owner);
 const campaign = new QualificationCampaign(store, { now: () => now, authorizeCurrent: () => current });
 const target:QualificationTarget={schemaVersion:1,provider:'codex',environment:'windows',runtime:{path:'C:\\pinned\\codex.exe',version:'0.162.1',sha256:hash},adapter:{version:'1',sha256:hash},helper:{path:'C:\\pinned\\helper.exe',version:'1',sha256:hash},verifier:{path:'C:\\pinned\\codex.exe',version:'0.162.1',sha256:hash,wrapperHash:hash},os:{platform:'win32',architecture:'x64',release:'fixture',sha256:hash},policyHash:hash,startupConfigHash:hash,model:'fixture-model',effort:'high'};
 const id=randomUUID();const identity = { schemaVersion: 2 as const, id, owner,target, targetHash: targetFingerprint(target), controllerHash: hash, protocolHash: hash, driverHash: hash,...(typeof campaign.lineage==='function'?{lineage:value(campaign.lineage(id))}:{}) };
 value(campaign.create(identity));
 const action = (kind: 'preparation' | 'endpoint' | 'cleanup' = 'preparation') => ({ id: randomUUID(), kind, topLevel: kind !== 'cleanup', launchHash: hash, admissionHash: hash, maxMs: 100, maxOutputBytes: 100, ...(kind !== 'cleanup' ? { cleanupId: '' } : {}) });
 const batch = () => { const cleanup = action('cleanup'), probe = { ...action(), cleanupId: cleanup.id }; return { schemaVersion: 2 as const, id: randomUUID(), campaignId: identity.id, owner, targetHash: identity.targetHash, fixtureHash: hash, endpointHash: hash, approvedAt: now, expiresAt: now + 1000, remaining: value(campaign.snapshot(identity.id)).remaining, actions: [probe, cleanup] }; };
 return { campaign, store, owner, identity, action, batch, setNow: (n: number) => { now = n; }, deny: () => { current = false; } };
}

it('reserves cleanup and charges endpoint and cleanup independently across batches', async () => {
 const f = await fixture(), b = f.batch(); b.actions[0].kind = 'endpoint'; b.actions[0].topLevel = true;
 value(f.campaign.approve(b));
 value(f.campaign.dispatch(b.id, b.actions[0], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }));
 value(f.campaign.finish(b.id, b.actions[0].id, { elapsedMs: 70, outputBytes: 80, status: 'PASS', evidenceKind: 'fixture' }));
 value(f.campaign.dispatch(b.id, b.actions[1], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }));
 value(f.campaign.finish(b.id, b.actions[1].id, { elapsedMs: 30, outputBytes: 20, status: 'PASS', evidenceKind: 'fixture' }));
 expect(value(f.campaign.snapshot(f.identity.id)).consumed).toEqual({ actions: 2, activeMs: 100, outputBytes: 100 });
 expect(f.campaign.dispatch(b.id, b.actions[0], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }).ok).toBe(false);
});
it('concurrent pending batches reserve cumulative process duration and raw bytes', async () => {
 const f = await fixture();
 for (let n = 0; n < 16; n++) { const b = f.batch(); b.actions.forEach(a => { a.maxMs = 75000; }); value(f.campaign.approve(b)); }
 const extra = f.batch(); expect(f.campaign.approve(extra).ok).toBe(false);
 expect(value(f.campaign.snapshot(f.identity.id)).remaining.activeMs).toBe(0);
});
it('checks expiry and exact current launch fixture endpoint target admission at dispatch', async () => {
 const f = await fixture(), b = f.batch(); value(f.campaign.approve(b));
 expect(f.campaign.dispatch(b.id, { ...b.actions[0], launchHash: 'b'.repeat(64) }, { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }).ok).toBe(false);
 expect(value(f.campaign.snapshot(f.identity.id)).fenced).toBe(true);
});
it('fences expired approvals and refuses historical approval as current permission', async () => {
 const f = await fixture(), b = f.batch(); value(f.campaign.approve(b)); f.setNow(2000);
 expect(f.campaign.dispatch(b.id, b.actions[0], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }).ok).toBe(false);
 const g = await fixture(), c = g.batch(); value(g.campaign.approve(c)); g.deny();
 expect(g.campaign.dispatch(c.id, c.actions[0], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }).ok).toBe(false);
});
it('uncertain dispatch cannot replay after restart and only approved cleanup remains available', async () => {
 const f = await fixture(), b = f.batch(); value(f.campaign.approve(b)); value(f.campaign.dispatch(b.id, b.actions[0], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }));
 expect(f.campaign.approve(f.batch()).ok).toBe(false);
 value(f.campaign.unknown(b.id, b.actions[0].id));
 expect(value(f.campaign.snapshot(f.identity.id)).reconciliationRequired).toBe(true);
 value(f.campaign.dispatch(b.id, b.actions[1], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }));
 expect(f.campaign.dispatch(b.id, b.actions[0], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }).ok).toBe(false);
});
it('failure fences later probes and keeps worst-case charges when usage is over envelope', async () => {
 const f = await fixture(), b = f.batch(); value(f.campaign.approve(b)); value(f.campaign.dispatch(b.id, b.actions[0], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash }));
 expect(f.campaign.finish(b.id, b.actions[0].id, { elapsedMs: 101, outputBytes: 0, status: 'PASS', evidenceKind: 'fixture' }).ok).toBe(false);
 expect(value(f.campaign.snapshot(f.identity.id)).fenced).toBe(true);
 expect(value(f.campaign.snapshot(f.identity.id)).remaining.actions).toBe(94);
});
it('target change preserves consumed budgets and corrections require distinct approval', async () => {
 const f = await fixture(), b = f.batch(); value(f.campaign.approve(b));
 value(f.campaign.dispatch(b.id, b.actions[0], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash })); value(f.campaign.finish(b.id, b.actions[0].id, { elapsedMs: 30, outputBytes: 10, status: 'FAIL', evidenceKind: 'fixture' }));
 value(f.campaign.dispatch(b.id, b.actions[1], { fixtureHash: hash, endpointHash: hash, targetHash: f.identity.targetHash })); value(f.campaign.finish(b.id, b.actions[1].id, { elapsedMs: 20, outputBytes: 10, status: 'PASS', evidenceKind: 'fixture' }));
 const before = value(f.campaign.snapshot(f.identity.id));
 const changedTarget={...f.identity.target,model:'changed-model'},changedHash=targetFingerprint(changedTarget);
 value(f.campaign.reconcile(f.identity.id, { id: randomUUID(), owner: f.owner, evidenceIds: [randomUUID()],target:changedTarget, targetHash: changedHash }));
 expect(value(f.campaign.snapshot(f.identity.id)).consumed).toEqual(before.consumed);
 const next = f.batch(); next.targetHash = changedHash; expect(f.campaign.approve(next).ok).toBe(false);
});
it('refuses a new campaign identity in the same run instead of silently resetting history', async () => {
 const f = await fixture(); expect(f.campaign.create({ ...f.identity, id: randomUUID() }).ok).toBe(false);
});
it('retains reserved cleanup after approval expiry and current ordinary authority loss', async () => {
 const f = await fixture(), b=f.batch(); value(f.campaign.approve(b)); value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));
 value(f.campaign.finish(b.id,b.actions[0].id,{elapsedMs:30,outputBytes:0,status:'FAIL',evidenceKind:'fixture'})); f.setNow(2000); f.deny();
 expect(f.campaign.dispatch(b.id,b.actions[1],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}).ok).toBe(true);
});
it('retains conservative raw output while reconciling v1 known lifetimes without a raw meter', async () => {
 const f = await fixture(), b=f.batch();b.actions[0].kind='endpoint'; value(f.campaign.approve(b)); value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash})); value(f.campaign.unknown(b.id,b.actions[0].id));f.setNow(1050);
 expect(typeof f.campaign.resolveUnknown).toBe('function');
 const owner={runId:f.owner.runId,generation:f.owner.generation,actionId:b.actions[0].id,role:'endpoint'};
 const ownership={schemaVersion:1,...owner,environment:'windows',pid:10,creationIdentity:'root-10',helperPid:11,helperCreationIdentity:'helper-11',jobIdentity:'job-10',boundaryHash:hash,assignedBeforeResume:true,capturedAt:1000};
 const terminal={schemaVersion:1,...owner,reason:'finished',requestAcknowledged:true,requestedAt:1040,acknowledgedAt:1040,rootExited:true,rootExitedAt:1050,membershipEmpty:true,membershipObservedAt:1050,activeProcesses:0,unresolvedExecutions:[],outputComplete:true,unresolvedOutputStreams:[],outputCompletedAt:1050,childRanBeforeAssignment:false,completedAt:1050};
 const recovery={schemaVersion:2,kind:'campaign-recovery',campaignId:f.identity.id,batchId:b.id,actionId:b.actions[0].id,launchHash:hash,targetHash:f.identity.targetHash,owner:f.owner,
  reconciled:true,rootExited:true,outputComplete:true,membershipEmpty:true,brokersReconciled:true,observation:{kind:'owned-execution',launchHash:hash,ownership,terminal,brokerInventory:{inventoryComplete:true,active:[],unresolved:[]},processMeters:[{kind:'root',identity:{pid:10,creationIdentity:'root-10'},activeMs:20},{kind:'helper',identity:{pid:11,creationIdentity:'helper-11'},activeMs:30}]},usage:{elapsedMs:50,outputBytes:0,status:'FAIL' as const,evidenceKind:'fixture' as const}};
 async function* bytes(){yield Buffer.from(JSON.stringify(recovery));}
 const artifact=value(await publishArtifact(f.store,bytes(),{schemaVersion:1,id:randomUUID(),owner:f.owner,actionId:b.actions[0].id,mediaType:'application/json',secrets:[]}));
 value(f.campaign.resolveUnknown(b.id,b.actions[0].id,{id:randomUUID(),evidence:[{id:artifact.id,sha256:artifact.sha256}]}));
 expect(value(f.campaign.snapshot(f.identity.id)).consumed).toEqual({actions:1,activeMs:50,outputBytes:b.actions[0].maxOutputBytes});
 expect(f.campaign.resolveUnknown(b.id,b.actions[0].id,{id:randomUUID(),evidence:[{id:artifact.id,sha256:artifact.sha256}]}).ok).toBe(false);
});
it('imports immutable historical consumed usage and successful versus unsuccessful corrections separately',async()=>{
 const f=await fixture((store,owner)=>{
  let revision=0;for(const [ordinal,status,ms,output] of [[0,'FAIL',50,25],[1,'PASS',70,35],[2,'FAIL',80,40]] as const){
   const actionId=randomUUID(),requestId=randomUUID();value(store.intent(owner,{schemaVersion:1,id:actionId,runId:owner.runId,kind:'HISTORICAL_QUALIFICATION',payload:{}}));value(store.dispatch(owner,actionId));
   for(const kind of ['ATTEMPT_INTENT','ATTEMPT_RESULT'] as const)value(store.appendQualification(owner,{schemaVersion:1,id:randomUUID(),runId:owner.runId,generation:owner.generation,actionId,requestId,targetHash:hash,kind,payload:{ordinal,observation:kind==='ATTEMPT_RESULT'?{elapsedMs:ms,outputBytes:output,status}:null}},revision++));
   value(store.outcome(owner,actionId,{schemaVersion:1,status:'RECONCILED',evidenceIds:[]}));
  }
 });const snapshot=value(f.campaign.snapshot(f.identity.id));expect(snapshot.consumed).toEqual({actions:3,activeMs:200,outputBytes:100});expect(snapshot.correctionUsage).toBe(2);expect(snapshot.unsuccessfulCorrections).toBe(1);
});
it('enforces action output batch-count and lifetime ceilings without borrowing cleanup allowance',async()=>{
 const f=await fixture();for(let n=0;n<48;n++)value(f.campaign.approve(f.batch()));expect(f.campaign.approve(f.batch()).ok).toBe(false);
 const g=await fixture();for(let n=0;n<40;n++){const b=g.batch();b.actions.forEach(a=>{a.maxOutputBytes=131072;});value(g.campaign.approve(b));}expect(g.campaign.approve(g.batch()).ok).toBe(false);
 const h=await fixture(), b=h.batch();b.expiresAt=601001;expect(h.campaign.approve(b).ok).toBe(false);
 const j=await fixture(), c=j.batch();for(let n=0;n<4;n++)c.actions.push({...j.action(),cleanupId:c.actions[1].id});expect(j.campaign.approve(c).ok).toBe(false);
});
it('allows approved concurrent endpoint execution only through the current controller handle and sums duration',async()=>{
 const f=await fixture(),b=f.batch();b.actions[0].kind='endpoint';b.actions[0].topLevel=true;
 const second={...f.action('endpoint'),cleanupId:b.actions[1].id};b.actions.push(second);value(f.campaign.approve(b));
 value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));
 value(f.campaign.dispatch(b.id,second,{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));
 value(f.campaign.finish(b.id,b.actions[0].id,{elapsedMs:90,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));
 value(f.campaign.finish(b.id,second.id,{elapsedMs:80,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));
 expect(value(f.campaign.snapshot(f.identity.id)).consumed.activeMs).toBe(170);
});
it('restart loses in-flight handles and cannot dispatch the next ordinary approved action',async()=>{
 const f=await fixture(),b=f.batch(),second={...f.action('endpoint'),cleanupId:b.actions[1].id};b.actions.push(second);value(f.campaign.approve(b));value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));
 const restarted=new (f.campaign.constructor as typeof import('../src/qualification/campaign.ts').QualificationCampaign)(f.store,{now:()=>1001,authorizeCurrent:()=>true});
 expect(restarted.dispatch(b.id,second,{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}).ok).toBe(false);
 expect(value(restarted.snapshot(f.identity.id)).reconciliationRequired).toBe(true);
});
it('partial result persistence retains reservation until explicit protected reconciliation',async()=>{
 const f=await fixture(),b=f.batch();value(f.campaign.approve(b));value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));
 const original=f.store.appendQualification.bind(f.store);f.store.appendQualification=((owner,envelope,revision)=>envelope.kind==='CAMPAIGN_RESULT'?{ok:false,error:{code:'STORE_BUSY',message:'injected',evidenceIds:[]}}:original(owner,envelope,revision));
 expect(f.campaign.finish(b.id,b.actions[0].id,{elapsedMs:5,outputBytes:0,status:'PASS',evidenceKind:'fixture'}).ok).toBe(false);
 expect(value(f.campaign.snapshot(f.identity.id)).reserved.actions).toBe(2);expect(value(f.campaign.snapshot(f.identity.id)).reconciliationRequired).toBe(true);
 expect(value(f.store.loadAction(b.actions[0].id)).state).toBe('OBSERVED');
});
it('unexecuted corrective approvals cannot clear the stop and two failed candidate identities exhaust corrections',async()=>{
 const f=await fixture();
 const finishFailure=async(b:ReturnType<typeof f.batch>)=>{
  value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));
  async function* bytes(){yield Buffer.from('SIMULATED affected failure');}
  const ref=value(await publishArtifact(f.store,bytes(),{schemaVersion:1,id:randomUUID(),owner:f.owner,actionId:b.actions[0].id,mediaType:'text/plain',secrets:[]}));
  value(f.campaign.finish(b.id,b.actions[0].id,{elapsedMs:10,outputBytes:10,status:'FAIL',evidenceKind:'fixture',evidence:[{id:ref.id,sha256:ref.sha256,category:'operation'}]}));
  value(f.campaign.dispatch(b.id,b.actions[1],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));value(f.campaign.finish(b.id,b.actions[1].id,{elapsedMs:10,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));
  value(f.campaign.reconcile(f.identity.id,{id:randomUUID(),owner:f.owner,evidenceIds:[ref.id],targetHash:f.identity.targetHash}));return ref;
 };
 const b=f.batch();value(f.campaign.approve(b));const original=await finishFailure(b);
 const candidate={...f.batch(),correction:{candidateId:randomUUID(),affectedActionId:b.actions[0].id,evidenceIds:[original.id]}};value(f.campaign.approve(candidate));
 expect(value(f.campaign.snapshot(f.identity.id)).correctionRequired).toBe(true);expect(f.campaign.approve(f.batch()).ok).toBe(false);
 const first=await finishFailure(candidate);expect(value(f.campaign.snapshot(f.identity.id)).unsuccessfulCorrections).toBe(1);
 const second={...f.batch(),correction:{candidateId:randomUUID(),affectedActionId:candidate.actions[0].id,evidenceIds:[first.id]}};value(f.campaign.approve(second));await finishFailure(second);
 expect(value(f.campaign.snapshot(f.identity.id)).correctionUsage).toBe(2);expect(value(f.campaign.snapshot(f.identity.id)).unsuccessfulCorrections).toBe(2);
 expect(f.campaign.approve({...f.batch(),correction:{candidateId:randomUUID(),affectedActionId:b.actions[0].id,evidenceIds:[original.id]}}).ok).toBe(false);
});
it('inherits actual historical budgets from older runs with unrelated randomized repository IDs',async()=>{
 const f=await fixture(undefined,store=>{const repoId=randomUUID(),runId=randomUUID();value(store.createRun(repoId,{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));const owner=value(store.claim(repoId,runId)),actionId=randomUUID(),requestId=randomUUID();value(store.intent(owner,{schemaVersion:1,id:actionId,runId,kind:'HISTORICAL_QUALIFICATION',payload:{}}));value(store.dispatch(owner,actionId));for(const [n,kind] of ['ATTEMPT_INTENT','ATTEMPT_RESULT'].entries())value(store.appendQualification(owner,{schemaVersion:1,id:randomUUID(),runId,generation:owner.generation,actionId,requestId,targetHash:hash,kind:kind as 'ATTEMPT_INTENT'|'ATTEMPT_RESULT',payload:{ordinal:1,observation:n?{elapsedMs:900,outputBytes:250,status:'PASS'}:null}},n));value(store.outcome(owner,actionId,{schemaVersion:1,status:'RECONCILED',evidenceIds:[]}));value(store.release(owner));});
 const s=value(f.campaign.snapshot(f.identity.id));expect(s.consumed).toEqual({actions:1,activeMs:900,outputBytes:250});expect(s.correctionUsage).toBe(1);
});
it('requires immutable store lineage and explicit terminal campaign supersession without resetting usage',async()=>{
 const f=await fixture(),b=f.batch();value(f.campaign.approve(b));value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));value(f.campaign.finish(b.id,b.actions[0].id,{elapsedMs:20,outputBytes:10,status:'PASS',evidenceKind:'fixture'}));value(f.campaign.dispatch(b.id,b.actions[1],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));value(f.campaign.finish(b.id,b.actions[1].id,{elapsedMs:10,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));
 expect(typeof f.campaign.lineage).toBe('function');const id=randomUUID(),lineage=value(f.campaign.lineage(id));
 expect(f.campaign.create({...f.identity,id,lineage}).ok).toBe(false);
 value(f.campaign.create({...f.identity,id,lineage,supersedes:f.identity.id}));expect(value(f.campaign.snapshot(id)).consumed).toEqual({actions:2,activeMs:30,outputBytes:10});
 expect(f.campaign.approve(f.batch()).ok).toBe(false);expect(f.campaign.create({...f.identity,id:randomUUID(),lineage}).ok).toBe(false);
});
it('keeps same-controller authority readable between durable intent and store dispatch while restart stays conservative',async()=>{
 const f=await fixture(),b=f.batch();value(f.campaign.approve(b));let checks=0;
 f.campaign.options.authorizeCurrent=()=>{
  checks++;const state=value(f.campaign.snapshot(f.identity.id));expect(state.reconciliationRequired).toBe(false);
  if(checks===2){const restarted=new (f.campaign.constructor as typeof import('../src/qualification/campaign.ts').QualificationCampaign)(f.store,{now:()=>1000,authorizeCurrent:()=>false});expect(value(restarted.snapshot(f.identity.id)).reconciliationRequired).toBe(true);}
  return true;
 };
 value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));expect(checks).toBe(2);
 expect(value(f.store.loadAction(b.actions[0].id)).state).toBe('DISPATCHED');
});
it('global revision CAS prevents a second campaign from forking another run at one historical anchor',async()=>{
 const f=await fixture(),rows=value(f.store.listQualifications()),actionId=randomUUID();value(f.store.intent(f.owner,{schemaVersion:1,id:actionId,runId:f.owner.runId,kind:'CAS_TEST',payload:{}}));
 const repoId=randomUUID(),runId=randomUUID();value(f.store.createRun(repoId,{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));const owner=value(f.store.claim(repoId,runId)),foreignAction=randomUUID();value(f.store.intent(owner,{schemaVersion:1,id:foreignAction,runId,kind:'CONCURRENT',payload:{}}));value(f.store.appendQualification(owner,{schemaVersion:1,id:randomUUID(),runId,generation:owner.generation,actionId:foreignAction,requestId:randomUUID(),targetHash:hash,kind:'REPORT',payload:{}},0));
 expect(f.store.appendQualification(f.owner,{schemaVersion:1,id:randomUUID(),runId:f.owner.runId,generation:f.owner.generation,actionId,requestId:randomUUID(),targetHash:hash,kind:'REPORT',payload:{}},rows.filter(r=>r.runId===f.owner.runId).length,rows.length).ok).toBe(false);
});
it('cannot hide five independent primary probes behind caller-supplied auxiliary flags',async()=>{
 const f=await fixture(),b=f.batch();b.actions=[...Array.from({length:5},()=>({...f.action(),kind:'probe' as const,probeId:'worker.subscription_request',topLevel:false,cleanupId:b.actions[1].id})),b.actions[1]];
 expect(f.campaign.approve(b).ok).toBe(false);
});
it('retains unknown reservations when recovery only asserts completion without actual typed observations',async()=>{
 const f=await fixture(),b=f.batch();value(f.campaign.approve(b));value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));value(f.campaign.unknown(b.id,b.actions[0].id));
 const recovery={schemaVersion:2,kind:'campaign-recovery',campaignId:f.identity.id,batchId:b.id,actionId:b.actions[0].id,launchHash:hash,targetHash:f.identity.targetHash,owner:f.owner,reconciled:true,rootExited:true,outputComplete:true,membershipEmpty:true,brokersReconciled:true,usage:{elapsedMs:1,outputBytes:0,status:'PASS',evidenceKind:'fixture'}};
 async function* bytes(){yield Buffer.from(JSON.stringify(recovery));}const artifact=value(await publishArtifact(f.store,bytes(),{schemaVersion:1,id:randomUUID(),owner:f.owner,actionId:b.actions[0].id,mediaType:'application/json',secrets:[]}));
 expect(f.campaign.resolveUnknown(b.id,b.actions[0].id,{id:randomUUID(),evidence:[{id:artifact.id,sha256:artifact.sha256}]}).ok).toBe(false);expect(value(f.campaign.snapshot(f.identity.id)).reserved.actions).toBe(2);
});
it.each([{reserve:100,allowed:false},{reserve:30200,allowed:true}])('adopts only a bounded live-parent exact approved pending intent into its separately charged child action: %j',async({reserve,allowed})=>{
 const f=await fixture(),b=f.batch();b.actions[0].kind='endpoint';const child={...f.action('preparation'),cleanupId:randomUUID()},cleanup={...f.action('cleanup'),id:child.cleanupId};
 const launch={runId:f.owner.runId,generation:f.owner.generation,actionId:child.id,role:'pending-canary',executable:'C:\\trusted\\node.exe',argv:['C:\\fixture\\controlled-endpoint.mjs'],cwd:'C:\\fixture',env:{SystemRoot:'C:\\Windows'},boundaryHash:hash,authorization:{kind:'qualification',requestId:b.id,probeId:'auxiliary.preparation',fixtureRoots:['C:\\fixture']},stdin:'pipe',leaseTtlMs:1000,deadline:1100};child.launchHash=fingerprint(launch);child.maxMs=reserve;b.actions.push(child,cleanup);value(f.campaign.approve(b));
 value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));
 const descriptor={schemaVersion:1,owner:f.owner,parentActionId:b.actions[0].id,actionId:child.id,targetHash:f.identity.targetHash,launchHash:child.launchHash,launch};value(f.store.intent(f.owner,{schemaVersion:1,id:child.id,runId:f.owner.runId,kind:'PENDING_EXECUTION',payload:{schemaVersion:1,descriptor,ownerHash:fingerprint(f.owner),descriptorHash:fingerprint(descriptor)}}));
 expect(f.campaign.dispatch(b.id,child,{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}).ok).toBe(allowed);expect(value(f.store.loadAction(child.id)).state).toBe(allowed?'DISPATCHED':'INTENDED');
 const restarted=new (f.campaign.constructor as typeof import('../src/qualification/campaign.ts').QualificationCampaign)(f.store,{now:()=>1001,authorizeCurrent:()=>true});expect(value(restarted.snapshot(f.identity.id)).reconciliationRequired).toBe(true);
});

async function correctionFixture(){
 const f=await fixture(),b=f.batch();value(f.campaign.approve(b));
 const bound={fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash};
 value(f.campaign.dispatch(b.id,b.actions[0],bound));
 async function* bytes(){yield Buffer.from('SIMULATED corrective diagnostic failure');}
 const artifact=value(await publishArtifact(f.store,bytes(),{schemaVersion:1,id:randomUUID(),owner:f.owner,actionId:null,mediaType:'text/plain',secrets:[]}));
 const evidence={id:artifact.id,sha256:artifact.sha256,category:'simulated-failure'};
 value(f.campaign.finish(b.id,b.actions[0].id,{elapsedMs:1,outputBytes:1,status:'FAIL',evidenceKind:'fixture',evidence:[evidence]}));
 value(f.campaign.dispatch(b.id,b.actions[1],bound));value(f.campaign.finish(b.id,b.actions[1].id,{elapsedMs:1,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));
 value(f.campaign.reconcile(f.identity.id,{id:randomUUID(),owner:f.owner,evidenceIds:[evidence.id],targetHash:f.identity.targetHash}));
 const next=f.batch(),envelope={...f.action(),cleanupId:next.actions[1].id};next.actions.unshift(envelope);
 const correction={candidateId:randomUUID(),affectedActionId:b.actions[0].id,evidenceIds:[evidence.id],replacementActionId:next.actions[1].id};
 return {...f,original:b,evidence,bound,next,correction};
}
it('binds corrective preparation success to the selected diagnostic, retaining failure across envelope PASS and diagnostic FAIL',async()=>{
 const f=await correctionFixture(),b={...f.next,correction:f.correction};value(f.campaign.approve(b));
 value(f.campaign.dispatch(b.id,b.actions[0],f.bound));value(f.campaign.finish(b.id,b.actions[0].id,{elapsedMs:1,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));
 expect(value(f.campaign.snapshot(f.identity.id)).correctionRequired).toBe(true);
 value(f.campaign.dispatch(b.id,b.actions[1],f.bound));value(f.campaign.finish(b.id,b.actions[1].id,{elapsedMs:1,outputBytes:1,status:'FAIL',evidenceKind:'fixture',evidence:[f.evidence]}));
 value(f.campaign.dispatch(b.id,b.actions[2],f.bound));value(f.campaign.finish(b.id,b.actions[2].id,{elapsedMs:1,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));
 expect(value(f.campaign.snapshot(f.identity.id)).unsuccessfulCorrections).toBe(1);
 value(f.campaign.reconcile(f.identity.id,{id:randomUUID(),owner:f.owner,evidenceIds:[f.evidence.id],targetHash:f.identity.targetHash}));
 const retry=f.batch();expect(f.campaign.approve({...retry,correction:{candidateId:randomUUID(),affectedActionId:f.original.actions[0].id,evidenceIds:[f.evidence.id],replacementActionId:retry.actions[0].id}}).ok).toBe(true);
});
it('clears the affected failure only after the explicitly selected corrective diagnostic passes',async()=>{
 const f=await correctionFixture(),b={...f.next,correction:f.correction};value(f.campaign.approve(b));
 for(const a of b.actions){value(f.campaign.dispatch(b.id,a,f.bound));value(f.campaign.finish(b.id,a.id,{elapsedMs:1,outputBytes:0,status:'PASS',evidenceKind:'fixture'}));if(a.id===b.actions[0].id)expect(value(f.campaign.snapshot(f.identity.id)).correctionRequired).toBe(true);}
 const snapshot=value(f.campaign.snapshot(f.identity.id));expect(snapshot.correctionRequired).toBe(false);expect(snapshot.unsuccessfulCorrections).toBe(0);expect(snapshot.correctionUsage).toBe(1);
});
it.each(['missing','foreign','cleanup'] as const)('rejects an ambiguous corrective batch with %s selected replacement',async(selected)=>{
 const f=await correctionFixture(),correction={...f.correction};
 if(selected==='missing')delete (correction as {replacementActionId?:string}).replacementActionId;
 if(selected==='foreign')correction.replacementActionId=randomUUID();
 if(selected==='cleanup')correction.replacementActionId=f.next.actions[2].id;
 expect(f.campaign.approve({...f.next,correction}).ok).toBe(false);
});

async function approvedSuccessor(f:Awaited<ReturnType<typeof fixture>>,options:{authorize?:boolean;mutate?:(policy:import('../src/qualification/campaign.ts').CampaignExecutionPolicy)=>void;sameTarget?:boolean}={}){
 const {QualificationCampaign}=await import('../src/qualification/campaign.ts');
 const campaign=new QualificationCampaign(f.store,{now:()=>1000,authorizeCurrent:()=>true,...(options.authorize===undefined?{}:{authorizeExecutionPolicy:policy=>{expect(Object.isFrozen(policy)).toBe(true);expect(Object.isFrozen(policy.limits)).toBe(true);return options.authorize!;}})});
 const id=randomUUID(),target=options.sameTarget?f.identity.target:{...f.identity.target,model:'explicit-continuation-target'},lineage=value(campaign.lineage(id));
 const policy:import('../src/qualification/campaign.ts').CampaignExecutionPolicy={schemaVersion:1,kind:'human-execution-allowance',id:randomUUID(),campaignId:id,owner:structuredClone(f.owner),storeRootHash:lineage.storeRootHash,historyHash:lineage.historyHash,targetHash:targetFingerprint(target),approvalInstruction:'SIMULATED explicit numeric human approval; no real execution',limits:{campaignLimits:{actions:192,activeMs:12000000,outputBytes:67108864},batchLimits:{topLevelActions:4,activeMs:600000,outputBytes:2097152,approvalTtlMs:600000},maxUnsuccessfulCorrections:2},continuation:{supersedesCampaignId:f.identity.id,priorTargetHash:f.identity.targetHash,failedActionIds:value(f.campaign.snapshot(f.identity.id)).outstandingFailureIds}};
 options.mutate?.(policy);
 async function* bytes(){yield Buffer.from(JSON.stringify(policy));}
 const artifact=value(await publishArtifact(f.store,bytes(),{schemaVersion:1,id:randomUUID(),owner:f.owner,actionId:null,mediaType:'application/json',secrets:[]}));
 const identity={...f.identity,id,target,targetHash:targetFingerprint(target),lineage,supersedes:f.identity.id,executionPolicy:{id:artifact.id,sha256:artifact.sha256}};
 return {campaign,identity,policy,artifact,create:()=>campaign.create(identity)};
}
it('requires explicit protected human authorization before any larger envelope can be admitted',async()=>{
 const f=await fixture(),b=f.batch();b.actions[0].maxMs=200000;b.actions[0].maxOutputBytes=1048576;
 expect(f.campaign.approve(b).ok).toBe(false);
 const absent=await approvedSuccessor(f);expect(absent.create()).toMatchObject({ok:false,error:{code:'EXECUTION_POLICY_NOT_AUTHORIZED'}});
 const denied=await approvedSuccessor(f,{authorize:false});expect(denied.create()).toMatchObject({ok:false,error:{code:'EXECUTION_POLICY_NOT_AUTHORIZED'}});
 const allowed=await approvedSuccessor(f,{authorize:true});value(allowed.create());
 const approved={...b,campaignId:allowed.identity.id,targetHash:allowed.identity.targetHash,remaining:value(allowed.campaign.snapshot(allowed.identity.id)).remaining};
 value(allowed.campaign.approve(approved));
 expect(value(allowed.campaign.snapshot(allowed.identity.id)).reserved).toEqual({actions:2,activeMs:200100,outputBytes:1048676});
 expect(value(allowed.campaign.snapshot(allowed.identity.id)).consumed).toEqual({actions:0,activeMs:0,outputBytes:0});
});
it.each(['history','owner','store','target','same-target','missing-failure','extra-failure','correction-ceiling'] as const)('rejects %s allowance/continuation substitutions',async fault=>{
 const f=await correctionFixture();const successor=await approvedSuccessor(f,{authorize:true,sameTarget:fault==='same-target',mutate:policy=>{
  if(fault==='history')policy.historyHash='b'.repeat(64);
  if(fault==='owner')policy.owner.generation++;
  if(fault==='store')policy.storeRootHash='b'.repeat(64);
  if(fault==='target')policy.targetHash='b'.repeat(64);
  if(fault==='missing-failure')policy.continuation!.failedActionIds=[];
  if(fault==='extra-failure')policy.continuation!.failedActionIds.push(randomUUID());
  if(fault==='correction-ceiling')policy.limits.maxUnsuccessfulCorrections=3;
 }});expect(successor.create().ok).toBe(false);
});
it('continues a changed target without erasing historical failures, counters or consumption, and fences a new failure',async()=>{
 const f=await correctionFixture(),before=value(f.campaign.snapshot(f.identity.id)),next=await approvedSuccessor(f,{authorize:true});value(next.create());
 const current=value(next.campaign.snapshot(next.identity.id));
 expect(current.consumed).toEqual(before.consumed);expect(current.correctionUsage).toBe(before.correctionUsage);expect(current.unsuccessfulCorrections).toBe(before.unsuccessfulCorrections);
 expect(current.historicalFailures).toEqual(before.historicalFailures);expect(current.continuedFailureIds).toEqual([f.original.actions[0].id]);expect(current.correctionRequired).toBe(false);
 expect(value(next.campaign.aggregate(next.identity.id)).every(probe=>probe.status==='UNTESTED')).toBe(true);
 const b={...f.batch(),campaignId:next.identity.id,targetHash:next.identity.targetHash,remaining:current.remaining};value(next.campaign.approve(b));
 const bound={fixtureHash:hash,endpointHash:hash,targetHash:next.identity.targetHash};value(next.campaign.dispatch(b.id,b.actions[0],bound));value(next.campaign.finish(b.id,b.actions[0].id,{elapsedMs:1,outputBytes:0,status:'FAIL',evidenceKind:'fixture'}));
 const failed=value(next.campaign.snapshot(next.identity.id));expect(failed.fenced).toBe(true);expect(failed.correctionRequired).toBe(true);expect(failed.historicalFailures).toHaveLength(2);
});
it('retains unknown owned execution as a hard stop even with explicit allowance',async()=>{
 const f=await fixture(),b=f.batch();value(f.campaign.approve(b));value(f.campaign.dispatch(b.id,b.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:f.identity.targetHash}));value(f.campaign.unknown(b.id,b.actions[0].id));
 const next=await approvedSuccessor(f,{authorize:true});expect(next.create()).toMatchObject({ok:false,error:{code:'RECOVERY_REQUIRED'}});
});
it('revalidates the protected allowance bytes on restart rather than trusting a copied policy',async()=>{
 const f=await fixture(),next=await approvedSuccessor(f,{authorize:true});value(next.create());
 writeFileSync(join(f.store.root,'artifacts',next.artifact.sha256),JSON.stringify({...next.policy,limits:{...next.policy.limits,campaignLimits:{actions:999,activeMs:86400000,outputBytes:1073741824}}}));
 expect(next.campaign.snapshot(next.identity.id)).toMatchObject({ok:false,error:{code:'INVALID_LEDGER'}});
});
it('retains exhausted correction history and permits at most two explicitly authorized additional failures',async()=>{
 const f=await fixture((store,owner)=>{
  let revision=0;for(let index=0;index<2;index++){
   const actionId=randomUUID(),requestId=randomUUID();value(store.intent(owner,{schemaVersion:1,id:actionId,runId:owner.runId,kind:'HISTORICAL_QUALIFICATION',payload:{}}));value(store.dispatch(owner,actionId));
   for(const kind of ['ATTEMPT_INTENT','ATTEMPT_RESULT'] as const)value(store.appendQualification(owner,{schemaVersion:1,id:randomUUID(),runId:owner.runId,generation:owner.generation,actionId,requestId,targetHash:hash,kind,payload:{ordinal:1,observation:kind==='ATTEMPT_RESULT'?{elapsedMs:50,outputBytes:25,status:'FAIL'}:null}},revision++));
   value(store.outcome(owner,actionId,{schemaVersion:1,status:'RECONCILED',evidenceIds:[]}));
  }
 });
 const before=value(f.campaign.snapshot(f.identity.id));expect(before.unsuccessfulCorrections).toBe(2);expect(before.historicalFailures).toHaveLength(2);expect(f.campaign.approve(f.batch()).ok).toBe(false);
 const next=await approvedSuccessor(f,{authorize:true,mutate:policy=>{policy.limits.maxUnsuccessfulCorrections=4;policy.continuation!.failedActionIds=[before.historicalFailures.at(-1)!.actionId];}});value(next.create());
 const current=value(next.campaign.snapshot(next.identity.id));expect(current.unsuccessfulCorrections).toBe(2);expect(current.correctionUsage).toBe(2);expect(current.historicalFailures).toHaveLength(2);expect(current.consumed).toEqual({actions:2,activeMs:100,outputBytes:50});
 const b={...f.batch(),campaignId:next.identity.id,targetHash:next.identity.targetHash,remaining:current.remaining};expect(next.campaign.approve(b).ok).toBe(true);
});
it('still enforces four top-level actions, ten-minute expiry and fresh launch authority under an enlarged allowance',async()=>{
 const f=await fixture(),next=await approvedSuccessor(f,{authorize:true});value(next.create());
 const batch=()=>({...f.batch(),campaignId:next.identity.id,targetHash:next.identity.targetHash,remaining:value(next.campaign.snapshot(next.identity.id)).remaining});
 const tooLong=batch();tooLong.expiresAt=tooLong.approvedAt+600001;expect(next.campaign.approve(tooLong).ok).toBe(false);
 const tooMany=batch();tooMany.actions.push(...Array.from({length:4},()=>({...f.action(),cleanupId:tooMany.actions[1].id})));expect(next.campaign.approve(tooMany).ok).toBe(false);
 const valid=batch();value(next.campaign.approve(valid));
 const restarted=new (next.campaign.constructor as typeof import('../src/qualification/campaign.ts').QualificationCampaign)(f.store,{now:()=>1000,authorizeCurrent:()=>false});
 expect(restarted.dispatch(valid.id,valid.actions[0],{fixtureHash:hash,endpointHash:hash,targetHash:next.identity.targetHash}).ok).toBe(false);
});
it('cannot transfer an approved larger allowance to another target by ordinary reconciliation',async()=>{
 const f=await fixture(),next=await approvedSuccessor(f,{authorize:true});value(next.create());const target={...next.identity.target,model:'unapproved-third-target'};
 expect(next.campaign.reconcile(next.identity.id,{id:randomUUID(),owner:f.owner,evidenceIds:[randomUUID()],target,targetHash:targetFingerprint(target)})).toMatchObject({ok:false,error:{code:'EXECUTION_POLICY_TARGET_CHANGED'}});
 expect(value(next.campaign.snapshot(next.identity.id)).targetHash).toBe(next.identity.targetHash);
});
