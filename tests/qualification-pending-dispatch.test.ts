import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openStore, type RunStore } from '../src/store/database.ts';
import type { Result } from '../src/contracts/common.ts';
import type { OwnerToken } from '../src/contracts/evidence.ts';
import type { LaunchSpec, OwnedExecution, Supervisor } from '../src/contracts/execution.ts';
import { fingerprint } from '../src/qualification/probes.ts';
const stores:RunStore[]=[];afterEach(()=>{for(const store of stores.splice(0))store.close();});
const value=<T>(result:Result<T>):T=>{expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.code);return result.value;};
async function fixture(){
 const modules=import.meta.glob('../src/qualification/pending-dispatch.ts');expect(Object.keys(modules)).toHaveLength(1);
 const module=await modules['../src/qualification/pending-dispatch.ts']() as typeof import('../src/qualification/pending-dispatch.ts');
 const root=mkdtempSync(join(tmpdir(),'ouroboros-pending-')),store=openStore(root);stores.push(store);
 const repoId=randomUUID(),runId=randomUUID();value(store.createRun(repoId,{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));
 const owner=value(store.claim(repoId,runId)),actionId=randomUUID(),parentActionId=randomUUID();
 value(store.intent(owner,{schemaVersion:1,id:parentActionId,runId,kind:'CONTROLLER_PROBE',payload:{}}));value(store.dispatch(owner,parentActionId));
 const launch:LaunchSpec={runId,generation:owner.generation,actionId,role:'pending-canary',executable:'D:\\trusted\\node.exe',argv:['--preserve-symlinks-main','D:\\trusted\\session-activity.mjs','foreground','D:\\fixture'],cwd:'D:\\fixture\\workspace',env:{},boundaryHash:'b'.repeat(64),authorization:{kind:'qualification',requestId:randomUUID(),probeId:'auxiliary.preparation',fixtureRoots:['D:\\fixture']},stdin:'closed',leaseTtlMs:10000,deadline:Date.now()+10000};
 const descriptor={schemaVersion:1 as const,owner,parentActionId,actionId,targetHash:'a'.repeat(64),launchHash:fingerprint(launch),launch};
 let chargeCalls=0,launchCalls=0;const launched:LaunchSpec[]=[];
 const supervisor:Supervisor={launchOwned:async input=>{launchCalls++;launched.push(structuredClone(input) as LaunchSpec);const receipt={schemaVersion:1 as const,runId:input.runId,generation:input.generation,actionId:input.actionId,role:input.role,environment:'windows' as const,pid:101,creationIdentity:'0000000000000101',helperPid:102,helperCreationIdentity:'0000000000000102',jobIdentity:'pending-owned-job',boundaryHash:input.boundaryHash,assignedBeforeResume:true as const,capturedAt:1};return {ok:true,value:{describe:async()=>receipt,fence:async()=>{},renewLease:async()=>{},drain:async()=>{throw Error('Not part of queue dispatch');},onOutput:()=>()=>{},writeInput:async()=>({ok:true,value:undefined}),endInput:async()=>({ok:true,value:undefined})}};}};
 const charged=async(d:typeof descriptor,effect:(supervisor:Supervisor)=>Promise<Result<OwnedExecution>>)=>{chargeCalls++;const dispatched=store.dispatch(d.owner,d.actionId);if(!dispatched.ok)return dispatched;return effect(supervisor);};
 const queue=module.createPendingDispatchQueue(store,{chargedDispatch:charged});
 const another=()=>{const second=openStore(root);stores.push(second);return second;};
 return {module,root,store,owner,descriptor,supervisor,queue,another,charged,launched,counts:()=>({chargeCalls,launchCalls})};
}
it('persists a genuine immutable queued descriptor across independent store handles',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));f.descriptor.launch.argv.push('unapproved');
 const second=f.module.createPendingDispatchQueue(f.another(),{chargedDispatch:f.charged});const state=value(second.inspect(f.owner,f.descriptor.actionId));
 expect(state).toMatchObject({actionId:f.descriptor.actionId,generation:f.owner.generation,state:'pending',dispatchCount:0,createdProcessIdentities:[]});
 const action=value(f.store.loadAction(f.descriptor.actionId));expect(action.kind).toBe('PENDING_EXECUTION');expect((action.payload.descriptor as any).launch.argv).toEqual(['--preserve-symlinks-main','D:\\trusted\\session-activity.mjs','foreground','D:\\fixture']);expect(f.counts()).toEqual({chargeCalls:0,launchCalls:0});
});
it('atomically cancels only INTENDED actions and refuses future dispatch before charging or launch',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));value(f.queue.cancel(f.owner,f.descriptor.actionId));
 expect(value(f.queue.inspect(f.owner,f.descriptor.actionId))).toMatchObject({state:'cancelled-before-dispatch',dispatchCount:0,createdProcessIdentities:[]});
 expect(value(f.store.loadAction(f.descriptor.actionId))).toMatchObject({state:'OBSERVED',outcome:{status:'CANCELLED'}});expect(value(f.store.loadRun(f.owner.runId)).pendingActionIds).not.toContain(f.descriptor.actionId);
 expect((await f.queue.dispatch(f.owner,f.descriptor.actionId)).ok).toBe(false);expect(f.counts()).toEqual({chargeCalls:0,launchCalls:0});expect(f.queue.cancel(f.owner,f.descriptor.actionId).ok).toBe(false);
});
it('does not weaken the existing outcome transition for an undispatched action',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));expect(f.store.outcome(f.owner,f.descriptor.actionId,{schemaVersion:1,status:'CANCELLED',evidenceIds:[]}).ok).toBe(false);expect(value(f.store.loadAction(f.descriptor.actionId)).state).toBe('INTENDED');
});
it('lets the charged dispatcher claim exactly once and persists only actual supervisor creation receipts',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));const result=await f.queue.dispatch(f.owner,f.descriptor.actionId);expect(result.ok).toBe(true);
 const observed=value(f.queue.inspect(f.owner,f.descriptor.actionId));expect(observed.dispatchCount).toBe(1);expect(observed.createdProcessIdentities).toEqual(['root:101:0000000000000101','helper:102:0000000000000102']);expect(observed.creationEvidenceIds).toHaveLength(1);
 const artifact=value(f.store.loadArtifact(observed.creationEvidenceIds[0]!));expect(artifact.actionId).toBe(f.descriptor.actionId);expect(JSON.parse(readFileSync(join(f.root,'artifacts',artifact.sha256),'utf8')).ownership.pid).toBe(101);
 expect((await f.queue.dispatch(f.owner,f.descriptor.actionId)).ok).toBe(false);expect(f.counts()).toEqual({chargeCalls:1,launchCalls:1});expect(f.launched[0]).toEqual(f.descriptor.launch);
});
it('refuses cancellation if an independent store handle already won dispatch',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));value(f.another().dispatch(f.owner,f.descriptor.actionId));expect(f.queue.cancel(f.owner,f.descriptor.actionId).ok).toBe(false);expect(value(f.queue.inspect(f.owner,f.descriptor.actionId))).toMatchObject({state:'dispatched',dispatchCount:1,createdProcessIdentities:[]});
});
it('lets cancellation during charged admission prevent the dispatch claim and supervisor call',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));const second=f.another();let actualEffects=0;
 const queue=f.module.createPendingDispatchQueue(f.store,{chargedDispatch:async(d,effect)=>{value(second.cancelUndispatched(d.owner,d.actionId));const dispatched=second.dispatch(d.owner,d.actionId);if(!dispatched.ok)return dispatched;actualEffects++;return effect(f.supervisor);}});
 expect((await queue.dispatch(f.owner,f.descriptor.actionId)).ok).toBe(false);expect(actualEffects).toBe(0);expect(f.counts().launchCalls).toBe(0);expect(value(queue.inspect(f.owner,f.descriptor.actionId))).toMatchObject({state:'cancelled-before-dispatch',dispatchCount:0});
});
it('refuses an uncharged callback, replayed callback, or fabricated supervisor outcome',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));const uncharged=f.module.createPendingDispatchQueue(f.store,{chargedDispatch:async(_d,effect)=>effect(f.supervisor)});
 expect((await uncharged.dispatch(f.owner,f.descriptor.actionId)).ok).toBe(false);expect(f.counts().launchCalls).toBe(0);
 const replay=f.module.createPendingDispatchQueue(f.store,{chargedDispatch:async(d,effect)=>{value(f.store.dispatch(d.owner,d.actionId));const first=await effect(f.supervisor);expect((await effect(f.supervisor)).ok).toBe(false);return first;}});
 expect((await replay.dispatch(f.owner,f.descriptor.actionId)).ok).toBe(false);expect(f.counts().launchCalls).toBe(1);
});
it('retains unknown dispatched outcomes without replay when the supervisor outcome is uncertain',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));let calls=0;const queue=f.module.createPendingDispatchQueue(f.store,{chargedDispatch:async(d,effect)=>{value(f.store.dispatch(d.owner,d.actionId));return effect({launchOwned:async()=>{calls++;throw Error('launch outcome unknown');}});}});
 expect((await queue.dispatch(f.owner,f.descriptor.actionId)).ok).toBe(false);expect(value(queue.inspect(f.owner,f.descriptor.actionId))).toMatchObject({state:'outcome-unknown',dispatchCount:1,createdProcessIdentities:[]});expect((await queue.dispatch(f.owner,f.descriptor.actionId)).ok).toBe(false);expect(calls).toBe(1);expect(queue.cancel(f.owner,f.descriptor.actionId).ok).toBe(false);
});
it('fences stale nonces, cross-run IDs and descriptor hash substitution without effects',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));const stale={...f.owner,nonce:randomUUID()};expect(f.queue.cancel(stale,f.descriptor.actionId).ok).toBe(false);expect((await f.queue.dispatch(stale,f.descriptor.actionId)).ok).toBe(false);
 const foreign={...f.owner,runId:randomUUID()};expect(f.queue.inspect(foreign,f.descriptor.actionId).ok).toBe(false);
 const changed={...f.descriptor,actionId:randomUUID(),launchHash:'f'.repeat(64)};expect(f.queue.enqueue(changed).ok).toBe(false);expect(f.counts()).toEqual({chargeCalls:0,launchCalls:0});
});
it('rechecks the owner fence after the adjacent beforeEffect callback',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));let guards=0;
 const result=f.queue.cancel(f.owner,f.descriptor.actionId,()=>{guards++;value(f.another().dispatch(f.owner,f.descriptor.actionId));});expect(result.ok).toBe(false);expect(guards).toBe(1);expect(value(f.store.loadAction(f.descriptor.actionId)).state).toBe('DISPATCHED');
});

