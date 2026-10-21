import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { WindowsDrainEvidenceSchema, WindowsOwnershipReceiptSchema, type OwnershipReceipt, type ExecutionOwner } from '../contracts/execution.ts';
import { QualificationTerminalSchema } from '../contracts/qualification-observation.ts';
import { assessPhaseAdmission, ownershipHash, startupTargetHash, type StartupIntent, type PhaseAdmission } from './codex-startup-authority.ts';
import { fingerprint } from './probes.ts';
import { StartupSessionProofSchema, StartupMonitorObservationSchema, StartupPolicyObservationSchema, ManagedPolicyConflictProjectionSchema, sourceCoveredStartupPaths, type ManagedPolicyConflictProjection, type StartupCoverageManifest, type StartupSessionProof, type StartupPolicyObservation, type StartupMonitorObservation } from './startup-evidence.ts';

export const SESSION_PROBES = ['worker.subscription_request','worker.correlated_lifecycle','worker.allowed_edit','worker.unapproved_config_inactive',
 'controller.foreground_cancel','controller.detached_descendant_cancel','controller.controller_death','controller.helper_death','controller.pending_dispatch_cancel','controller.auth_stop','controller.quota_stop'] as const;
export type SessionProbe = typeof SESSION_PROBES[number];
export const INACTIVITY_PATHS = ['plugins','plugin-contributions','browser-native','browser-cdp','computer','mcp-ordinary','mcp-managed-cloud','mcp-plugin','remote-control','hooks','legacy-notify','apps','web'] as const;
type CancelKind = 'foreground_cancel'|'detached_descendant_cancel'|'controller_death'|'helper_death'|'pending_dispatch_cancel';
type Phase = PhaseAdmission['phase'];
export type UnrelatedIdentity = {pid:number;creationIdentity:string;name:string};
export type SessionRequest = {
 intent: StartupIntent; admissions: Partial<Record<Phase,PhaseAdmission>>; expectedOwnership?: OwnershipReceipt;
 argv: string[]; protectedInputs: Record<string,string>;
 unrelated?:UnrelatedIdentity;unrelatedActionId?:string;pendingActionId?:string;
 startupCoverage?:StartupCoverageManifest;
};
export type SessionDispatch = {kind: 'prepare'|'launch'|'initialize'|'thread-start'|'turn-start'|'inactivity-observe'|'protected-snapshot'|'edit-read'|'cancellation-arm'|'cancellation-trigger'|'strict-outcome'|'fence'|'drain'|'broker-reconcile'|'heartbeat-observe'|'checkpoint';dispatchId:string;sequence:number;launchHash:string;owner:ExecutionOwner;targetHash:string;limits:{activeMs:number;outputBytes:number};cleanup:boolean};
export type SessionEvidence = {category:'operation'|'ownership'|'drain'|'startup'|'observed_controls'|'subscription'|'lifecycle'|'heartbeat'|'unrelated_process'|'checkpoint'|'injected_response';body:Record<string,unknown>};
type Owned = {ownership:OwnershipReceipt};
type Descendant = {pid:number;creationIdentity:string;jobIdentity:string};
type PendingCreation = {actionId:string;generation:number;state:'pending'|'cancelled-before-dispatch';dispatchCount:number;createdProcessIdentities:string[]};
export type SessionEvent = {kind:'thread-started'|'turn-started'|'item-started'|'item-completed'|'turn-completed';threadId:string;turnId?:string;itemId?:string};
export type SessionTurn = {threadId:string;turnId:string;model:string;effort:string;events:SessionEvent[];response:'completed'|'authentication-required'|'quota-exceeded'};
/** Operations are injected at provider/process boundaries. None supplies a probe PASS.
 * Every effect, including observation and cleanup, passes through dispatch accounting.
 * Implementations must keep raw capture within the supplied envelope before projection. */
