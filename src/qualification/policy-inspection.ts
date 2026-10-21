import {createHash} from 'node:crypto';
import {win32} from 'node:path';
import {LaunchSpecSchema,WindowsOwnershipReceiptSchema,WindowsDrainEvidenceSchema,
 type LaunchSpec,type Supervisor,type OwnedExecution,type OwnershipReceipt,type DrainEvidence} from '../contracts/execution.ts';
import {fingerprint} from './probes.ts';
import {projectBootstrapDiagnostic,renderBootstrapDiagnostic,type SafeBootstrapDiagnostic} from './bootstrap-diagnostic.ts';
import {prevalidateCodexLaunchArgv,CODEX_CONFIG_SCHEMA} from '../providers/codex/launch-config.ts';

export type FeatureCatalogEntry={key:string;stage:string};
export type PolicyInspectionCode='INVALID_FEATURE_CATALOG'|'INVALID_FEATURE_UTF8'|'MALFORMED_FEATURE_LISTING'|'INCOMPLETE_FEATURE_LISTING'|
 'DUPLICATE_FEATURE'|'UNKNOWN_FEATURE'|'MISSING_FEATURE'|'FEATURE_STAGE_MISMATCH'|'INVALID_FEATURE_BOOLEAN'|'REQUIRED_FEATURE_ENABLED'|
 'INVALID_INSPECTION_RECIPE'|'EXECUTION_NOT_AUTHORIZED'|'LAUNCH_OUTCOME_UNKNOWN'|'INVALID_OWNERSHIP'|'INSPECTION_DEADLINE'|
 'OUTPUT_LIMIT'|'INVALID_OUTPUT'|'UNEXPECTED_STDERR'|'LEASE_RENEWAL_FAILED'|'FENCE_FAILED'|'DRAIN_FAILED'|'INVALID_DRAIN'|
 'ROOT_EXIT_UNCONFIRMED'|'ROOT_NOT_NATURAL'|'CURRENT_AUTHORITY_LOST'|'POLICY_INSPECTION_PASSED';
const stages=new Set(['under development','experimental','stable','deprecated','removed']);
const required=['plugins','hooks','apps'];
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type FeatureListing={features:Record<string,boolean>;stdoutHash:string;catalogHash:string};
export type FeatureListingResult={ok:true;value:FeatureListing}|{ok:false;error:{code:PolicyInspectionCode}};

export type StderrDiagnostic={message:string;truncated:boolean;redactionApplied:boolean;invalidUtf8:boolean;unsupportedContent:boolean;bootstrapDiagnostic:SafeBootstrapDiagnostic};
// Retain only the fixed byte prefix. Full byte accounting/hashing stays in the
// owner callback through final drainage; partitioning cannot affect parsing.
class StderrCapture{
 private readonly prefix=Buffer.alloc(8192);private captured=0;private truncated=false;
 push(bytes:Uint8Array){const length=Math.min(bytes.byteLength,this.prefix.length-this.captured);this.prefix.set(bytes.subarray(0,length),this.captured);this.captured+=length;if(length<bytes.byteLength)this.truncated=true;}
 finish(spec:LaunchSpec|undefined,streamHash:string,totalBytes:number,drainageComplete:boolean):StderrDiagnostic{
  const bootstrapDiagnostic=projectBootstrapDiagnostic({prefix:this.prefix.subarray(0,this.captured),totalBytes,streamHash,stream:'stderr',runtimeIdentity:fingerprint({executable:spec?.executable??null,boundaryHash:spec?.boundaryHash??null}),streamIdentity:fingerprint({runId:spec?.runId??null,generation:spec?.generation??null,actionId:spec?.actionId??null,stream:'stderr'}),truncated:this.truncated,drainageComplete});
  return {message:renderBootstrapDiagnostic(bootstrapDiagnostic),truncated:bootstrapDiagnostic.truncated,redactionApplied:bootstrapDiagnostic.redactionApplied,invalidUtf8:bootstrapDiagnostic.invalidUtf8,unsupportedContent:bootstrapDiagnostic.unsupportedContent,bootstrapDiagnostic};
 }
}
/** Strict incremental decoder; no arbitrary child text appears in errors or
 * projections. A complete line is validated before any state is published. */