it('atomically adopts the exact pending payload with the campaign journal record',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));const action=value(f.store.loadAction(f.descriptor.actionId));
 const envelope={schemaVersion:1 as const,id:randomUUID(),runId:f.owner.runId,generation:f.owner.generation,actionId:f.descriptor.actionId,requestId:randomUUID(),targetHash:f.descriptor.targetHash,kind:'CAMPAIGN_DISPATCH' as const,payload:{}};
 value(f.store.appendQualification(f.owner,envelope,0,0,action.payload));expect(value(f.store.loadAction(action.id)).state).toBe('DISPATCHED');expect(value(f.store.listEvents(f.owner.runId)).filter(e=>e.kind==='ACTION_DISPATCHED'&&e.payload.actionId===action.id)).toHaveLength(1);
});
it('appends no campaign record when cancellation won atomic pending adoption',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));const action=value(f.store.loadAction(f.descriptor.actionId));value(f.another().cancelUndispatched(f.owner,action.id));
 const envelope={schemaVersion:1 as const,id:randomUUID(),runId:f.owner.runId,generation:f.owner.generation,actionId:action.id,requestId:randomUUID(),targetHash:f.descriptor.targetHash,kind:'CAMPAIGN_DISPATCH' as const,payload:{}};
 expect(f.store.appendQualification(f.owner,envelope,0,0,action.payload).ok).toBe(false);expect(value(f.store.listQualifications(f.owner.runId))).toHaveLength(0);
});
it('retains the exact actual pending execution for charged cleanup after post-launch validation failure',async()=>{
 const f=await fixture();value(f.queue.enqueue(f.descriptor));const launched=value(await f.supervisor.launchOwned(f.descriptor.launch));
 const invalid={...launched,describe:async()=>({...await launched.describe(),actionId:randomUUID()})};
 const queue=f.module.createPendingDispatchQueue(f.store,{chargedDispatch:async(d,effect)=>{value(f.store.dispatch(d.owner,d.actionId));return effect({launchOwned:async()=>({ok:true,value:invalid})});}});
 expect((await queue.dispatch(f.owner,f.descriptor.actionId)).ok).toBe(false);expect(value(queue.inspect(f.owner,f.descriptor.actionId)).state).toBe('outcome-unknown');
 expect(typeof queue.recoverOwned).toBe('function');expect(value(queue.recoverOwned(f.owner,f.descriptor.actionId))).toBe(invalid);expect(queue.recoverOwned({...f.owner,nonce:randomUUID()},f.descriptor.actionId).ok).toBe(false);
});