export interface SessionProcess {
 /** Arm monitors for existing controller-owned fixtures. Independent fixture processes
  * require their own parent campaign actions; prepare cannot hide their creation. */
 prepare(input:{workspace:string;paths:readonly string[];unrelated?:UnrelatedIdentity;intent?:StartupIntent;coverage?:StartupCoverageManifest}):Promise<{armedAt:number;paths:readonly string[];sourceCoveredPaths?:readonly string[];coverageHash?:string}>;
 launch(input:{intent:StartupIntent;argv:string[];strictNegative:boolean}):Promise<OwnershipReceipt>;
 initialize():Promise<{observationHash:string;account:string;provider:string;model:string;effort:string;policy?:StartupPolicyObservation;managedConflict?:ManagedPolicyConflictProjection}>;
 startThread(input:{workspace:string;authMode:'managed-chatgpt'}):Promise<{threadId:string;observationHash:string;account:string;provider:string;model:string;effort:string;policy?:StartupPolicyObservation}>;
 startTurn(input:{threadId:string;model:string;effort:string;authMode:'managed-chatgpt';operation:'subscription'|'lifecycle'|'allowed-edit'|'injected-recovery';edit?:{path:string;postimage:string};injectedResponse?:'authentication-required'|'quota-exceeded'}):Promise<SessionTurn>;
 observeInactivity():Promise<Array<{path:string;armedAt:number;observedThrough:number;activationCount:number}&Partial<Omit<StartupMonitorObservation,'path'|'armedAt'|'observedThrough'|'activationCount'>>>>;
 snapshotProtected():Promise<Record<string,string>>;
 readEdit(input:{path:string}):Promise<string>;
 armCancellation(input:{kind:CancelKind;ownership:OwnershipReceipt;pendingActionId?:string}):Promise<Owned&{ready:boolean;descendant?:Descendant;pending?:PendingCreation;heartbeatActivity?:{samples:Array<{at:number;value:string}>}} >;
 trigger(input:{kind:CancelKind;ownership:OwnershipReceipt;pendingActionId?:string;descendant?:Descendant}):Promise<Owned&{triggered:boolean;pendingDispatched:boolean;descendant?:Descendant;pending?:PendingCreation}>;
 fence():Promise<Owned&{fenced:boolean}>;
 drain():Promise<Owned&{drain:unknown}>;
 observeHeartbeat(input:{minimumWindowMs:2000;unrelated:UnrelatedIdentity}):Promise<Owned&{samples:Array<{at:number;value:string}>;unrelated:UnrelatedIdentity&{alive:boolean}}>;
 reconcileBrokers():Promise<Owned&{inventoryComplete:boolean;active:string[];unresolved:string[];inventoryScope?:'campaign-owned-controlled-services';registryHash?:string}>;
 checkpoint(input:{reason:'authentication-required'|'quota-exceeded';retry:false;providerFallback:false;recoveryRequiresApproval:true;ownership:OwnershipReceipt}):Promise<{saved:boolean;recoveryRequiresApproval:boolean}>;
 strictOutcome():Promise<{exitCode:number;stderr:string;rpcCount:number}>;
}
export type SessionDeps = {now:()=>number;dispatch:<T>(action:SessionDispatch,operation:()=>Promise<T>)=>Promise<T>;seam:SessionProcess;
 /** Pure controller lookup of current scoped approval. It must not initiate effects
  * or manufacture authority. Inputs are frozen snapshots of actual observations. */
 currentAdmission?:(phase:Phase,intent:Readonly<StartupIntent>,actualOwned:Readonly<OwnershipReceipt>|undefined,observationHash:string|undefined)=>PhaseAdmission|undefined;
 /** Pure lookup of actual separately owned process metadata, never a predicted PID. */
 resolveUnrelated?:(actionId:string)=>(UnrelatedIdentity&{actionId:string})|undefined;
 /** Controller-selected provenance; an injected simulation must never be labeled live. */
 evidenceKind?:'simulation'|'live'|'fault_injection'};
export type SessionResult = {status:'PASS'|'FAIL'|'REFUSED';reason:string;evidenceKind:'simulation'|'live'|'fault_injection';catalogProbe:boolean;evidence:SessionEvidence[];startupEvidence?:StartupSessionProof[];managedConflicts?:Array<{actionId:string;projection:ManagedPolicyConflictProjection}>;recoveryRequiresApproval?:true};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function exactOwnership(actual:unknown,expected:OwnershipReceipt):boolean {
 const parsed=WindowsOwnershipReceiptSchema.safeParse(actual);const wanted=WindowsOwnershipReceiptSchema.safeParse(expected);
 return parsed.success&&wanted.success&&parsed.data.pid!==parsed.data.helperPid&&ownershipHash(parsed.data)===ownershipHash(wanted.data);
}
/** Accept the actual proof method; never relabel an outer observation as an inner Job query. */
export function isTerminalDrained(raw:unknown,ownership:OwnershipReceipt,probeId='',unrelated?:SessionRequest['unrelated']):boolean {
 const owner=WindowsOwnershipReceiptSchema.safeParse(ownership);if(!owner.success)return false;
 const matchOwner=(value:{runId:string;generation:number;actionId:string;role:string})=>value.runId===owner.data.runId&&value.generation===owner.data.generation&&value.actionId===owner.data.actionId&&value.role===owner.data.role;
 const death=probeId==='controller.controller_death'||probeId==='controller.helper_death';
 const ordinary=WindowsDrainEvidenceSchema.safeParse(raw);
 if(ordinary.success)return !death&&matchOwner(ordinary.data)&&ordinary.data.rootExited&&ordinary.data.membershipEmpty&&ordinary.data.activeProcesses===0&&ordinary.data.outputComplete&&ordinary.data.unresolvedExecutions.length===0&&ordinary.data.unresolvedOutputStreams.length===0;
 const parsed=QualificationTerminalSchema.safeParse(raw);if(!parsed.success)return false;const t=parsed.data,d=t.description;
 if(!matchOwner(t)||!matchOwner(d)||d.boundaryHash!==owner.data.boundaryHash||d.root.pid!==owner.data.pid||d.root.creationIdentity!==owner.data.creationIdentity||d.helper.pid!==owner.data.helperPid||d.helper.creationIdentity!==owner.data.helperCreationIdentity||d.innerJobIdentity!==owner.data.jobIdentity||!t.rootExited||t.rootExitCode===null||!t.helperExited||!t.controllerExited||t.outerActiveProcesses!==0||t.outerMembershipEmpty!==true||t.outerQueryError!==null||!t.outputComplete||t.overflow||t.readerFailure||t.emergencyTerminated||t.streams.some(stream=>stream.eofCount!==1)||t.observedAt<owner.data.capturedAt)return false;
 if(t.processMeterError||t.rootLifetimeMs===null||t.helperLifetimeMs===null)return false;
 for(const kind of ['root','helper'] as const){const meters=t.processMeters.filter(meter=>meter.kind===kind),expected=d[kind];if(meters.length!==1)return false;const meter=meters[0]!;
  if(meter.identity.pid!==expected.pid||meter.identity.creationIdentity!==expected.creationIdentity||meter.exitedAt===null||meter.exitedAt<meter.createdAt||meter.exitedAt>t.observedAt||meter.activeMs!==(kind==='root'?t.rootLifetimeMs:t.helperLifetimeMs))return false;}
 if(death){const kind=probeId==='controller.helper_death'?'helper':'controller';const expected=d[kind],trigger=t.trigger;
  if(!trigger||trigger.target.kind!==kind||trigger.target.identity.pid!==expected.pid||trigger.target.identity.creationIdentity!==expected.creationIdentity||trigger.triggeredAt>trigger.targetExitedAt||trigger.targetExitedAt>t.observedAt||t.rootExitCause!==(kind==='helper'?'helper-job-close':'controller-eof')||kind==='helper'&&!t.controllerRetiredAfterHelperExit)return false;
  if(t.processMeters.find(meter=>meter.kind==='root')!.exitedAt!<trigger.triggeredAt)return false;
 }else if(t.trigger!==null||!['natural','supervisor-drain'].includes(t.rootExitCause))return false;
 if(unrelated){const other=t.unrelated;if(!other||other.identity.pid!==unrelated.pid||other.identity.creationIdentity!==unrelated.creationIdentity||other.name!==unrelated.name||!other.alive||!other.outsideHierarchy)return false;}
 return true;
}
function correlated(events:SessionEvent[],threadId:string,turnId:string):boolean {
 const kinds=['thread-started','turn-started','item-started','item-completed','turn-completed'];
 return !!threadId&&!!turnId&&events.length===5&&events.every((event,index)=>event.kind===kinds[index]&&event.threadId===threadId&&(index===0||event.turnId===turnId))&&
  !!events[2]?.itemId&&events[2].itemId===events[3]?.itemId;
}
function protectedMatch(actual:Record<string,string>,expected:Record<string,string>):boolean {
 const keys=Object.keys(expected);return keys.length>0&&keys.every(key=>/^[a-f0-9]{64}$/.test(expected[key]!))&&keys.length===Object.keys(actual).length&&keys.every(key=>actual[key]===expected[key]);
}
/** Retain fixed typed observations before the generic campaign privacy projector
 * hashes arbitrary keys/strings. Missing provenance remains missing. */