class FeatureDecoder{
 readonly expected=new Map<string,string>();readonly features:Record<string,boolean>=Object.create(null);readonly catalogHash:string;
 readonly decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});pending='';error:PolicyInspectionCode|undefined;finished=false;
 constructor(catalog:readonly FeatureCatalogEntry[]){
  this.catalogHash=fingerprint(catalog);
  if(!Array.isArray(catalog)||catalog.length<3||catalog.length>4096)throw Error('INVALID_FEATURE_CATALOG');
  for(const item of catalog){if(!item||!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(item.key)||!stages.has(item.stage)||this.expected.has(item.key))throw Error('INVALID_FEATURE_CATALOG');this.expected.set(item.key,item.stage);}
  if(required.some(key=>!this.expected.has(key)))throw Error('INVALID_FEATURE_CATALOG');
 }
 get complete(){return !this.error&&Object.keys(this.features).length===this.expected.size&&!this.pending;}
 push(bytes:Uint8Array){
  if(this.finished||this.error)return;
  let decoded:string;try{decoded=this.decoder.decode(bytes,{stream:true});}catch{this.error='INVALID_FEATURE_UTF8';return;}
  this.consume(decoded);
 }
 private consume(decoded:string){
  this.pending+=decoded;
  let newline:number;
  while(!this.error&&(newline=this.pending.indexOf('\n'))!==-1){
   let line=this.pending.slice(0,newline);this.pending=this.pending.slice(newline+1);if(line.endsWith('\r'))line=line.slice(0,-1);
   const match=/^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)[ \t]+(.+?)[ \t]+([^ \t]+)[ \t]*$/.exec(line);
   if(!match){this.error='MALFORMED_FEATURE_LISTING';break;}
   const [,key,stage,boolean]=match;
   if(!this.expected.has(key)){this.error='UNKNOWN_FEATURE';break;}
   if(Object.hasOwn(this.features,key)){this.error='DUPLICATE_FEATURE';break;}
   if(stage!==this.expected.get(key)){this.error='FEATURE_STAGE_MISMATCH';break;}
   if(boolean!=='true'&&boolean!=='false'){this.error='INVALID_FEATURE_BOOLEAN';break;}
   if(required.includes(key)&&boolean==='true'){this.error='REQUIRED_FEATURE_ENABLED';break;}
   this.features[key]=boolean==='true';
  }
  if(!this.error&&Object.keys(this.features).length===this.expected.size&&this.pending)this.error='INCOMPLETE_FEATURE_LISTING';
 }
 finish():PolicyInspectionCode|undefined{
  if(this.finished)return this.error;this.finished=true;
  if(!this.error)try{this.consume(this.decoder.decode());}catch{this.error='INVALID_FEATURE_UTF8';}
  if(!this.error&&this.pending)this.error='INCOMPLETE_FEATURE_LISTING';
  if(!this.error&&Object.keys(this.features).length!==this.expected.size)this.error='MISSING_FEATURE';
  return this.error;
 }
}

export function parseFeatureListing(stdout:Uint8Array,expectedCatalog:readonly FeatureCatalogEntry[]):FeatureListingResult{
 try{
  const decoder=new FeatureDecoder(expectedCatalog);if(!(stdout instanceof Uint8Array)||stdout.byteLength>262144)return {ok:false,error:{code:'OUTPUT_LIMIT'}};
  decoder.push(stdout);const code=decoder.finish();return code?{ok:false,error:{code}}:{ok:true,value:{features:{...decoder.features},stdoutHash:hash(stdout),catalogHash:decoder.catalogHash}};
 }catch{return {ok:false,error:{code:'INVALID_FEATURE_CATALOG'}};}
}

