import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runTask, type RunTaskDependencies } from '../src/controller/run-task.ts';
import { openStore } from '../src/store/database.ts';

async function setup(mode='success'){
 const root=await mkdtemp(join(tmpdir(),'ouroboros-run-unit-'));const source=join(root,'source');await mkdir(source);
 execFileSync('git',['init','--quiet',source],{windowsHide:true});
 await writeFile(join(source,'answer.txt'),'before\r\n');await writeFile(join(source,'check.mjs'),'trusted check\r\n');
 const calls:string[]=[];
 const deps:RunTaskDependencies={dataRoot:join(root,'data'),workspacesRoot:join(root,'workspaces'),runtimeFactory:options=>({
  async implement(){calls.push('implement');await writeFile(join(options.workspaceRoot,'answer.txt'),mode==='latin1'?Buffer.from([0x63,0x61,0x66,0xe9,0x0a]):'after\r\n');if(mode==='protected')await writeFile(join(options.workspaceRoot,'check.mjs'),'weakened');return {ok:true,code:'TURN_COMPLETED',evidenceIds:[]};},
  async verify(){calls.push('verify');if(mode==='mutation')await writeFile(join(options.workspaceRoot,'answer.txt'),'late mutation');return {ok:mode!=='failed',code:mode==='failed'?'VERIFICATION_FAILED':'VERIFICATION_PASSED',evidenceIds:[],exitCode:mode==='failed'?1:0};},
  async cancel(){calls.push('cancel');if(mode==='cleanup')throw Error('Cleanup failed');if(mode==='release')options.store.release=()=>({ok:false,error:{code:'STORE_BUSY',message:'busy',evidenceIds:[]}});},
 })};
 const input={schemaVersion:1,repository:source,task:'Change answer.txt',model:'fixture-model',allowedPaths:['answer.txt'],verification:{executable:process.execPath,argv:['-e','process.exit(0)'],inputs:['check.mjs']}};
 return {root,source,input,deps,calls};
}
it('runs a task through separate implementation and verification then exports a patch without qualification',async()=>{
 const f=await setup();const report=await runTask(f.input,f.deps);
 expect(report.status).toBe('READY_FOR_REVIEW');expect(report.sourcePreserved).toBe(true);expect(f.calls).toEqual(['implement','verify','cancel']);
 expect(await readFile(join(f.source,'answer.txt'),'utf8')).toBe('before\r\n');expect(report.patch).not.toBeNull();expect(await readFile(report.patch!,'utf8')).toContain('+after');
 const store=openStore(f.deps.dataRoot!);try{expect(store.listQualifications()).toEqual({ok:true,value:[]});expect(store.loadRun(report.runId)).toMatchObject({ok:true,value:{phase:'READY_FOR_REVIEW',pendingActionIds:[]}});}finally{store.close();}
});
it('keeps a wall-clock task deadline separate from summed root and helper process time',async()=>{
 const f=await setup();const original=f.deps.runtimeFactory!;let recordedMs=0;
 f.deps.runtimeFactory=options=>{
  expect(options.deadline-Date.now()).toBeGreaterThan(119000);
  expect(options.deadline-Date.now()).toBeLessThanOrEqual(120000);
  const runtime=original(options);
  return {...runtime,async implement(prompt){
   const actionId=randomUUID();
   expect(options.store.intent(options.owner,{schemaVersion:1,id:actionId,runId:options.owner.runId,kind:'IMPLEMENT',payload:{}}).ok).toBe(true);
   expect(options.store.dispatch(options.owner,actionId).ok).toBe(true);
   for(const [kind,pid,activeMs] of [['root',101,70000],['helper',102,71000]] as const){
    const usage=options.store.recordProcessUsage(options.owner,actionId,{kind,identity:{pid,creationIdentity:kind},activeMs});
    expect(usage.ok).toBe(true);if(!usage.ok)throw Error(usage.error.code);
    expect(usage.value.limit).toBe(false);recordedMs=usage.value.activeMs;
   }
   expect(options.store.outcome(options.owner,actionId,{schemaVersion:1,status:'SUCCEEDED',evidenceIds:[]}).ok).toBe(true);
   return runtime.implement(prompt);
  }};
 };
 const report=await runTask({...f.input,timeoutMs:120000},f.deps);
 expect(report.status).toBe('READY_FOR_REVIEW');expect(recordedMs).toBe(141000);
 const store=openStore(f.deps.dataRoot!);try{expect(store.loadRun(report.runId)).toMatchObject({ok:true,value:{cumulativeBudgets:{activeMs:141000}}});}finally{store.close();}
});
it('still rejects exhausted summed process time under the finite task process allowance',async()=>{
 const f=await setup();const original=f.deps.runtimeFactory!;
 f.deps.runtimeFactory=options=>({...original(options),async implement(){
  const actionId=randomUUID();
  expect(options.store.intent(options.owner,{schemaVersion:1,id:actionId,runId:options.owner.runId,kind:'IMPLEMENT',payload:{}}).ok).toBe(true);
  expect(options.store.dispatch(options.owner,actionId).ok).toBe(true);
  const usage=options.store.recordProcessUsage(options.owner,actionId,{kind:'root',identity:{pid:103,creationIdentity:'exhausted'},activeMs:400000});
  expect(usage.ok&&usage.value.limit).toBe(true);
  expect(options.store.outcome(options.owner,actionId,{schemaVersion:1,status:'FAILED',evidenceIds:[]}).ok).toBe(true);
  return {ok:false,code:'ACTIVE_LIMIT_EXCEEDED',evidenceIds:[]};
 }});
 const report=await runTask({...f.input,timeoutMs:120000},f.deps);
 expect(report).toMatchObject({status:'FAILED',code:'ACTIVE_LIMIT_EXCEEDED',patch:null,sourcePreserved:true});expect(f.calls).toEqual(['cancel']);
});
it('failed verification never exports or reports a ready patch',async()=>{
 const f=await setup('failed');const report=await runTask(f.input,f.deps);expect(report).toMatchObject({status:'FAILED',code:'VERIFICATION_FAILED',patch:null,sourcePreserved:true});
});
it('protects fixed acceptance inputs from worker changes before running verification',async()=>{
 const f=await setup('protected');const report=await runTask(f.input,f.deps);expect(report.status).toBe('FAILED');expect(report.patch).toBeNull();expect(f.calls).toEqual(['implement','cancel']);
});
it('refuses a ready result when the verifier changed candidate bytes',async()=>{
 const f=await setup('mutation');const report=await runTask(f.input,f.deps);expect(report.status).toBe('FAILED');expect(report.patch).toBeNull();
});
it('withholds an otherwise verified patch if cleanup is unconfirmed',async()=>{
 const f=await setup('cleanup');const report=await runTask(f.input,f.deps);expect(report).toMatchObject({status:'RECOVERY_REQUIRED',code:'CLEANUP_UNCONFIRMED',patch:null,sourcePreserved:true});
});
it('does not report readiness when durable ownership release fails',async()=>{
 const f=await setup('release');const report=await runTask(f.input,f.deps);expect(report).toMatchObject({status:'RECOVERY_REQUIRED',code:'STORE_BUSY',patch:null,sourcePreserved:true});
 const store=openStore(f.deps.dataRoot!);try{expect(store.loadRun(report.runId)).toMatchObject({ok:true,value:{phase:'RECOVERY_REQUIRED'}});}finally{store.close();}
});
it('protects the literal verifier script even without explicit inputs',async()=>{
 const f=await setup('protected');f.input.allowedPaths.push('check.mjs');f.input.verification.inputs=[];f.input.verification.argv=['check.mjs'];
 const report=await runTask(f.input,f.deps);expect(report.status).toBe('FAILED');expect(f.calls).toEqual(['implement','cancel']);
});
it('preserves non-UTF8 text patch bytes in the evidence artifact',async()=>{
 const f=await setup('latin1');const report=await runTask(f.input,f.deps);expect(report.status).toBe('READY_FOR_REVIEW');
 const patch=await readFile(report.patch!);expect(patch.includes(0xe9)).toBe(true);
 const store=openStore(f.deps.dataRoot!);try{const artifact=store.listArtifacts(report.runId).find(a=>a.mediaType==='text/x-diff')!;expect(artifact.sha256).toBe(createHash('sha256').update(patch).digest('hex'));expect(await readFile(join(store.root,'artifacts',artifact.sha256))).toEqual(patch);}finally{store.close();}
});
it.each([['--test'],['--test','tests/*.test.mjs']])('requires protected inputs for test discovery: %j',async(...argv)=>{
 const f=await setup();f.input.verification.inputs=[];f.input.verification.argv=argv;
 const report=await runTask(f.input,f.deps);expect(report.code).toBe('VERIFICATION_INPUTS_REQUIRED');expect(f.calls).toEqual([]);
});
it('does not protect the mutable target of a fixed Node syntax check',async()=>{
 const f=await setup();f.input.verification.inputs=[];f.input.verification.argv=['--check','answer.txt'];
 const report=await runTask(f.input,f.deps);expect(report.status).toBe('READY_FOR_REVIEW');expect(f.calls).toEqual(['implement','verify','cancel']);
});
it.each(['--check','--eval'])('script argument %s cannot bypass verifier entry protection',async arg=>{
 const f=await setup('protected');f.input.allowedPaths.push('check.mjs');f.input.verification.inputs=[];f.input.verification.argv=['check.mjs',arg,'ignored'];
 const report=await runTask(f.input,f.deps);expect(report.status).toBe('FAILED');expect(f.calls).toEqual(['implement','cancel']);
});