function retainStartupProof(request:SessionRequest,evidence:SessionEvidence[],evidenceKind:SessionResult['evidenceKind'],status:SessionResult['status'],strict?:StartupSessionProof['strict']):StartupSessionProof[] {
 const operation=evidence.filter(e=>e.category==='operation'&&e.body.outcome==='completed');
 const drain=evidence.filter(e=>e.category==='drain'&&e.body.kind!=='broker-reconciliation').at(-1)?.body;
 const ownership=evidence.find(e=>e.category==='ownership'&&e.body.environment==='windows')?.body;
 const policy=evidence.filter(e=>e.category==='observed_controls'&&e.body.policy).at(-1)?.body.policy;
 const monitors=evidence.find(e=>e.category==='startup'&&Array.isArray(e.body.monitors))?.body.monitors;
 const sourceCoverage=evidence.find(e=>e.category==='startup'&&e.body.sourceCoverage)?.body.sourceCoverage;
 const rawBroker=evidence.find(e=>e.category==='drain'&&e.body.kind==='broker-reconciliation')?.body;
 const broker=rawBroker?.inventoryScope==='campaign-owned-controlled-services'?{inventoryScope:rawBroker.inventoryScope,registryHash:rawBroker.registryHash,activeCount:rawBroker.activeCount,unresolvedCount:rawBroker.unresolvedCount}:undefined;
 const parsed=StartupSessionProofSchema.safeParse({schemaVersion:1,kind:'startup-session-proof',evidenceKind,intent:request.intent,status,
  initialized:operation.some(e=>e.body.kind==='initialize'),threadStarted:operation.some(e=>e.body.kind==='thread-start'),ownership,drain,
  dispatches:operation.map(e=>({dispatchId:e.body.dispatchId,sequence:e.body.sequence,kind:e.body.kind,launchHash:e.body.launchHash})),
  ...(policy?{policy}:{}),...(monitors?{monitors}:{}),...(sourceCoverage?{sourceCoverage}:{}),...(broker?{broker}:{}),...(strict?{strict}:{})});
 return parsed.success?[parsed.data]:[];
}
class Refusal extends Error {}
class DriverFailure extends Error {}
const failureCode=(error:unknown,fallback:string)=>error instanceof Refusal||error instanceof DriverFailure?error.message:fallback;
function frozen<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))frozen(child);}return value;}
function projectUnrelated(value:unknown):UnrelatedIdentity|undefined {if(!value||typeof value!=='object'||Array.isArray(value))return;const v=value as Record<string,unknown>;if(!Number.isSafeInteger(v.pid)||Number(v.pid)<=0||typeof v.creationIdentity!=='string'||!v.creationIdentity||typeof v.name!=='string'||!v.name)return;return {pid:v.pid as number,creationIdentity:v.creationIdentity,name:v.name};}
function context(request:SessionRequest,deps:SessionDeps) {
 // Snapshot controller inputs before the first asynchronous operation.
 const snapshot=structuredClone(request),reference=snapshot.unrelatedActionId;
 const lookup=()=>{try{if(typeof reference!=='string'||!reference.trim())return;const actual=deps.resolveUnrelated?.(reference);if(actual?.actionId!==reference)return;return projectUnrelated(actual);}catch{return;}};
 if(reference!==undefined&&(typeof reference!=='string'||!reference.trim()))throw new Refusal('UNRELATED_REFERENCE_INVALID');
 if(reference!==undefined&&snapshot.unrelated!==undefined)throw new Refusal('UNRELATED_IDENTITY_AMBIGUOUS');
 const unrelated=reference!==undefined?lookup():projectUnrelated(snapshot.unrelated);if(!unrelated&&(reference!==undefined||snapshot.unrelated!==undefined))throw new Refusal('UNRELATED_IDENTITY_UNRESOLVED');
 const r=frozen({...snapshot,unrelated:unrelated?frozen(structuredClone(unrelated)):undefined});if(r.expectedOwnership&&!WindowsOwnershipReceiptSchema.safeParse(r.expectedOwnership).success)throw new Refusal('UNSUPPORTED_OWNERSHIP');
 let owned:OwnershipReceipt|undefined;let identity:ReturnType<typeof WindowsOwnershipReceiptSchema.parse>|undefined;let observed:string|undefined;let dispatched=false;let terminalAt=0;let sequence=0;const evidence:SessionEvidence[]=[],managedConflicts:ManagedPolicyConflictProjection[]=[];
 let unrelatedInvalid=false;
 const checkUnrelated=(cleanup:boolean)=>{if(reference===undefined)return;const actual=lookup();if(!actual||!same(actual,r.unrelated))unrelatedInvalid=true;if(unrelatedInvalid&&!cleanup)throw new Refusal('UNRELATED_IDENTITY_CHANGED');};
 const matches=(receipt:unknown)=>!!identity&&exactOwnership(receipt,identity);
 const call=async<T>(kind:SessionDispatch['kind'],operation:()=>Promise<T>,cleanup=false,input:unknown={}):Promise<T>=>{
  const owner=structuredClone(r.intent.owner),targetHash=startupTargetHash(r.intent),launchHash=fingerprint({kind,input,owner});
  const ordinal=++sequence;const descriptor:SessionDispatch={kind,owner,targetHash,sequence:ordinal,launchHash,dispatchId:fingerprint({kind,owner,targetHash,sequence:ordinal,launchHash}),limits:{activeMs:cleanup?r.intent.budget.cleanupMs:r.intent.budget.activeMs,outputBytes:r.intent.budget.outputBytes},cleanup};
  const snapshot=structuredClone(descriptor);let invoked=false;
  try{const value=await deps.dispatch(descriptor,async()=>{if(!same(descriptor,snapshot))throw new Refusal('DISPATCH_DESCRIPTOR_CHANGED');if(invoked)throw new Refusal('DISPATCH_REPLAY');checkUnrelated(cleanup);invoked=true;return operation();});if(!invoked)throw new Refusal('DISPATCH_NOT_INVOKED');evidence.push({category:'operation',body:{...snapshot,outcome:'completed'}});return value;}
  catch(error){evidence.push({category:'operation',body:{...snapshot,outcome:invoked?'unknown':'refused'}});throw error;}
 };
 const admit=(phase:Phase)=>{const approval=deps.currentAdmission?deps.currentAdmission(phase,frozen(structuredClone(r.intent)),owned?frozen(structuredClone(owned)):undefined,observed):r.admissions[phase];const result=assessPhaseAdmission(r.intent,approval,deps.now(),phase,owned,observed);if(!result.authorized)throw new Refusal(result.code);};
 const launch=async(argv:string[],negative=false)=>{
  admit('BOOTSTRAP');if(digest(argv)!==r.intent.argumentsHash)throw new Refusal('ARGUMENT_BINDING_MISMATCH');
  // Approval is checked again inside dispatch, where a delayed scheduler runs the callback.
  const input={intent:r.intent,argv,strictNegative:negative};
  owned=await call('launch',async()=>{admit('BOOTSTRAP');dispatched=true;return deps.seam.launch(structuredClone(input));},false,input);
  const actual=WindowsOwnershipReceiptSchema.safeParse(owned);
  if(!actual.success||actual.data.pid===actual.data.helperPid||actual.data.boundaryHash!==r.intent.boundaryHash||actual.data.capturedAt<r.intent.issuedAt||actual.data.capturedAt>deps.now()||Object.entries(r.intent.owner).some(([key,value])=>actual.data[key as keyof typeof actual.data]!==value)||r.expectedOwnership&&!exactOwnership(actual.data,r.expectedOwnership))throw new DriverFailure('OWNERSHIP_MISMATCH');
  identity=frozen(structuredClone(actual.data));owned=identity;
  evidence.push({category:'ownership',body:{...identity}});
 };
 const initialize=async()=>{const result=await call('initialize',async()=>{admit('BOOTSTRAP');return deps.seam.initialize();});observed=result.observationHash;
  if(result.account!=='chatgpt'||result.provider!=='openai'||result.model!==r.intent.model||result.effort!==r.intent.effort)throw new DriverFailure('SUBSCRIPTION_SETTINGS_MISMATCH');
  if(result.policy){const policy=StartupPolicyObservationSchema.parse(result.policy);evidence.push({category:'observed_controls',body:{policy}});}
  if(result.managedConflict){const managedConflict=ManagedPolicyConflictProjectionSchema.parse(result.managedConflict);if(managedConflict.intentHash!==fingerprint(r.intent))throw new DriverFailure('MANAGED_CONFLICT_INTENT_CHANGED');managedConflicts.push(managedConflict);}
  evidence.push({category:'subscription',body:{account:'chatgpt',provider:'openai',model:r.intent.model,effort:r.intent.effort,observationHash:observed}});};
 const cleanup=async()=>{
  if(!dispatched)return false;let complete=true;
  try{const result=await call('fence',()=>deps.seam.fence(),true);complete=result.fenced&&matches(result.ownership);}catch{complete=false;}
  // Fencing failure cannot skip independent drain or broker reconciliation. Never retry.
  try{const result=await call('drain',()=>deps.seam.drain(),true);const parsed=WindowsDrainEvidenceSchema.safeParse(result.drain);
   if(parsed.success){terminalAt=parsed.data.completedAt;evidence.push({category:'drain',body:{...parsed.data,reason:parsed.data.reason==='root_exit'?'root_exit':'qualification-session-terminal'}});}
   else {const outer=QualificationTerminalSchema.safeParse(result.drain);if(outer.success){terminalAt=outer.data.observedAt;evidence.push({category:'drain',body:{...outer.data}});}}
   const probeId=r.intent.dispatchAuthorization.kind==='qualification'?r.intent.dispatchAuthorization.probeId:'';
   complete=complete&&matches(result.ownership)&&!!identity&&isTerminalDrained(result.drain,identity!,probeId,probeId.startsWith('controller.')&&!probeId.endsWith('_stop')?r.unrelated:undefined);
  }catch{complete=false;}
  try{const result=await call('broker-reconcile',()=>deps.seam.reconcileBrokers(),true);complete=complete&&matches(result.ownership)&&result.inventoryComplete&&result.active.length===0&&result.unresolved.length===0;evidence.push({category:'drain',body:{kind:'broker-reconciliation',inventoryComplete:result.inventoryComplete,activeCount:result.active.length,unresolvedCount:result.unresolved.length,...(result.inventoryScope?{inventoryScope:result.inventoryScope,registryHash:result.registryHash}:{})}});}catch{complete=false;}
  if(unrelatedInvalid)evidence.push({category:'unrelated_process',body:{actionId:reference,identityMatched:false}});return complete&&!unrelatedInvalid;
 };
 return {r,call,admit,launch,initialize,cleanup,evidence,managedConflicts,matches,get unrelatedValid(){return !unrelatedInvalid;},get actualIdentity(){return identity;},observe(hash:string){observed=hash;},get owned(){return owned;},get observed(){return observed;},get dispatched(){return dispatched;},get terminalAt(){return terminalAt;}};
}
/** Fixed per-probe orchestration. No provider, process, filesystem or network default exists. */
export async function runSessionProbe(probeId:string,request:SessionRequest,deps:SessionDeps):Promise<SessionResult> {
 const recoveryProbe=probeId==='controller.auth_stop'||probeId==='controller.quota_stop';const kind=recoveryProbe&&deps.evidenceKind==='live'?'fault_injection':deps.evidenceKind??'simulation';let evidence:SessionEvidence[]=[];
 let proofRequest:SessionRequest|undefined;
 let conflictProjections:ManagedPolicyConflictProjection[]=[];
 const result=(status:SessionResult['status'],reason:string):SessionResult=>({status,reason,evidenceKind:kind,catalogProbe:true,evidence:[...evidence],startupEvidence:proofRequest?retainStartupProof(proofRequest,evidence,kind,status):[],managedConflicts:proofRequest?conflictProjections.map(projection=>({actionId:proofRequest!.intent.owner.actionId,projection})):[]});
 if(!(SESSION_PROBES as readonly string[]).includes(probeId))return result('REFUSED','UNKNOWN_SESSION_PROBE');
 let c:ReturnType<typeof context>;
 try{c=context(request,deps);proofRequest=c.r;evidence=c.evidence;conflictProjections=c.managedConflicts;c.admit('BOOTSTRAP');if(c.r.intent.action!=='worker-start')return result('REFUSED','WORKER_START_REQUIRED');if(c.r.intent.dispatchAuthorization.kind==='qualification'&&c.r.intent.dispatchAuthorization.probeId!==probeId)return result('REFUSED','PROBE_AUTHORIZATION_MISMATCH');if(probeId.startsWith('controller.')&&!probeId.endsWith('_stop')){if(!c.r.unrelated)return result('REFUSED','UNRELATED_IDENTITY_UNRESOLVED');if(kind==='live'&&!c.r.unrelatedActionId)return result('REFUSED','UNRELATED_REFERENCE_REQUIRED');}}catch(error){return result('REFUSED',failureCode(error,'INVALID_INPUT'));}
 let reason='SESSION_CASE_PASSED';let terminal=false;let recovery:SessionTurn['response']|undefined;let armedAt=0;let monitoredPaths:readonly string[]=INACTIVITY_PATHS;
 const cancel=probeId.startsWith('controller.')&&!probeId.endsWith('_stop');
 try {
  const preparation={workspace:c.r.intent.workspace,paths:probeId==='worker.unapproved_config_inactive'?INACTIVITY_PATHS:[],unrelated:c.r.unrelated,...(c.r.startupCoverage?{intent:c.r.intent,coverage:c.r.startupCoverage}:{})};
  const armed=await c.call('prepare',async()=>{c.admit('BOOTSTRAP');return deps.seam.prepare(structuredClone(preparation));},false,preparation);
  const sourceCovered=armed.sourceCoveredPaths??[];
  if(sourceCovered.length){const expected=c.r.startupCoverage?sourceCoveredStartupPaths(c.r.startupCoverage):[];if(!c.r.startupCoverage||armed.coverageHash!==fingerprint(c.r.startupCoverage)||sourceCovered.length!==expected.length||new Set(sourceCovered).size!==sourceCovered.length||expected.some(path=>!sourceCovered.includes(path)))throw new DriverFailure('SOURCE_COVERAGE_UNPROVEN');}
  monitoredPaths=preparation.paths.filter(path=>!sourceCovered.includes(path));
  if(!Number.isSafeInteger(armed.armedAt)||armed.armedAt<c.r.intent.issuedAt||armed.armedAt>deps.now()||monitoredPaths.some(path=>!armed.paths.includes(path)))throw new DriverFailure('CANARIES_NOT_ARMED');
  if(sourceCovered.length)evidence.push({category:'startup',body:{sourceCoverage:{sha256:armed.coverageHash,paths:[...sourceCovered]}}});
  armedAt=armed.armedAt;await c.launch(c.r.argv);await c.initialize();
  const threadInput={workspace:c.r.intent.workspace,authMode:'managed-chatgpt' as const};
  c.admit('PRE_THREAD');const thread=await c.call('thread-start',async()=>{c.admit('PRE_THREAD');return deps.seam.startThread(threadInput);},false,threadInput);
  if(!thread.threadId)throw new DriverFailure('THREAD_ID_MISSING');
  if(thread.account!=='chatgpt'||thread.provider!=='openai'||thread.model!==c.r.intent.model||thread.effort!==c.r.intent.effort)throw new DriverFailure('THREAD_SETTINGS_MISMATCH');
  if(thread.policy){const policy=StartupPolicyObservationSchema.parse(thread.policy);evidence.push({category:'observed_controls',body:{policy}});}
  c.observe(thread.observationHash);
  if(probeId==='worker.unapproved_config_inactive'){
   // Read the armed monitors only after drainage, so late activation remains visible.
  }else if(cancel){
   const cancelKind=probeId.slice('controller.'.length) as CancelKind;
   const triggerInput:{kind:CancelKind;ownership:OwnershipReceipt;pendingActionId?:string;descendant?:Descendant}={kind:cancelKind,ownership:c.owned!,...(cancelKind==='pending_dispatch_cancel'?{pendingActionId:c.r.pendingActionId}:{})};
   c.admit('TURN');const active=await c.call('cancellation-arm',async()=>{c.admit('TURN');return deps.seam.armCancellation(structuredClone(triggerInput));},false,triggerInput);
   if(!active.ready||!c.matches(active.ownership))throw new DriverFailure('CANCELLATION_NOT_ARMED');
   const pendingValid=(pending:PendingCreation|undefined,state:PendingCreation['state'])=>!!pending&&!!c.r.pendingActionId&&c.r.pendingActionId!==c.r.intent.owner.actionId&&pending.actionId===c.r.pendingActionId&&pending.generation===c.r.intent.owner.generation&&pending.state===state&&pending.dispatchCount===0&&pending.createdProcessIdentities.length===0;
   if(cancelKind==='pending_dispatch_cancel'&&!pendingValid(active.pending,'pending'))throw new DriverFailure('PENDING_CREATION_UNPROVEN');
   if(cancelKind==='detached_descendant_cancel'){
    const descendant=active.descendant;if(!descendant||!Number.isSafeInteger(descendant.pid)||descendant.pid<=0||descendant.pid===c.actualIdentity!.pid||descendant.pid===c.actualIdentity!.helperPid||!descendant.creationIdentity||descendant.jobIdentity!==c.actualIdentity!.jobIdentity)throw new DriverFailure('DESCENDANT_IDENTITY_UNPROVEN');
    triggerInput.descendant=structuredClone(descendant);evidence.push({category:'ownership',body:{kind:'detached-descendant',...descendant}});
   }
   const activity=active.heartbeatActivity?.samples;
   if(!activity||activity.length<2||activity.some((sample,index)=>!Number.isSafeInteger(sample.at)||sample.at<c.r.intent.issuedAt||sample.at>deps.now()||!sample.value||(index>0&&sample.at<=activity[index-1]!.at))||activity[0]!.value===activity.at(-1)!.value)throw new DriverFailure('HEARTBEAT_ACTIVITY_UNPROVEN');
   evidence.push({category:'heartbeat',body:{phase:'before-trigger',samples:activity.map(sample=>({at:sample.at,valueHash:digest(sample.value)}))}});
   const triggered=await c.call('cancellation-trigger',()=>deps.seam.trigger(structuredClone(triggerInput)),false,triggerInput);
   if(!triggered.triggered||!c.matches(triggered.ownership)||cancelKind==='pending_dispatch_cancel'&&triggered.pendingDispatched)throw new DriverFailure('CANCELLATION_TRIGGER_MISMATCH');
   if(cancelKind==='pending_dispatch_cancel'&&!pendingValid(triggered.pending,'cancelled-before-dispatch'))throw new DriverFailure('PENDING_CREATION_UNPROVEN');
   if(cancelKind==='detached_descendant_cancel'&&!same(triggered.descendant,triggerInput.descendant))throw new DriverFailure('DESCENDANT_IDENTITY_UNPROVEN');
   if(cancelKind==='pending_dispatch_cancel')evidence.push({category:'operation',body:{kind:'pending-cancellation',actionId:c.r.pendingActionId,generation:c.r.intent.owner.generation,dispatchCount:0,createdProcessIdentities:[],state:'cancelled-before-dispatch'}});
  }else{
   if(probeId==='worker.allowed_edit'&&!protectedMatch(await c.call('protected-snapshot',()=>deps.seam.snapshotProtected()),c.r.protectedInputs))throw new DriverFailure('PROTECTED_INPUT_CHANGED');
   c.admit('TURN');const injected=probeId==='controller.auth_stop'?'authentication-required':probeId==='controller.quota_stop'?'quota-exceeded':undefined;
   const turnInput:Parameters<SessionProcess['startTurn']>[0]={threadId:thread.threadId,model:c.r.intent.model,effort:c.r.intent.effort,authMode:'managed-chatgpt',operation:injected?'injected-recovery':probeId==='worker.allowed_edit'?'allowed-edit':probeId==='worker.correlated_lifecycle'?'lifecycle':'subscription',...(injected?{injectedResponse:injected}:{}),...(probeId==='worker.allowed_edit'?{edit:{path:'qualification-edit.txt',postimage:'QUALIFIED_EDIT\r\n'}}:{})};
   const turn=await c.call('turn-start',async()=>{c.admit('TURN');return deps.seam.startTurn(turnInput);},false,turnInput);
   if(turn.threadId!==thread.threadId||!turn.turnId||turn.model!==c.r.intent.model||turn.effort!==c.r.intent.effort)throw new DriverFailure('TURN_SETTINGS_MISMATCH');
   if(injected){if(turn.response!==injected)throw new DriverFailure('INJECTED_RESPONSE_MISMATCH');recovery=injected;evidence.push({category:'injected_response',body:{response:injected,model:c.r.intent.model,effort:c.r.intent.effort}});}
   else if(turn.response!=='completed'||!correlated(turn.events,thread.threadId,turn.turnId))throw new DriverFailure('LIFECYCLE_MISMATCH');
   else evidence.push({category:'lifecycle',body:{correlated:true,completed:true,eventCount:turn.events.length,threadIdHash:digest(thread.threadId),turnIdHash:digest(turn.turnId)}});
  }
 }catch(error){reason=failureCode(error,'SESSION_OPERATION_FAILED');}
 finally{terminal=await c.cleanup();}
 if(!terminal)return result(c.dispatched?'FAIL':'REFUSED',c.dispatched?'TERMINAL_RECONCILIATION_REQUIRED':reason);
 if(reason!=='SESSION_CASE_PASSED')return result('FAIL',reason);
 try{
  if(probeId==='worker.unapproved_config_inactive'){
   const observations=await c.call('inactivity-observe',()=>deps.seam.observeInactivity());
   if(observations.length!==monitoredPaths.length||monitoredPaths.some(path=>{const matches=observations.filter(value=>value.path===path);return matches.length!==1||matches[0]!.armedAt!==armedAt||matches[0]!.activationCount!==0||!Number.isSafeInteger(matches[0]!.observedThrough)||matches[0]!.observedThrough<c.terminalAt;}))throw new DriverFailure('INACTIVITY_UNPROVEN');
   const monitors=observations.map(value=>StartupMonitorObservationSchema.parse(value));
   evidence.push({category:'startup',body:{armedAt,terminalAt:c.terminalAt,monitors,paths:observations.map(value=>({path:value.path,activationCount:value.activationCount,observedThrough:value.observedThrough}))}},{category:'observed_controls',body:{inactivePaths:[...INACTIVITY_PATHS]}});
  }
  if(probeId==='worker.allowed_edit'){
   if(await c.call('edit-read',()=>deps.seam.readEdit({path:'qualification-edit.txt'}),false,{path:'qualification-edit.txt'})!=='QUALIFIED_EDIT\r\n')throw new DriverFailure('EDIT_POSTIMAGE_MISMATCH');
   if(!protectedMatch(await c.call('protected-snapshot',()=>deps.seam.snapshotProtected()),c.r.protectedInputs))throw new DriverFailure('PROTECTED_INPUT_CHANGED');
  }
  if(cancel){if(!c.r.unrelated)throw new DriverFailure('UNRELATED_IDENTITY_UNRESOLVED');const heartbeatInput={minimumWindowMs:2000 as const,unrelated:c.r.unrelated};const heartbeat=await c.call('heartbeat-observe',()=>deps.seam.observeHeartbeat(structuredClone(heartbeatInput)),true,heartbeatInput);const samples=heartbeat.samples;
   if(!c.matches(heartbeat.ownership)||samples.length<2||!samples.every((sample,index)=>Number.isSafeInteger(sample.at)&&sample.at>=c.terminalAt&&sample.value.length>0&&sample.value===samples[0]!.value&&(index===0||sample.at>=samples[index-1]!.at))||samples.at(-1)!.at-samples[0]!.at<2000||!heartbeat.unrelated.alive||!Number.isSafeInteger(heartbeat.unrelated.pid)||heartbeat.unrelated.pid<=0||!heartbeat.unrelated.creationIdentity||heartbeat.unrelated.pid===c.actualIdentity!.pid||heartbeat.unrelated.pid===c.actualIdentity!.helperPid||heartbeat.unrelated.name.toLowerCase()!==win32.basename(c.r.intent.runtime.path).toLowerCase()||!same({pid:heartbeat.unrelated.pid,creationIdentity:heartbeat.unrelated.creationIdentity,name:heartbeat.unrelated.name},c.r.unrelated))throw new DriverFailure('HEARTBEAT_OR_UNRELATED_UNPROVEN');
   evidence.push({category:'heartbeat',body:{samples:samples.map(value=>({at:value.at,valueHash:digest(value.value)})),stableForMs:samples.at(-1)!.at-samples[0]!.at}},{category:'unrelated_process',body:{...c.r.unrelated,alive:true}});
  }
  if(!c.unrelatedValid)throw new Refusal('UNRELATED_IDENTITY_CHANGED');
  if(recovery){const input={reason:recovery as 'authentication-required'|'quota-exceeded',retry:false as const,providerFallback:false as const,recoveryRequiresApproval:true as const,ownership:c.owned!};const checkpoint=await c.call('checkpoint',()=>deps.seam.checkpoint(input),false,input);if(!checkpoint.saved||!checkpoint.recoveryRequiresApproval)throw new DriverFailure('CHECKPOINT_UNPROVEN');evidence.push({category:'checkpoint',body:{reason:recovery,saved:true,retry:false,providerFallback:false,recoveryRequiresApproval:true}});return {...result('PASS',reason),recoveryRequiresApproval:true};}
 }catch(error){return result('FAIL',failureCode(error,'POST_DRAIN_OBSERVATION_FAILED'));}
 return result('PASS',reason);
}

