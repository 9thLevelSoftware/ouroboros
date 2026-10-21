import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openStore } from '../store/database.ts';
import { publishArtifact } from '../store/artifacts.ts';
import { DEFAULT_LIMITS } from '../contracts/task.ts';
import type { Result } from '../contracts/common.ts';
import type { RunRecord } from '../contracts/run.ts';
import type { OwnerToken } from '../contracts/evidence.ts';
import { snapshotLocalTask, assertSourceUnchanged, captureCandidate } from '../workspace/local-task.ts';
import { exportLocalPatch } from '../workspace/patch.ts';
import { createCodexTaskRuntime, type CodexTaskRuntimeOptions } from './codex-task-runtime.ts';
import type { SafeBootstrapDiagnostic } from '../qualification/bootstrap-diagnostic.ts';
import type { SafeCodexProtocolDiagnostic } from '../providers/codex/adapter.ts';

const literal=z.string().min(1).max(16384).refine(value=>!value.includes('\0'));
const absolute=literal.refine(isAbsolute,'Absolute path required');
export const RunTaskSchema=z.strictObject({
 schemaVersion:z.literal(1),repository:absolute,task:literal,model:literal,effort:z.enum(['low','medium','high','xhigh','max','ultra']).default('medium'),
 allowedPaths:z.array(literal).min(1).max(128),protectedPaths:z.array(literal).max(128).default([]),
 verification:z.strictObject({executable:absolute,argv:z.array(z.string().max(16384).refine(v=>!v.includes('\0'))).max(128),inputs:z.array(literal).max(128).default([]),timeoutMs:z.number().int().positive().max(300000).default(60000)}),
 timeoutMs:z.number().int().min(10000).max(1800000).default(300000),maxSnapshotBytes:z.number().int().positive().max(1073741824).default(67108864),
 runtimePath:absolute.optional(),helperPath:absolute.optional(),
});
export type RunTask=z.infer<typeof RunTaskSchema>;
export type TaskRunReport={schemaVersion:1;runId:string;status:RunRecord['phase'];code:string;sourcePreserved:boolean;workspace:string|null;patch:string|null;applyStrip:number|null;reportPath:string;changedFiles:string[];evidenceIds:string[];diagnostics?:Array<{stage:'implementation'|'verification';value:SafeBootstrapDiagnostic}>;protocolDiagnostics?:Array<{stage:'implementation'|'verification';facts:SafeCodexProtocolDiagnostic[]}>;runtimeDiagnostics?:Array<{stage:'implementation'|'verification';message:string}>};
export type RunTaskDependencies={dataRoot?:string;workspacesRoot?:string;runtimeFactory?:(options:CodexTaskRuntimeOptions)=>ReturnType<typeof createCodexTaskRuntime>;signal?:AbortSignal;onEvent?:(event:unknown)=>void};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function unwrap<T>(value:Result<T>):T{if(!value.ok)throw Object.assign(Error(value.error.code),{code:value.error.code});return value.value;}
function taskProcessBudgetMs(timeoutMs:number):number{
 // timeoutMs is the task's wall-clock deadline. Usage sums both the native
 // helper and its root, across three sequential owned actions: implementation,
 // verifier policy inspection, and verification. Reserve their bounded cleanup
 // as well; retain every measured process millisecond in the shared counter.
 return 2*(timeoutMs+3*15000);
}
function repositoryId(path:string):string{const h=digest(resolve(path).toLowerCase());return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
async function* bytes(text:string|Buffer){yield Buffer.isBuffer(text)?text:Buffer.from(text);}
async function verificationInputs(workspaceRoot:string,task:RunTask):Promise<string[]>{
 const paths=new Set([...task.protectedPaths,...task.verification.inputs]);
 let boundArgument=false;
 const node=/^node(?:\.exe)?$/i.test(basename(task.verification.executable));
 const inline=node&&['-e','--eval'].includes(task.verification.argv[0])&&Boolean(task.verification.argv[1]);
 const syntaxCheck=node&&['-c','--check'].includes(task.verification.argv[0]);
 // A plain Node entry script is trusted verification code; its later argv
 // values can be mutable code under test. Discovery/configuration needs
 // explicit protected inputs instead of guessing which arguments are checks.
 const entry=node&&!inline&&!syntaxCheck&&!task.verification.argv[0]?.startsWith('-')?task.verification.argv[0]:undefined;
 for(const arg of entry?[entry]:[]){
  if(!arg||arg.startsWith('-')||arg.includes('\0'))continue;
  const path=resolve(workspaceRoot,arg);const local=relative(workspaceRoot,path);
  if(!local||local==='..'||local.startsWith(`..${sep}`)||isAbsolute(local))continue;
  try{const stat=await lstat(path);if(stat.isFile()||stat.isDirectory()){paths.add(local.split(sep).join('/'));boundArgument=true;}}catch(error){if(!['ENOENT','ENAMETOOLONG','EINVAL'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
 }
 if(!task.verification.inputs.length&&!boundArgument&&!inline&&!syntaxCheck)throw Object.assign(Error('VERIFICATION_INPUTS_REQUIRED'),{code:'VERIFICATION_INPUTS_REQUIRED'});
 return [...paths];
}

/** Explicit local task execution. It neither reads nor confers qualification. */
export async function runTask(input:unknown,deps:RunTaskDependencies={}):Promise<TaskRunReport>{
 const task=RunTaskSchema.parse(input);const runId=randomUUID();
 const local=process.env.LOCALAPPDATA;if(!deps.dataRoot&&!local)throw Error('LOCALAPPDATA or explicit task data root required');
 const dataRoot=resolve(deps.dataRoot??join(local!,'Ouroboros','tasks'));
 const workspaceParent=resolve(deps.workspacesRoot??join(local!,'Ouroboros','workspaces'));
 const destinationRoot=join(workspaceParent,runId);const reportPath=join(dataRoot,'reports',`${runId}.json`);
 await mkdir(workspaceParent,{recursive:true});await mkdir(dirname(reportPath),{recursive:true});
 const store=openStore(dataRoot);let runtime:ReturnType<typeof createCodexTaskRuntime>|undefined;
 let snapshot:Awaited<ReturnType<typeof snapshotLocalTask>>|undefined;
 const report:TaskRunReport={schemaVersion:1,runId,status:'FAILED',code:'TASK_NOT_STARTED',sourcePreserved:false,workspace:null,patch:null,applyStrip:null,reportPath,changedFiles:[],evidenceIds:[]};
 let owner:OwnerToken|undefined;
 try{
  unwrap(store.createRun(repositoryId(task.repository),{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]},{...DEFAULT_LIMITS,activeMs:taskProcessBudgetMs(task.timeoutMs),verificationMs:Math.min(task.verification.timeoutMs,task.timeoutMs),maxSnapshotBytes:task.maxSnapshotBytes}));
  owner=unwrap(store.claim(repositoryId(task.repository),runId));
  if(deps.signal?.aborted){report.status='CANCELLED';report.code='USER_CANCELLED';return report;}
  snapshot=await snapshotLocalTask({sourceRoot:task.repository,destinationRoot,maxBytes:task.maxSnapshotBytes});report.workspace=snapshot.workspaceRoot;
  const baseline=unwrap(await publishArtifact(store,bytes(JSON.stringify(snapshot.sourceManifest)),{schemaVersion:1,id:randomUUID(),owner,actionId:null,mediaType:'application/json',secrets:[]}));
  report.evidenceIds.push(baseline.id);
  const protectedPaths=await verificationInputs(snapshot.workspaceRoot,task);
  const prompt=`${task.task}\n\nWork only in ${snapshot.workspaceRoot}. Allowed paths: ${JSON.stringify(task.allowedPaths)}. Do not alter protected verification inputs: ${JSON.stringify(protectedPaths)}. Preserve unrelated files. Do not commit, push, publish, install software or request permission escalation. The controller independently runs the fixed verification command after you finish. Tool executable available: ${process.execPath}. When running Node files in this restricted workspace, use --preserve-symlinks-main --preserve-symlinks to avoid ancestor realpath probes. The snapshot contains no symbolic links.`;
  const promptRef=unwrap(await publishArtifact(store,bytes(prompt),{schemaVersion:1,id:randomUUID(),owner,actionId:null,mediaType:'text/plain',secrets:[]}));
  const installationRoot=fileURLToPath(new URL('../../',import.meta.url));
  const runtimePath=task.runtimePath??join(process.env.APPDATA??'','npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  const helperPath=task.helperPath??join(installationRoot,'native','supervisor','target','release','ouroboros-supervisor.exe');
  runtime=(deps.runtimeFactory??createCodexTaskRuntime)({store,owner,authorization:{kind:'user-task',authorizationId:randomUUID(),taskHash:digest(task)},workspaceRoot:snapshot.workspaceRoot,protectedRoots:[snapshot.sourceRoot,snapshot.baselineRoot,join(destinationRoot,'controller'),dataRoot],runtimePath,helperPath,verificationCommand:task.verification,model:task.model,effort:task.effort,deadline:Date.now()+task.timeoutMs,onEvent:deps.onEvent,signal:deps.signal});
  unwrap(store.updateRunState(owner,{phase:'IMPLEMENTING',baselineRef:baseline.id}));
  const implementation=await runtime.implement(promptRef);report.evidenceIds.push(...implementation.evidenceIds);
  if(implementation.runtimeDiagnostic)(report.runtimeDiagnostics??=[]).push({stage:'implementation',message:implementation.runtimeDiagnostic});
  if(implementation.diagnostic)(report.diagnostics??=[]).push({stage:'implementation',value:implementation.diagnostic});
  if(implementation.protocolDiagnostics?.length)(report.protocolDiagnostics??=[]).push({stage:'implementation',facts:implementation.protocolDiagnostics});
  if(!implementation.ok){report.code=implementation.code;report.status=deps.signal?.aborted?'CANCELLED':implementation.code.includes('QUOTA')?'WAITING_FOR_QUOTA':implementation.code.includes('AUTH')?'WAITING_FOR_AUTH':'FAILED';return report;}
  const candidate=await captureCandidate(snapshot,{allowedPaths:task.allowedPaths,protectedPaths});
  report.changedFiles=candidate.changedFiles.map(change=>change.path);
  if(!candidate.changedFiles.length){report.status='NO_PROGRESS';report.code='NO_CHANGES';return report;}
  unwrap(store.updateRunState(owner,{phase:'VERIFYING'}));
  const verified=await runtime.verify(task.verification);report.evidenceIds.push(...verified.evidenceIds);
  if(verified.runtimeDiagnostic)(report.runtimeDiagnostics??=[]).push({stage:'verification',message:verified.runtimeDiagnostic});
  if(verified.diagnostic)(report.diagnostics??=[]).push({stage:'verification',value:verified.diagnostic});
  if(verified.protocolDiagnostics?.length)(report.protocolDiagnostics??=[]).push({stage:'verification',facts:verified.protocolDiagnostics});
  if(!verified.ok){report.status=deps.signal?.aborted?'CANCELLED':'FAILED';report.code=verified.code;return report;}
  await assertSourceUnchanged(snapshot);
  const patch=await exportLocalPatch(snapshot,candidate.candidateManifest);
  const candidateRef=unwrap(await publishArtifact(store,bytes(JSON.stringify(candidate.candidateManifest)),{schemaVersion:1,id:randomUUID(),owner,actionId:null,mediaType:'application/json',secrets:[]}));
  const patchRef=unwrap(await publishArtifact(store,bytes(await readFile(patch.patchPath)),{schemaVersion:1,id:randomUUID(),owner,actionId:null,mediaType:'text/x-diff',secrets:[]}));
  if(patchRef.sha256!==patch.sha256)throw Object.assign(Error('PATCH_EVIDENCE_MISMATCH'),{code:'PATCH_EVIDENCE_MISMATCH'});
  report.evidenceIds.push(candidateRef.id,patchRef.id);report.patch=patch.patchPath;report.applyStrip=patch.applyStrip;
  const reconciled=unwrap(store.reconcileEvidence(runId));if(!reconciled.allowsReady)throw Object.assign(Error('RECOVERY_REQUIRED'),{code:'RECOVERY_REQUIRED'});
  unwrap(store.updateRunState(owner,{phase:'VERIFYING',candidateRef:candidateRef.id}));
  report.status='READY_FOR_REVIEW';report.code='VERIFICATION_PASSED';
 }catch(error){
  report.status=deps.signal?.aborted?'CANCELLED':'FAILED';
  report.code=typeof (error as {code?:unknown}).code==='string'&&/^[A-Z_]{1,64}$/.test((error as {code:string}).code)?(error as {code:string}).code:'TASK_FAILED';
 }finally{
  try{await runtime?.cancel();}catch{report.status='RECOVERY_REQUIRED';report.code='CLEANUP_UNCONFIRMED';}
  if(snapshot){try{await assertSourceUnchanged(snapshot);report.sourcePreserved=true;}catch{report.status='FAILED';report.code='SOURCE_CHANGED';}}
  if(owner){
   const recovery=store.reconcileEvidence(runId);if(!recovery.ok||!recovery.value.allowsReady){report.status='RECOVERY_REQUIRED';report.code='UNRESOLVED_EXECUTION_OR_EVIDENCE';}
   const finalized=store.finalizeRun(owner,{phase:report.status,blocker:report.status==='READY_FOR_REVIEW'?null:{code:report.code,message:'See retained task evidence',evidenceIds:report.evidenceIds}});
   if(!finalized.ok){
    report.status='RECOVERY_REQUIRED';report.code=finalized.error.code;
    store.updateRunState(owner,{phase:'RECOVERY_REQUIRED',blocker:{code:report.code,message:'Finalization did not release ownership',evidenceIds:report.evidenceIds}});
   }
  }
  if(report.status!=='READY_FOR_REVIEW'){report.patch=null;report.applyStrip=null;}
  try{await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}finally{store.close();}
 }
 return report;
}