export type PolicyInspectionInput={supervisor:Supervisor;spec:LaunchSpec;expectedCatalog:readonly FeatureCatalogEntry[];
 /** Trusted current lookup binding all sealed inputs; no default permission. */
 authorizeCurrent:(spec:Readonly<LaunchSpec>)=>boolean|Promise<boolean>;now:()=>number;maxOutputBytes:number;renewalMs?:number};
export type PolicyInspectionResult={status:'PASS'|'FAIL'|'UNKNOWN'|'REFUSED';reasonCode:PolicyInspectionCode;cleanupErrorCode?:PolicyInspectionCode;
 ownership?:OwnershipReceipt;drain?:DrainEvidence;features:Record<string,boolean>;catalogHash:string;stdoutHash:string;stderrHash:string;
 stdoutBytes:number;stderrBytes:number;stderrDiagnostic:StderrDiagnostic;outputComplete:boolean;recoveryRequiresApproval:boolean;fenceReconciledByTerminal?:true};
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
const sameOwner=(a:{runId:string;generation:number;actionId:string;role:string},b:LaunchSpec)=>a.runId===b.runId&&a.generation===b.generation&&a.actionId===b.actionId&&a.role===b.role;
function fixedRecipe(spec:LaunchSpec){
 if(spec.stdin!=='closed'||spec.authorization.kind!=='qualification'||spec.authorization.probeId!=='auxiliary.preparation'||!win32.isAbsolute(spec.executable)||!win32.isAbsolute(spec.cwd)||spec.argv.at(-2)!=='features'||spec.argv.at(-1)!=='list'||spec.argv.length%2!==0)return false;
 return prevalidateCodexLaunchArgv({entryPoint:'features',schema:CODEX_CONFIG_SCHEMA,argv:spec.argv}).ok;
}
function bounded<T>(promise:Promise<T>,ms:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 return Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('BOUNDED_OPERATION_TIMEOUT')),Math.max(0,ms));})]).finally(()=>clearTimeout(timer));
}

/** A fixed, no-stdin diagnostic. Construction/import is effect-free. The caller
 * owns dispatch/accounting and helper process meters; this function neither
 * invents those observations nor opens a provider session. */