/** Terminal metadata uses the same owned/charged operation path, while never
 * requesting prepare, a thread or a turn. Its receipt is evidence only. */
export async function runTerminalMetadata(request:SessionRequest,deps:SessionDeps):Promise<SessionResult>{
 const kind=deps.evidenceKind??'simulation';let c:ReturnType<typeof context>|undefined;
 const result=(status:SessionResult['status'],reason:string):SessionResult=>({status,reason,evidenceKind:kind,catalogProbe:false,evidence:[...(c?.evidence??[])],startupEvidence:c?retainStartupProof(c.r,c.evidence,kind,status):[],managedConflicts:c?c.managedConflicts.map(projection=>({actionId:c!.r.intent.owner.actionId,projection})):[]});
 try{c=context(request,deps);const authorization=c.r.intent.dispatchAuthorization;if(c.r.intent.action!=='metadata'||c.r.intent.owner.role!=='startup-metadata'||authorization.kind!=='qualification'||authorization.probeId!=='auxiliary.metadata')return result('REFUSED','METADATA_PURPOSE_MISMATCH');}catch(error){return result('REFUSED',failureCode(error,'INVALID_INPUT'));}
 let reason='TERMINAL_METADATA',terminal=false;
 try{await c.launch(c.r.argv);await c.initialize();}catch(error){reason=failureCode(error,'METADATA_FAILED');}finally{terminal=await c.cleanup();}
 if(!terminal)return result(c.dispatched?'FAIL':'REFUSED','TERMINAL_RECONCILIATION_REQUIRED');
 return result(reason==='TERMINAL_METADATA'?'PASS':'FAIL',reason);
}

/** Strict checks are auxiliary actions, never extra catalog probes. Negative exchanges no RPCs. */
export async function runStrictPair(input:{positive:SessionRequest;negative:SessionRequest},deps:SessionDeps&{negativeSeam:SessionProcess}):Promise<SessionResult> {
 const request=frozen(structuredClone(input));
 const evidence:SessionEvidence[]=[],startupEvidence:StartupSessionProof[]=[],managedConflicts:NonNullable<SessionResult['managedConflicts']>=[];const result=(status:SessionResult['status'],reason:string):SessionResult=>({status,reason,evidenceKind:deps.evidenceKind??'simulation',catalogProbe:false,evidence:[...evidence],startupEvidence:[...startupEvidence],managedConflicts:[...managedConflicts]});
 const positiveAuth=request.positive.intent.dispatchAuthorization,negativeAuth=request.negative.intent.dispatchAuthorization;
 if(positiveAuth.kind!=='qualification'||negativeAuth.kind!=='qualification'||positiveAuth.probeId!=='auxiliary.strict-positive'||negativeAuth.probeId!=='auxiliary.strict-negative')return result('REFUSED','STRICT_PURPOSE_MISMATCH');
 // The purpose guard above rejects all normal task authority before any effect.
 const baseline=(intent:StartupIntent,authorization:Extract<StartupIntent['dispatchAuthorization'],{kind:'qualification'}>)=>{const {requestId:_request,argumentsHash:_arguments,dispatchHash:_dispatch,owner,dispatchAuthorization:_authorization,...target}=intent;const {actionId:_action,...ownerScope}=owner;return {...target,owner:ownerScope,authorization:{kind:authorization.kind,fixtureRoots:authorization.fixtureRoots}};};
 if(!same(baseline(request.positive.intent,positiveAuth),baseline(request.negative.intent,negativeAuth))||request.positive.intent.owner.actionId===request.negative.intent.owner.actionId||!same(request.positive.argv,request.negative.argv)||!request.positive.argv.includes('--strict-config')||request.positive.argv[0]!=='app-server'||request.positive.argv.filter(arg=>arg==='--stdio'||arg==='stdio://').length!==1)return result('REFUSED','STRICT_BASELINE_MISMATCH');
 for(const negative of [false,true]){
  let c:ReturnType<typeof context>;try{c=context(negative?request.negative:request.positive,{...deps,seam:negative?deps.negativeSeam:deps.seam});}catch(error){return result('REFUSED',failureCode(error,'INVALID_INPUT'));}const seam=negative?deps.negativeSeam:deps.seam;let reason='STRICT_PAIR_PASSED';let terminal=false;let negativeOutcome:{exitCode:number;rpcCount:number}|undefined;
  try{await c.launch(negative?[...c.r.argv,'-c','foo="bar"']:c.r.argv,negative);
   if(negative){const outcome=await c.call('strict-outcome',()=>seam.strictOutcome());if(outcome.exitCode===0||outcome.rpcCount!==0||outcome.stderr.trim()!=='unknown configuration field `foo` in -c/--config override')throw new DriverFailure('STRICT_DIAGNOSTIC_MISMATCH');negativeOutcome={exitCode:outcome.exitCode,rpcCount:outcome.rpcCount};}
   else await c.initialize();
  }catch(error){reason=failureCode(error,'STRICT_CHECK_FAILED');}finally{terminal=await c.cleanup();evidence.push(...c.evidence);managedConflicts.push(...c.managedConflicts.map(projection=>({actionId:c.r.intent.owner.actionId,projection})));}
  const drained=c.evidence.filter(e=>e.category==='drain'&&e.body.kind!=='broker-reconciliation').at(-1)?.body;
  if(drained&&typeof drained.rootExitCode==='number')startupEvidence.push(...retainStartupProof(c.r,c.evidence,deps.evidenceKind??'simulation',reason==='STRICT_PAIR_PASSED'&&terminal?'PASS':'FAIL',{
   phase:negative?'negative':'positive',baselineHash:fingerprint(baseline(request.positive.intent,positiveAuth)),classification:negative?'unknown-field-foo':'initialized',exitCode:negativeOutcome?.exitCode??drained.rootExitCode,
   rpcCount:negativeOutcome?.rpcCount??0,termination:drained.rootExitCause==='natural'||drained.reason==='root_exit'&&drained.requestAcknowledged===false?'natural':drained.rootExitCause===undefined?'unknown':'forced'}));
  if(!terminal)return result(c.dispatched?'FAIL':'REFUSED','TERMINAL_RECONCILIATION_REQUIRED');
  if(reason!=='STRICT_PAIR_PASSED')return result('FAIL',reason);
 }
 return result('PASS','STRICT_PAIR_PASSED');
}