export async function runPolicyInspection(input:PolicyInspectionInput):Promise<PolicyInspectionResult>{
 const stdoutHash=createHash('sha256'),stderrHash=createHash('sha256'),stderrCapture=new StderrCapture();let stdoutBytes=0,stderrBytes=0;
 let decoder:FeatureDecoder|undefined,spec:LaunchSpec|undefined,owned:OwnedExecution|undefined,ownership:OwnershipReceipt|undefined,drain:DrainEvidence|undefined;
 let reason:PolicyInspectionCode|undefined,cleanupError:PolicyInspectionCode|undefined,unknown=false,refused=false,outputComplete=false,fenceReconciledByTerminal=false;
 let deadlineTimer:ReturnType<typeof setTimeout>|undefined,graceTimer:ReturnType<typeof setTimeout>|undefined,renewTimer:ReturnType<typeof setTimeout>|undefined,unsubscribe:(()=>void)|undefined;
 let stop!:()=>void,stopping=false,leaseSequence=0;
 const stopped=new Promise<void>(resolve=>{stop=()=>{if(!stopping){stopping=true;resolve();}};});
 const signal=(code?:PolicyInspectionCode)=>{if(code&&!reason)reason=code;stop();};
 try{
  try{
   spec=frozen(LaunchSpecSchema.parse(structuredClone(input.spec)));decoder=new FeatureDecoder(structuredClone(input.expectedCatalog));
   const now=input.now();if(typeof input.authorizeCurrent!=='function'||!Number.isSafeInteger(now)||now<=0||spec.deadline<=now||spec.deadline-now>30000||!Number.isSafeInteger(input.maxOutputBytes)||input.maxOutputBytes<1||input.maxOutputBytes>262144||!fixedRecipe(spec))throw Error('INVALID_INSPECTION_RECIPE');
   const renewalMs=input.renewalMs??Math.min(2000,Math.floor(spec.leaseTtlMs/3));if(!Number.isSafeInteger(renewalMs)||renewalMs<10||renewalMs>Math.floor(spec.leaseTtlMs/2))throw Error('INVALID_INSPECTION_RECIPE');
  }catch{refused=true;reason='INVALID_INSPECTION_RECIPE';}
  if(!refused&&spec&&decoder){
   let authorized=false;try{authorized=await bounded(Promise.resolve(input.authorizeCurrent(spec)),spec.deadline-input.now());}catch{/* fixed refusal */}
   if(!authorized||input.now()>=spec.deadline){refused=true;reason='EXECUTION_NOT_AUTHORIZED';}
   else{
    const launch=input.supervisor.launchOwned(spec);let launched:Awaited<typeof launch>|undefined;
    try{launched=await bounded(launch,spec.deadline-input.now());}catch{
     unknown=true;reason='LAUNCH_OUTCOME_UNKNOWN';
     // A late returned handle is cleanup authority, never permission to replay.
     void launch.then(async result=>{if(!result.ok)return;try{await bounded(result.value.fence(),15000);}catch{}try{await bounded(result.value.drain('policy_inspection_late_launch'),15000);}catch{}}).catch(()=>{});
    }
    if(!launched?.ok){unknown=true;reason='LAUNCH_OUTCOME_UNKNOWN';}
    if(launched?.ok){
     owned=launched.value;
     deadlineTimer=setTimeout(()=>signal('INSPECTION_DEADLINE'),Math.max(0,spec.deadline-input.now()));
     const complete=()=>{if(!decoder!.complete||graceTimer||stopping)return;clearTimeout(renewTimer);graceTimer=setTimeout(()=>signal(),Math.min(250,Math.max(0,spec!.deadline-input.now())));};
     unsubscribe=owned.onOutput(output=>{
      try{
       if(!(output.data instanceof Uint8Array)||!['stdout','stderr'].includes(output.stream)){signal('INVALID_OUTPUT');return;}
       if(output.stream==='stdout'){stdoutBytes+=output.data.byteLength;stdoutHash.update(output.data);}else{stderrBytes+=output.data.byteLength;stderrHash.update(output.data);stderrCapture.push(output.data);}
       if(!Number.isSafeInteger(stdoutBytes+stderrBytes)||stdoutBytes+stderrBytes>input.maxOutputBytes){signal('OUTPUT_LIMIT');return;}
       if(output.stream==='stderr'&&output.data.byteLength){signal('UNEXPECTED_STDERR');return;}
       if(output.stream==='stdout'){decoder!.push(output.data);if(decoder!.error)signal(decoder!.error);else complete();}
      }catch{signal('INVALID_OUTPUT');}
     });
     try{
      const actual=WindowsOwnershipReceiptSchema.parse(await bounded(owned.describe(),Math.max(0,spec.deadline-input.now())));
      if(!sameOwner(actual,spec)||actual.boundaryHash!==spec.boundaryHash||actual.pid===actual.helperPid||actual.capturedAt>input.now())throw Error('INVALID_OWNERSHIP');ownership=actual;
     }catch{unknown=true;signal('INVALID_OWNERSHIP');}
     const renewalMs=input.renewalMs??Math.min(2000,Math.floor(spec.leaseTtlMs/3));
     const renew=()=>{if(stopping||decoder!.complete)return;renewTimer=setTimeout(()=>{
      if(stopping||decoder!.complete)return;if(input.now()>=spec!.deadline){signal('INSPECTION_DEADLINE');return;}
      void bounded(owned!.renewLease(++leaseSequence),Math.min(spec!.leaseTtlMs,spec!.deadline-input.now())).then(()=>renew(),()=>signal('LEASE_RENEWAL_FAILED'));
     },renewalMs);};renew();
     if(input.now()>=spec.deadline)signal('INSPECTION_DEADLINE');complete();await stopped;
    }
   }
  }
 }catch{if(owned)signal('INVALID_OUTPUT');else{unknown=true;reason='LAUNCH_OUTCOME_UNKNOWN';}}
 finally{
  clearTimeout(deadlineTimer);clearTimeout(graceTimer);clearTimeout(renewTimer);
  if(owned){
   const cleanupDeadline=input.now()+15000;
   let fenceFailed=false;
   try{await bounded(owned.fence(),cleanupDeadline-input.now());}catch{fenceFailed=true;}
   try{
    const actual=WindowsDrainEvidenceSchema.parse(await bounded(owned.drain('policy_inspection_stop'),cleanupDeadline-input.now()));
    if(!spec||!ownership||!sameOwner(actual,spec)||!actual.rootExited||!actual.membershipEmpty||actual.activeProcesses!==0||actual.unresolvedExecutions.length||!actual.outputComplete||actual.unresolvedOutputStreams.length||actual.rootExitedAt===null||actual.outputCompletedAt===null||actual.rootExitedAt<ownership.capturedAt||actual.membershipObservedAt<ownership.capturedAt||actual.outputCompletedAt<ownership.capturedAt||actual.completedAt<Math.max(actual.rootExitedAt,actual.membershipObservedAt,actual.outputCompletedAt)||actual.completedAt>input.now())throw Error('INVALID_DRAIN');
    drain=actual;outputComplete=true;
    // A terminal root cannot accept input. Natural exit may race an in-flight
    // fence acknowledgment; the exact owned terminal pair reconciles that
    // redundant control failure without claiming an acknowledgment occurred.
    fenceReconciledByTerminal=fenceFailed&&actual.reason==='root_exit'&&actual.rootExitCode===0;
    if(fenceFailed&&!fenceReconciledByTerminal){cleanupError='FENCE_FAILED';if(!reason)reason='FENCE_FAILED';}
    if(actual.rootExitCode!==0&&!reason)reason='ROOT_EXIT_UNCONFIRMED';
    if(actual.reason!=='root_exit'&&!reason)reason='ROOT_NOT_NATURAL';
   }catch{unknown=true;cleanupError='DRAIN_FAILED';if(!reason)reason='INVALID_DRAIN';}
  }
  try{unsubscribe?.();}catch{unknown=true;cleanupError='DRAIN_FAILED';}
 }
 const parseError=decoder?.finish();if(parseError&&!reason)reason=parseError;
 if(owned&&spec&&!unknown&&!reason){
  let authorized=false;try{authorized=await bounded(Promise.resolve(input.authorizeCurrent(spec)),Math.max(0,spec.deadline-input.now()));}catch{/* current uncertainty refuses classification */}
  if(!authorized||input.now()>=spec.deadline)reason='CURRENT_AUTHORITY_LOST';
 }
 if(!reason)reason='POLICY_INSPECTION_PASSED';
 const completedStderrHash=stderrHash.digest('hex');
 const status=unknown?'UNKNOWN':refused?'REFUSED':reason==='POLICY_INSPECTION_PASSED'&&ownership&&drain&&outputComplete?'PASS':'FAIL';
 return {status,reasonCode:reason,...(cleanupError?{cleanupErrorCode:cleanupError}:{}),...(ownership?{ownership}:{}),...(drain?{drain}:{}),features:{...decoder?.features},catalogHash:decoder?.catalogHash??fingerprint([]),stdoutHash:stdoutHash.digest('hex'),stderrHash:completedStderrHash,stdoutBytes,stderrBytes,stderrDiagnostic:stderrCapture.finish(spec,completedStderrHash,stderrBytes,outputComplete),outputComplete,recoveryRequiresApproval:status==='UNKNOWN',...(fenceReconciledByTerminal?{fenceReconciledByTerminal:true}:{})};
}
