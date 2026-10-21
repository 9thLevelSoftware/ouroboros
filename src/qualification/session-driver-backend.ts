import { createHash } from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import { win32 } from 'node:path';
import { WindowsDrainEvidenceSchema, WindowsOwnershipReceiptSchema, type ExecutionOwner, type LaunchInput, type OwnedExecution, type OwnershipReceipt, type Supervisor } from '../contracts/execution.ts';
import { ObservedExecutionSchema, QualificationTerminalSchema, type QualificationObservationClient, type ObservationTrigger } from '../contracts/qualification-observation.ts';
import { CodexTransport, JsonlDecoder, qualificationMetadataClientName, type Incoming } from '../providers/codex/transport.ts';
import { checkControls, checkMetadataControls, codexRemoteControlState, denyServerRequest, projectConfig, projectRequirements, record } from '../providers/codex/policy.ts';
import { projectCodexThreadSettings, codexThreadSettingsSafe, type SafeSettings } from '../providers/codex/adapter.ts';
import { projectManagedAccount } from '../providers/codex/startup-metadata.ts';
import { assessPhaseAdmission, ownershipHash, STARTUP_SOURCES, startupTargetHash, StartupIntentSchema, type StartupIntent } from './codex-startup-authority.ts';
import { INACTIVITY_PATHS, type SessionDeps, type SessionEvent, type SessionProcess, type SessionTurn } from './session-drivers.ts';
import { createManagedPolicyConflictProjection, sourceCoveredStartupPaths, validateStartupCoverageForPreparation, type StartupCoverageManifest, type StartupPolicyObservation } from './startup-evidence.ts';
import type { RunStore } from '../store/database.ts';
import type { QualificationTarget } from './ledger.ts';
import { prevalidateCodexLaunchArgv, CODEX_CONFIG_SCHEMA } from '../providers/codex/launch-config.ts';
import { fingerprint } from './probes.ts';
import { type createControlledEndpointClient } from './fixed-driver-backend.ts';
import { PendingDispatchDescriptorSchema, type PendingDispatchDescriptor, type createPendingDispatchQueue } from './pending-dispatch.ts';

type Pin={path:string;sha256:string};
type Phase='BOOTSTRAP'|'PRE_THREAD'|'TURN';
export type SessionBackendGate=(phase:Phase|'CLEANUP')=>void;
export type SessionBackendCapture={write(bytes:Uint8Array):void;processCompleted?(meter:{kind:'root'|'helper';identity:{pid:number;creationIdentity:string};activeMs:number}):void};
export type SessionFilePrimitives={readFile(path:string):Promise<Uint8Array>;writeFile(path:string,bytes:Uint8Array,flags:'wx'|'w'):Promise<void>;appendFile(path:string,bytes:Uint8Array):Promise<void>;realpath(path:string):Promise<string>};
export type SessionCanary={path:typeof INACTIVITY_PATHS[number];sentinel:string;baselineHash:string;registrations:Array<Pin&{source?:typeof STARTUP_SOURCES[number]}>;
 /** Reviewed applicable-source provenance supplements actual configured canaries;
  * it is not runtime permission or a complete managed/cloud snapshot. */
 coverage?:{controlHash:string;sources:Array<{source:typeof STARTUP_SOURCES[number];applicability:'applicable'|'not-applicable'|'unknown';route?:'registered-canary'|'persistent-restriction';evidence?:Pin}>}};
export type SessionService={client:ReturnType<typeof createControlledEndpointClient>;ownership:OwnershipReceipt};
export type OwnedBrokerRegistry={schemaVersion:1;scope:'campaign-owned-controlled-services';source:'campaign-owned-resource-registry';owner:ExecutionOwner;targetHash:string;controlHash:string;registeredActionIds:string[]};
export type SessionPendingDispatch={queue:ReturnType<typeof createPendingDispatchQueue>;descriptor:PendingDispatchDescriptor;targetHash:string};
export type SessionBackendOptions={supervisor?:Supervisor;supervisorFor?:(capture:SessionBackendCapture,effectGate:SessionBackendGate,intent:Readonly<StartupIntent>)=>Supervisor;env:Record<string,string>;currentAdmission:NonNullable<SessionDeps['currentAdmission']>;
 fixture:{root:string;controlHash:string;monitorActionId:string;activityDriver:Pin;boundaryDriver?:Pin;canaries:SessionCanary[];protectedFiles:Record<string,string>;heartbeat:string;checkpoint:string};
 fs?:SessionFilePrimitives;now?:()=>number;sleep?:(ms:number)=>Promise<void>;timeoutMs?:number;
 startupEvidence?:{store:RunStore;target:QualificationTarget;fixtureHash:string};
 broker?:SessionService;ownedBrokerRegistry?:(intent:Readonly<StartupIntent>)=>OwnedBrokerRegistry|undefined;pendingDispatch?:SessionPendingDispatch;observation?:QualificationObservationClient|(()=>QualificationObservationClient);
};
export type FixedSessionCommand={executable:string;argv:string[];expectedResource:Pin;beforeExecute():void};
export type FixedSessionCommandResult={provenance:'codex-commandExecution';attempted:true;exitCode:number;stdout:string;stderr:string;threadId:string;turnId:string;itemId:string};
export type ConcreteSessionProcess=SessionProcess&{executeFixedCommand(command:FixedSessionCommand):Promise<FixedSessionCommandResult>};
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const digest=(value:unknown)=>sha(JSON.stringify(value));
const text=(bytes:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const freeze=<T>(value:T):Readonly<T>=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
function failure(code:string):never {throw Error(code);}
function absolute(path:string){return /^[A-Za-z]:\\/.test(path)&&win32.normalize(path)===path&&!path.includes('/')&&!path.startsWith('\\\\')&&!path.slice(2).includes(':')&&!/[\x00-\x1f]/.test(path);}
function inside(path:string,root:string){const relative=win32.relative(root,path);return relative!==''&&!relative.startsWith('..')&&!win32.isAbsolute(relative);}
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
/** This constructor and module import are inert. Only explicit seam calls perform effects. */
export function createSessionBackend(input:SessionBackendOptions){
 const options={...input,env:structuredClone(input.env),fixture:structuredClone(input.fixture),pendingDispatch:input.pendingDispatch?{...input.pendingDispatch,descriptor:structuredClone(input.pendingDispatch.descriptor)}:undefined};
 const fs:SessionFilePrimitives=options.fs??{readFile:path=>nativeFs.readFile(path),writeFile:async(path,bytes,flags)=>{await nativeFs.writeFile(path,bytes,{flag:flags});},appendFile:(path,bytes)=>nativeFs.appendFile(path,bytes),realpath:path=>nativeFs.realpath(path)};
 const now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),timeout=options.timeoutMs??5000;
 const used=new Set<string>();
 async function pathChecked(path:string){if(!absolute(path)||!inside(path,options.fixture.root))failure('FIXTURE_PATH_REFUSED');const resolved=await fs.realpath(path);if(resolved.toLowerCase()!==path.toLowerCase()||!inside(resolved,options.fixture.root))failure('FIXTURE_LINK_REFUSED');return path;}
 async function read(path:string){const bytes=await fs.readFile(await pathChecked(path));if(bytes.length>262144)failure('FIXTURE_READ_LIMIT');return bytes;}
 async function pinned(pin:Pin){if(!/^[a-f0-9]{64}$/.test(pin.sha256)||sha(await read(pin.path))!==pin.sha256)failure('RESOURCE_IDENTITY_CHANGED');}
 return {process(capture:SessionBackendCapture,effectGate:SessionBackendGate):ConcreteSessionProcess{
  if(typeof effectGate!=='function'||typeof options.currentAdmission!=='function')failure('EXTERNAL_ADMISSION_REQUIRED');
  let intent:StartupIntent|undefined,owned:OwnedExecution|undefined,identity:OwnershipReceipt|undefined,transport:CodexTransport|undefined,observationHash:string|undefined;
  let wirePhase:Phase='BOOTSTRAP',threadId='',turnId='',settingsHash='',fenced=false,drained=false,failed=false,armedAt=0,rpcCount=0,stderr='';
  let stopCapture:()=>void=()=>{},lease:ReturnType<typeof setInterval>|undefined;let leaseSequence=0;
  const events:SessionEvent[]=[],messages:Incoming[]=[];const settings=new Map<string,SafeSettings>();let wake:()=>void=()=>{};
  let completedItem:Record<string,unknown>|undefined,startedItem:Record<string,unknown>|undefined;let expectedCommand='';let cancelledActive=false;
  let activeCanary:Readonly<{threadId:string;turnId:string;itemId:string;command:string;startIndex:number}>|undefined;
  let recoveryResponse:'authentication-required'|'quota-exceeded'|undefined;
  let deathTrigger:ObservationTrigger|undefined;
  let pendingBinding:PendingDispatchDescriptor|undefined;
  let policyObservation:StartupPolicyObservation|undefined;let startupAccountUpdates=0;let startupWarnings=0;let startupObserved=false;let remoteStatusReports=0;
  let expectedNetwork=false;let strictPositive=false;const reportedMeters=new Set<string>();
  let strictNatural:ReturnType<typeof WindowsDrainEvidenceSchema.parse>|undefined;
  let preparationCoverage:StartupCoverageManifest|undefined,preparationIntentHash:string|undefined;let preparedMonitors:readonly string[]=[];
  async function naturalStrictExit(){
   if(strictNatural)return strictNatural;
   const state=current();if(!state.owned.waitForDrain)failure('STRICT_NATURAL_TERMINAL_UNAVAILABLE');
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    const terminal=WindowsDrainEvidenceSchema.parse(await Promise.race([state.owned.waitForDrain!(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('STRICT_NATURAL_TERMINAL_TIMEOUT')),Math.min(1000,timeout));})]));
    if(Object.entries(state.intent.owner).some(([key,value])=>terminal[key as keyof typeof terminal]!==value)||terminal.reason!=='root_exit'||terminal.requestAcknowledged||terminal.acknowledgedAt!==null||!terminal.rootExited||terminal.rootExitCode===undefined||terminal.rootExitCode===null||terminal.rootExitedAt===null||terminal.rootExitedAt<state.identity.capturedAt||!terminal.membershipEmpty||terminal.activeProcesses!==0||terminal.unresolvedExecutions.length||!terminal.outputComplete||terminal.unresolvedOutputStreams.length||terminal.outputCompletedAt===null)failure('STRICT_EXIT_IMPOSED');
    strictNatural=terminal;return terminal;
   }finally{clearTimeout(timer);}
  }
  const monitorMarker=`MONITOR_CHECK:${options.fixture.monitorActionId}:${options.fixture.controlHash}`;
  const observer=()=>{if(!options.observation)failure('UNSUPPORTED_NATIVE_OBSERVATION');return typeof options.observation==='function'?options.observation():options.observation;};
  const observed=async()=>{const state=current();const d=ObservedExecutionSchema.parse(await observer().describeObservedExecution());const root=WindowsOwnershipReceiptSchema.parse(state.identity);
   if(d.runId!==root.runId||d.generation!==root.generation||d.actionId!==root.actionId||d.role!==root.role||d.boundaryHash!==root.boundaryHash||d.root.pid!==root.pid||d.root.creationIdentity!==root.creationIdentity||d.helper.pid!==root.helperPid||d.helper.creationIdentity!==root.helperCreationIdentity||d.innerJobIdentity!==root.jobIdentity)failure('OBSERVATION_IDENTITY_CHANGED');return d;};
  async function writeFixture(path:string,bytes:Uint8Array,flags:'wx'|'w',phase:Phase|'CLEANUP'){
   if(!absolute(path)||!inside(path,options.fixture.root))failure('FIXTURE_PATH_REFUSED');const parent=win32.dirname(path);if((await fs.realpath(parent)).toLowerCase()!==parent.toLowerCase())failure('FIXTURE_LINK_REFUSED');
   effectGate(phase);await fs.writeFile(path,bytes,flags);
  }
  const current=()=>{if(!intent||!owned||!identity)failure('SESSION_NOT_LAUNCHED');return {intent:intent!,owned:owned!,identity:identity!};};
  const guard=(phase:Phase)=>{if(!intent)failure('SESSION_NOT_LAUNCHED');effectGate(phase);const approval=options.currentAdmission(phase,freeze(structuredClone(intent!)),identity?freeze(structuredClone(identity)):undefined,observationHash);
   const decision=assessPhaseAdmission(intent,approval,now(),phase,identity,observationHash);if(!decision.authorized)failure('CURRENT_PHASE_REFUSED');if(fenced||failed)failure('SESSION_FENCED');wirePhase=phase;return approval!;};
  const initializationAllowance=(admissionExpiresAt:number)=>Math.min(60000,intent!.budget.activeMs,intent!.expiresAt-now(),admissionExpiresAt-now());
  const receipt=async()=>{const state=current();const actual=await state.owned.describe();if(ownershipHash(actual)!==ownershipHash(state.identity))failure('OWNERSHIP_CHANGED');return structuredClone(state.identity);};
  const consume=(message:Incoming)=>{
   if(message.method==='remoteControl/status/changed'){
    if(message.id!==undefined||++remoteStatusReports>32||codexRemoteControlState(message.params)!=='disabled')failed=true;
    wake();return;
   }
   if(messages.length>=128){failed=true;wake();return;}messages.push(message);
   const p=record(message.params);
   if(message.id!==undefined){void transport?.send(denyServerRequest({id:message.id,method:message.method}).response).catch(()=>{failed=true;wake();});failed=true;wake();return;}
   if(message.method==='thread/settings/updated'){if(typeof p.threadId==='string'){const next=projectCodexThreadSettings(p,{profile:intent!.profile,model:intent!.model!,effort:intent!.effort!,cwd:intent!.workspace},'notification');settings.set(p.threadId,next);if(settingsHash&&p.threadId===threadId&&fingerprint(next)!==settingsHash)failed=true;}wake();return;}
   if(message.method==='error'||message.method==='turn/completed'&&record(p.turn).status==='failed'){
    const error=record(message.method==='error'?p.error:record(p.turn).error);const code=error.codexErrorInfo;
    if(message.method==='error'&&p.willRetry===true&&!['unauthorized','usageLimitExceeded','rateLimitExceeded','sessionBudgetExceeded'].includes(String(code))){wake();return;}
    if(code==='unauthorized')recoveryResponse='authentication-required';
    if(['usageLimitExceeded','rateLimitExceeded','sessionBudgetExceeded'].includes(String(code)))recoveryResponse='quota-exceeded';failed=true;wake();return;
   }
   if(!startupObserved&&message.method==='account/updated'&&++startupAccountUpdates<=32){wake();return;}
   if(!startupObserved&&message.method==='configWarning'&&++startupWarnings<=32){wake();return;}
   if(message.method==='account/rateLimits/updated'){const q=record(p.rateLimits);if(q.spendControlReached!==true&&!['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached'].includes(String(q.rateLimitReachedType))){wake();return;}}
   if(['account/updated','account/rateLimits/updated','model/rerouted','configWarning','hook/started','skills/changed','app/list/updated'].includes(message.method)||message.method.startsWith('mcpServer/')||message.method.startsWith('modelProvider/authRecovery')){failed=true;wake();return;}
   wake();
  };
  // This validates the latest correlated notification state; it is not an atomic
  // process-liveness claim. Passive model items before the canary are not tools.
  const assertActiveCanary=()=>{const active=activeCanary;if(!active||cancelledActive||active.threadId!==threadId||active.turnId!==turnId||active.command!==expectedCommand||active.startIndex<0)failure('CANCELLATION_COMMAND_NOT_ACTIVE');let turns=0,items=0;
   for(let index=0;index<messages.length;index++){const message=messages[index]!,p=record(message.params);
    if(message.method==='turn/started'){if(p.threadId!==active.threadId||record(p.turn).id!==active.turnId)failure('CANCELLATION_COMMAND_NOT_ACTIVE');turns++;}
    if(message.method==='turn/completed')failure('CANCELLATION_COMMAND_NOT_ACTIVE');
    if(message.method!=='item/started'&&message.method!=='item/completed')continue;const item=record(p.item);
    if(p.threadId!==active.threadId||p.turnId!==active.turnId)failure('CANCELLATION_COMMAND_NOT_ACTIVE');
    if(index<active.startIndex&&['userMessage','agentMessage','reasoning','plan'].includes(String(item.type)))continue;
    if(message.method!=='item/started'||index!==active.startIndex||item.type!=='commandExecution'||item.id!==active.itemId||item.command!==active.command)failure('CANCELLATION_COMMAND_NOT_ACTIVE');items++;
   }if(turns!==1||items!==1)failure('CANCELLATION_COMMAND_NOT_ACTIVE');
  };
  async function until(predicate:()=>boolean){const end=now()+timeout;let iterations=0;while(!predicate()){if(failed||++iterations>128||now()>=end)failure('SESSION_EVENT_UNAVAILABLE');
    // Notifications are normally synchronous with the response in tests; the real
    // path waits for either bounded incoming protocol activity or a finite timer.
    await Promise.race([new Promise<void>(resolve=>{wake=resolve;}),sleep(Math.min(20,Math.max(1,end-now())))]);}
   wake=()=>{};
  }
  const request=async(method:'account/read'|'config/read'|'configRequirements/read'|'thread/start'|'turn/start'|'turn/interrupt',params:unknown,phase:Phase)=>{guard(phase);if(method==='turn/interrupt')assertActiveCanary();rpcCount++;return await transport!.request(method,params as never);};
  function projectedEvents(id:string){const values:SessionEvent[]=[];
   for(const m of messages){const p=record(m.params);if(m.method==='thread/started'&&record(p.thread).id===threadId){if(!values.some(v=>v.kind==='thread-started'))values.push({kind:'thread-started',threadId});continue;}
    const tid=typeof p.turnId==='string'?p.turnId:record(p.turn).id;if(p.threadId!==threadId||tid!==id)continue;
    if(m.method==='turn/started')values.push({kind:'turn-started',threadId,turnId:id});
    if(m.method==='item/started'||m.method==='item/completed'){const item=record(p.item);if(item.type!=='commandExecution')continue;if(item.command!==expectedCommand||typeof item.id!=='string')failure('UNEXPECTED_TOOL_COMMAND');
     if(m.method==='item/started'){if(startedItem)failure('MULTIPLE_TOOL_ITEMS');startedItem=item;values.push({kind:'item-started',threadId,turnId:id,itemId:item.id});}
     else {if(!startedItem||startedItem.id!==item.id)failure('TOOL_ITEM_MISMATCH');completedItem=item;values.push({kind:'item-completed',threadId,turnId:id,itemId:item.id});}}
    if(m.method==='turn/completed'){if(record(p.turn).status!=='completed')failure('TURN_DID_NOT_COMPLETE');values.push({kind:'turn-completed',threadId,turnId:id});}
   }return values;
  }
  function snapshotToolItems():{started:Record<string,unknown>|undefined;completed:Record<string,unknown>|undefined}{return {started:startedItem,completed:completedItem};}
  const commandResult=async(command:FixedSessionCommand,wait=true)=>{
   const state=current();if(!threadId||fenced||failed)failure('THREAD_REQUIRED');if(command.executable!==state.intent.node.path||command.argv.length<2||command.argv[0]!=='--preserve-symlinks-main'||command.argv[1]!==command.expectedResource.path)failure('FIXED_COMMAND_REFUSED');
   const allowed=[options.fixture.activityDriver,options.fixture.boundaryDriver].filter(Boolean) as Pin[];if(!allowed.some(pin=>pin.path===command.expectedResource.path&&pin.sha256===command.expectedResource.sha256))failure('UNPINNED_COMMAND_RESOURCE');
   activeCanary=undefined;cancelledActive=false;await pinned(command.expectedResource);expectedCommand='& '+[command.executable,...command.argv].map(quote).join(' ');startedItem=undefined;completedItem=undefined;
   // Retain only the actual thread-start notification across fixed turns.
   for(let index=messages.length-1;index>=0;index--)if(messages[index]!.method!=='thread/started')messages.splice(index,1);
   command.beforeExecute();guard('TURN');const response=record(await request('turn/start',{threadId,input:[{type:'text',text:expectedCommand,text_elements:[]}],model:state.intent.model,effort:state.intent.effort,cwd:state.intent.workspace,approvalPolicy:'on-request',approvalsReviewer:'user'},'TURN'));
   const resultTurn=record(response.turn);if(typeof resultTurn.id!=='string'||!resultTurn.id)failure('TURN_ID_UNAVAILABLE');turnId=resultTurn.id;
   if(!wait){await until(()=>messages.some(m=>m.method==='item/started'&&record(m.params).threadId===threadId&&record(m.params).turnId===turnId));const actualEvents=projectedEvents(turnId),items=snapshotToolItems();if(!items.started||items.completed)failure('CANCELLATION_COMMAND_NOT_ACTIVE');const activeItem=items.started;activeCanary=freeze({threadId,turnId,itemId:activeItem.id as string,command:expectedCommand,startIndex:messages.findIndex(m=>m.method==='item/started'&&record(m.params).threadId===threadId&&record(m.params).turnId===turnId&&record(record(m.params).item).id===activeItem.id)});assertActiveCanary();return {turnId,events:actualEvents};}
   await until(()=>messages.some(m=>m.method==='turn/completed'&&record(m.params).threadId===threadId&&record(record(m.params).turn).id===turnId));
   const actualEvents=projectedEvents(turnId),items=snapshotToolItems(),completed=items.completed;if(!items.started||!completed||typeof completed.exitCode!=='number'||!Number.isInteger(completed.exitCode)||typeof completed.aggregatedOutput!=='string'||actualEvents.length!==5)failure('TOOL_EXECUTION_UNPROVEN');
   if(Buffer.byteLength(completed.aggregatedOutput)>8192)failure('TOOL_OUTPUT_LIMIT');
   return {turnId,events:actualEvents,result:{provenance:'codex-commandExecution' as const,attempted:true as const,exitCode:completed.exitCode,stdout:completed.aggregatedOutput,stderr:'',threadId,turnId,itemId:completed.id as string}};
  };
  const activity=(mode:string)=>{const state=current();return {executable:state.intent.node.path,argv:['--preserve-symlinks-main',options.fixture.activityDriver.path,mode,options.fixture.root],expectedResource:options.fixture.activityDriver,beforeExecute:()=>guard('TURN')};};
  const pendingDescriptor=(actionId:string|undefined)=>{const state=current(),configured=options.pendingDispatch;if(!configured||!actionId)failure('UNSUPPORTED_PENDING_QUEUE');const parsed=PendingDispatchDescriptorSchema.safeParse(configured.descriptor);if(!parsed.success)failure('PENDING_DESCRIPTOR_REFUSED');const d=parsed.data,l=d.launch,a=state.intent.dispatchAuthorization;
   if(a.kind!=='qualification'||a.probeId!=='controller.pending_dispatch_cancel'||d.parentActionId!==state.intent.owner.actionId||d.actionId!==actionId||d.owner.runId!==state.intent.owner.runId||d.owner.generation!==state.intent.owner.generation||!/^[a-f0-9]{64}$/.test(configured.targetHash)||d.targetHash!==configured.targetHash||l.role!=='pending-canary'||l.executable!==state.intent.node.path||JSON.stringify(l.argv)!==JSON.stringify(activity('foreground').argv)||l.cwd!==state.intent.workspace||digest(l.env)!==state.intent.environmentHash||l.boundaryHash!==state.intent.boundaryHash||l.stdin!=='closed'||l.deadline>state.intent.expiresAt||l.deadline<=now()||l.authorization.kind!=='qualification'||l.authorization.requestId!==a.requestId||l.authorization.probeId!=='auxiliary.preparation'||JSON.stringify(l.authorization.fixtureRoots)!==JSON.stringify(a.fixtureRoots))failure('PENDING_DESCRIPTOR_REFUSED');return freeze(structuredClone(d));};
  const pendingState=(expected:'pending'|'cancelled-before-dispatch')=>{if(!pendingBinding||!options.pendingDispatch)failure('PENDING_NOT_ARMED');guard('TURN');const inspected=options.pendingDispatch.queue.inspect(pendingBinding.owner,pendingBinding.actionId);if(!inspected.ok)failure('PENDING_QUEUE_INSPECTION_REFUSED');const s=inspected.value;if(s.actionId!==pendingBinding.actionId||s.generation!==pendingBinding.owner.generation||s.state!==expected||s.dispatchCount!==0||s.createdProcessIdentities.length||s.creationEvidenceIds.length)failure('PENDING_CREATION_UNPROVEN');return {actionId:s.actionId,generation:s.generation,state:expected,dispatchCount:s.dispatchCount,createdProcessIdentities:[...s.createdProcessIdentities]};};
  const process:ConcreteSessionProcess={
   async prepare(input){if(input.paths.length!==0&&(input.paths.length!==INACTIVITY_PATHS.length||INACTIVITY_PATHS.some(path=>!input.paths.includes(path))))failure('CANARY_PATHS_INCOMPLETE');await pinned(options.fixture.activityDriver);
    let sourceCovered:readonly string[]=[];
    if(input.coverage){const context=options.startupEvidence;if(!context||!input.intent||input.workspace!==input.intent.workspace||input.coverage.controlHash!==options.fixture.controlHash||input.coverage.environmentHash!==digest(options.env))failure('STARTUP_COVERAGE_UNAVAILABLE');
     preparationCoverage=validateStartupCoverageForPreparation(context.store,context.target,context.fixtureHash,input.intent,input.coverage);preparationIntentHash=fingerprint(input.intent);
     sourceCovered=sourceCoveredStartupPaths(preparationCoverage).filter(path=>input.paths.includes(path));}
    const monitored=input.paths.filter(path=>!sourceCovered.includes(path));
    for(const path of monitored){const entries=options.fixture.canaries.filter(value=>value.path===path);if(entries.length!==1)failure('CANARY_REGISTRATION_UNAVAILABLE');const entry=entries[0]!;
     for(const pin of entry.registrations)await pinned(pin);
     if(!entry.coverage||!entry.registrations.length)failure('CANARY_SOURCE_COVERAGE_UNSUPPORTED');const proof=entry.coverage;
     if(proof.controlHash!==options.fixture.controlHash||proof.sources.length!==STARTUP_SOURCES.length||new Set(proof.sources.map(source=>source.source)).size!==STARTUP_SOURCES.length)failure('CANARY_SOURCE_COVERAGE_UNSUPPORTED');
     // Source applicability comes from reviewed control evidence. This is not a
     // fabricated cloud snapshot or permission certificate. Unknowns fail this target.
     for(const source of proof.sources){if(!(STARTUP_SOURCES as readonly unknown[]).includes(source.source)||source.applicability==='unknown')failure('CANARY_SOURCE_COVERAGE_UNSUPPORTED');
      if(source.applicability==='not-applicable'){if(!source.evidence)failure('CANARY_SOURCE_COVERAGE_UNSUPPORTED');await pinned(source.evidence);continue;}
      if(source.applicability!=='applicable'||!['registered-canary','persistent-restriction'].includes(String(source.route)))failure('CANARY_SOURCE_COVERAGE_UNSUPPORTED');
      if(source.route==='registered-canary'&&!entry.registrations.some(pin=>pin.source===source.source))failure('CANARY_SOURCE_COVERAGE_UNSUPPORTED');
      if(source.route==='persistent-restriction'){if(!source.evidence)failure('CANARY_SOURCE_COVERAGE_UNSUPPORTED');await pinned(source.evidence!);}}
     const baseline=await read(entry.sentinel);if(sha(baseline)!==entry.baselineHash)failure('CANARY_BASELINE_CHANGED');
     // Append-only self-check: partial/expired preparation retains audit bytes;
     // no stale restoration is attempted and no runtime activation is implied.
     const sentinel=await pathChecked(entry.sentinel);effectGate('BOOTSTRAP');await fs.appendFile(sentinel,Buffer.from(monitorMarker+'\n'));
     if(text(await read(entry.sentinel))!==text(baseline)+monitorMarker+'\n')failure('CANARY_MONITOR_UNPROVEN');
    }preparedMonitors=[...monitored];armedAt=now();return {armedAt,paths:[...monitored],...(preparationCoverage?{sourceCoveredPaths:[...sourceCovered],coverageHash:fingerprint(preparationCoverage)}:{})};},
   async launch(input){if(intent||used.has(input.intent.owner.actionId))failure('SESSION_LAUNCH_REPLAY');intent=StartupIntentSchema.parse(structuredClone(input.intent));
    if(preparationIntentHash&&preparationIntentHash!==fingerprint(intent))failure('STARTUP_COVERAGE_BINDING_CHANGED');
    const clientName=intent.action==='metadata'?qualificationMetadataClientName(intent.owner.actionId):undefined;
    if(Object.keys(options.env).some(key=>!intent!.environmentKeys.includes(key as never))||digest(options.env)!==intent.environmentHash||digest(input.argv)!==intent.argumentsHash||intent.workspace!==win32.join(options.fixture.root,'workspace')||options.fixture.controlHash!==intent.controlHash||options.fixture.monitorActionId!==intent.owner.actionId)failure('LAUNCH_INPUT_CHANGED');
    const requested=prevalidateCodexLaunchArgv({entryPoint:'worker',schema:CODEX_CONFIG_SCHEMA,argv:input.argv});if(requested.ok)expectedNetwork=record(record(record(requested.value.configuration.permissions)[intent.profile]).network).enabled===true;
    strictPositive=intent.dispatchAuthorization.kind==='qualification'&&intent.dispatchAuthorization.probeId==='auxiliary.strict-positive';
    used.add(intent.owner.actionId);guard('BOOTSTRAP');const launch:LaunchInput={...intent.owner,executable:intent.runtime.path,argv:[...input.argv],cwd:intent.workspace,env:{...options.env},boundaryHash:intent.boundaryHash,authorization:intent.dispatchAuthorization,stdin:'pipe',leaseTtlMs:10000,deadline:intent.expiresAt};
    const supervisor=options.supervisorFor?options.supervisorFor(capture,effectGate,freeze(structuredClone(intent))):options.supervisor;if(!supervisor)failure('OWNED_SUPERVISOR_REQUIRED');
    guard('BOOTSTRAP');const launched=await supervisor!.launchOwned(launch);if(!launched.ok)failure('SESSION_LAUNCH_REFUSED');owned=launched.value;const actual=WindowsOwnershipReceiptSchema.parse(await owned.describe());
    if(actual.pid===actual.helperPid||actual.boundaryHash!==intent.boundaryHash||Object.entries(intent.owner).some(([key,value])=>actual[key as keyof typeof actual]!==value))failure('OWNERSHIP_CHANGED');identity=freeze(structuredClone(actual));
    const forwarders=new Set<Parameters<OwnedExecution['onOutput']>[0]>();
    if(!input.strictNegative){const actualOwned=owned;const wire:OwnedExecution={...actualOwned,describe:()=>actualOwned.describe(),fence:()=>actualOwned.fence(),drain:reason=>actualOwned.drain(reason),renewLease:seq=>actualOwned.renewLease(seq),onOutput:listener=>{forwarders.add(listener);return()=>forwarders.delete(listener);},endInput:()=>actualOwned.endInput(),writeInput:bytes=>{guard(wirePhase);if(record(JSON.parse(text(bytes))).method==='turn/interrupt')assertActiveCanary();return actualOwned.writeInput(bytes);}};
     const bootstrap=guard('BOOTSTRAP');
     transport=new CodexTransport(wire,{timeoutMs:Math.min(15000,timeout),initializationTimeoutMs:initializationAllowance(bootstrap.expiresAt),maxOutputBytes:intent.budget.outputBytes,...(clientName?{metadata:{cwd:intent.workspace,clientName,admissionDeadline:intent.expiresAt,now}}:{observeThreadSettings:true})});transport.onMessage(consume);transport.onFailure(()=>{failed=true;wake();});}
    // A single underlying listener charges raw bytes before either retention or parsing.
    // Install it only after the parser has registered, preserving early output.
    stopCapture=owned.onOutput(output=>{capture.write(output.data);if(output.stream==='stderr'){if(Buffer.byteLength(stderr)+output.data.length>16384)failure('STRICT_STDERR_LIMIT');stderr+=new TextDecoder('utf-8',{fatal:true}).decode(output.data);}for(const listener of forwarders)listener(output);});
    lease=setInterval(()=>{if(!drained&&!fenced){try{guard(wirePhase);void owned!.renewLease(++leaseSequence).catch(()=>{failed=true;wake();});}catch{failed=true;wake();}}},2000);lease.unref();return structuredClone(actual);},
   async initialize(){current();const bootstrap=guard('BOOTSTRAP');let timer:ReturnType<typeof setTimeout>|undefined;
    // A direct caller may wait after launch. Bound the pending initialization
    // again using the current admission, while later RPC timers stay unchanged.
    try{await Promise.race([transport!.initialize(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{failed=true;transport!.fence();reject(Error('INITIALIZATION_ADMISSION_TIMEOUT'));},initializationAllowance(bootstrap.expiresAt));})]);}finally{clearTimeout(timer);}
    const readStartup=async()=>{const accountVersion=startupAccountUpdates;const account=projectManagedAccount(await request('account/read',{refreshToken:false},'BOOTSTRAP'));const rawConfig=await request('config/read',{includeLayers:false,cwd:intent!.workspace},'BOOTSTRAP'),rawRequirements=await request('configRequirements/read',undefined,'BOOTSTRAP');return {account,rawConfig,rawRequirements,accountVersion};};
    let observation=await readStartup();if(observation.accountVersion!==startupAccountUpdates)observation=await readStartup();if(observation.accountVersion!==startupAccountUpdates)failure('MANAGED_STARTUP_UNSTABLE');
    const {account,rawConfig,rawRequirements}=observation,config=projectConfig(rawConfig),requirements=projectRequirements(rawRequirements);
    const controls=(intent!.action==='metadata'?checkMetadataControls:checkControls)(config,requirements,intent!.profile);if(account.state!=='authenticated'||!controls.ok)failure('MANAGED_STARTUP_MISMATCH');const raw=record(record(rawConfig).config);
    if(raw.model!==intent!.model||raw.model_reasoning_effort!==intent!.effort)failure('MODEL_EFFORT_UNOBSERVED');startupObserved=true;observationHash=digest({account,config,requirements});if(config.selectedPermissionsHash&&config.shellEnvironmentPolicyHash)policyObservation={configurationHash:fingerprint(config),requirementsHash:fingerprint(requirements),permissionsHash:config.selectedPermissionsHash,environmentHash:digest(options.env),shellEnvironmentPolicyHash:config.shellEnvironmentPolicyHash,account:'chatgpt',provider:'openai',observedAt:now()};
    if(preparationCoverage){if(!policyObservation)failure('STARTUP_COVERAGE_POLICY_UNOBSERVED');const {observedAt:_at,...observedPolicy}=policyObservation;if(fingerprint(observedPolicy)!==fingerprint(preparationCoverage.expectedPolicy))failure('STARTUP_COVERAGE_POLICY_CHANGED');}
    const managedConflict=policyObservation&&checkControls(config,requirements,intent!.profile).ok?createManagedPolicyConflictProjection({intentHash:fingerprint(intent!),rawConfig,rawRequirements}):undefined;
    return {observationHash,...(policyObservation?{policy:policyObservation}:{}),...(managedConflict?{managedConflict}:{}),account:'chatgpt',provider:'openai',model:raw.model as string,effort:raw.model_reasoning_effort as string};},
   async startThread(input){current();if(input.workspace!==intent!.workspace||input.authMode!=='managed-chatgpt'||!observationHash)failure('THREAD_SCOPE_CHANGED');const response=record(await request('thread/start',{model:intent!.model,modelProvider:'openai',cwd:intent!.workspace,approvalPolicy:'on-request',approvalsReviewer:'user',ephemeral:false},'PRE_THREAD'));
    const id=record(response.thread).id;if(typeof id!=='string'||!id)failure('THREAD_SETTINGS_MISMATCH');threadId=id as string;
    const s=projectCodexThreadSettings(response,{profile:intent!.profile,model:intent!.model!,effort:intent!.effort!,cwd:intent!.workspace},'response');const queued=settings.get(threadId);settings.clear();
    if(!codexThreadSettingsSafe(s,expectedNetwork)||queued&&fingerprint(queued)!==fingerprint(s))failure('THREAD_SETTINGS_MISMATCH');settingsHash=fingerprint(s);observationHash=digest({initialized:observationHash,settings:s});return {threadId,observationHash,...(policyObservation?{policy:policyObservation}:{}),account:'chatgpt',provider:'openai',model:intent!.model!,effort:intent!.effort!};},
   async startTurn(input){if(input.threadId!==threadId||input.model!==intent?.model||input.effort!==intent?.effort||input.authMode!=='managed-chatgpt')failure('TURN_SCOPE_CHANGED');
    if(input.operation==='injected-recovery'){const expected=input.injectedResponse==='authentication-required'?'controller.auth_stop':input.injectedResponse==='quota-exceeded'?'controller.quota_stop':null;if(!expected||intent!.dispatchAuthorization.kind!=='qualification'||intent!.dispatchAuthorization.probeId!==expected)failure('FAULT_SCOPE_REFUSED');guard('TURN');turnId='injected-'+intent!.owner.actionId;
     consume({method:'error',params:{threadId,turnId,error:{codexErrorInfo:input.injectedResponse==='authentication-required'?'unauthorized':'usageLimitExceeded'}}});if(!recoveryResponse)failure('INJECTED_ERROR_UNCLASSIFIED');return {threadId,turnId,model:intent!.model,effort:intent!.effort,events:[],response:recoveryResponse};}
    if(input.operation==='allowed-edit'&&(input.edit?.path!=='qualification-edit.txt'||input.edit.postimage!=='QUALIFIED_EDIT\r\n'))failure('EDIT_SCOPE_CHANGED');const result=await commandResult(activity(input.operation==='allowed-edit'?'allowed_edit':input.operation==='lifecycle'?'lifecycle':'subscription'));if(!result.result||result.result.exitCode!==0)failure('SESSION_COMMAND_FAILED');events.splice(0,events.length,...result.events);return {threadId,turnId:result.turnId,model:intent!.model,effort:intent!.effort,events:[...events],response:'completed'};},
   async executeFixedCommand(command){const result=await commandResult(command);if(!result.result)failure('TOOL_EXECUTION_UNPROVEN');return result.result!;},
   async observeInactivity(){if(!armedAt||!drained)failure('INACTIVITY_OBSERVATION_ORDER');const values=[];for(const path of preparedMonitors){const entry=options.fixture.canaries.find(entry=>entry.path===path);if(!entry)failure('CANARY_REGISTRATION_UNAVAILABLE');for(const registration of entry.registrations)await pinned(registration);const bytes=text(await read(entry.sentinel));const lines=bytes.split('\n');if(lines[0]!=='ARMED'||lines.filter(line=>line===monitorMarker).length!==1||lines.slice(1).some(line=>line!==''&&line!=='ACTIVATED'&&line!==monitorMarker))failure('CANARY_CONTENT_INVALID');values.push({path:entry.path,armedAt,observedThrough:now(),activationCount:lines.filter(line=>line==='ACTIVATED').length});}return values;},
   async snapshotProtected(){const output:Record<string,string>={};for(const [name,path]of Object.entries(options.fixture.protectedFiles))output[name]=sha(await read(path));return output;},
   async readEdit(input){if(input.path!=='qualification-edit.txt')failure('EDIT_PATH_REFUSED');return text(await read(win32.join(options.fixture.root,'workspace','qualification-edit.txt')));},
   async armCancellation(input){if(ownershipHash(input.ownership)!==ownershipHash(current().identity))failure('OWNERSHIP_CHANGED');
    if(input.kind==='pending_dispatch_cancel'){if(pendingBinding)failure('PENDING_ARM_REPLAY');pendingBinding=pendingDescriptor(input.pendingActionId);}
    const before={at:now(),value:text(await read(options.fixture.heartbeat))};await commandResult(activity(input.kind==='detached_descendant_cancel'?'detached':'foreground'),false);await until(()=>messages.some(message=>message.method==='item/started'&&record(message.params).turnId===turnId));let after=before;
    for(let i=0;i<8&&(after.value===before.value||!after.value);i++){await sleep(100);after={at:now(),value:text(await read(options.fixture.heartbeat))};}if(!before.value||!after.value||before.value===after.value||after.at<=before.at)failure('HEARTBEAT_ACTIVITY_UNPROVEN');const heartbeatActivity={samples:[before,after]};
    if(input.kind==='pending_dispatch_cancel'){const enqueued=options.pendingDispatch!.queue.enqueue(pendingBinding!,()=>{guard('TURN');assertActiveCanary();});if(!enqueued.ok)failure('PENDING_QUEUE_ENQUEUE_REFUSED');const ownership=await receipt();assertActiveCanary();return {ownership,ready:true,pending:pendingState('pending'),heartbeatActivity};}
    let descendant;if(input.kind==='detached_descendant_cancel'){const d=await observed();const pid=Number(after.value.trim().split('\n').at(-1)!.split(':')[0]);descendant=d.descendants.find(value=>value.pid===pid&&value.jobIdentity===d.innerJobIdentity);if(!descendant)failure('DESCENDANT_NOT_OWNED');}const ownership=await receipt();assertActiveCanary();return {ownership,ready:true,heartbeatActivity,...(descendant?{descendant}:{})};},
   async trigger(input){if(ownershipHash(input.ownership)!==ownershipHash(current().identity))failure('OWNERSHIP_CHANGED');
    if(input.kind==='pending_dispatch_cancel'){if(!pendingBinding||pendingBinding.actionId!==input.pendingActionId||!options.pendingDispatch)failure('PENDING_SCOPE_REFUSED');assertActiveCanary();const cancelled=options.pendingDispatch.queue.cancel(pendingBinding.owner,pendingBinding.actionId,()=>{guard('TURN');assertActiveCanary();});if(!cancelled.ok)failure('PENDING_QUEUE_CANCEL_REFUSED');cancelledActive=true;return {ownership:await receipt(),triggered:true,pendingDispatched:false,pending:pendingState('cancelled-before-dispatch')};}
    if(input.kind==='helper_death'||input.kind==='controller_death'){const description=await observed();const kind=input.kind==='helper_death'?'helper':'controller';effectGate('TURN');guard('TURN');assertActiveCanary();deathTrigger=await observer().triggerDeath({kind,identity:description[kind]});if(!deathTrigger.targetExited)failure('DEATH_TARGET_NOT_EXITED');cancelledActive=true;return {ownership:structuredClone(current().identity),triggered:true,pendingDispatched:false};}
    await request('turn/interrupt',{threadId,turnId},'TURN');cancelledActive=true;return {ownership:await receipt(),triggered:true,pendingDispatched:false,...(input.descendant?{descendant:structuredClone(input.descendant)}:{})};},
   async fence(){effectGate('CLEANUP');const state=current();fenced=true;clearInterval(lease);transport?.fence();
    if(strictPositive){effectGate('CLEANUP');const ended=await state.owned.endInput();if(!ended.ok)failure('STRICT_EOF_REFUSED');const terminal=await naturalStrictExit();if(terminal.rootExitCode!==0)failure('STRICT_POSITIVE_EXIT_UNPROVEN');}
    if(strictNatural)return {ownership:structuredClone(state.identity),fenced:true};
    // An observed retained-handle death ends the actual writer/helper; local
    // transport fencing blocks further writes. This deliberately claims no ACK.
    if(!deathTrigger?.targetExited)await state.owned.fence();return {ownership:structuredClone(state.identity),fenced:true};},
   async drain(){effectGate('CLEANUP');const state=current();try{let drain:unknown;
    if(strictNatural)drain=strictNatural;else if(!deathTrigger?.targetExited)drain=await state.owned.drain('qualification-session-complete');
    if(options.observation&&!strictNatural){await observed();if(!deathTrigger?.targetExited){effectGate('CLEANUP');await observer().controller.end();}effectGate('CLEANUP');const terminal=QualificationTerminalSchema.parse(await observer().observeTerminal());drain=terminal;
     if(!terminal.processMeterError)for(const kind of ['root','helper'] as const){const actual=terminal.processMeters.filter(value=>value.kind===kind);if(actual.length===1&&actual[0]!.exitedAt!==null&&!reportedMeters.has(kind)){const meter=actual[0]!;capture.processCompleted?.({kind,identity:meter.identity,activeMs:meter.activeMs});reportedMeters.add(kind);}}}
    // Metadata remains observed through the last owned output byte. Finalize
    // only after complete drainage, before stop() deliberately closes transport.
    if(transport&&state.intent.action==='metadata'){
     const terminal=options.observation?QualificationTerminalSchema.parse(drain):WindowsDrainEvidenceSchema.parse(drain);
     if(!terminal.outputComplete||'unresolvedOutputStreams' in terminal&&terminal.unresolvedOutputStreams.length)failure('METADATA_OUTPUT_INCOMPLETE');
     transport.finish();const protocol=transport.metadataEvidence();
     if(failed||protocol.boundaryFailed||protocol.framesAdmitted!==5)failure('METADATA_PROTOCOL_FAILED');
    }
    drained=true;return {ownership:structuredClone(state.identity),drain};}finally{clearInterval(lease);transport?.stop();stopCapture();}},
   async observeHeartbeat(input){if(!drained||!options.observation)failure('UNSUPPORTED_HEARTBEAT_OBSERVER');const first={at:now(),value:text(await read(options.fixture.heartbeat))};await sleep(input.minimumWindowMs);const last={at:now(),value:text(await read(options.fixture.heartbeat))};effectGate('CLEANUP');const terminal=QualificationTerminalSchema.parse(await observer().observeTerminal());const actual=terminal.unrelated;
    if(!actual||actual.identity.pid!==input.unrelated.pid||actual.identity.creationIdentity!==input.unrelated.creationIdentity||actual.name!==input.unrelated.name||!actual.outsideHierarchy||terminal.observedAt<last.at)failure('UNRELATED_IDENTITY_CHANGED');return {ownership:structuredClone(current().identity),samples:[first,last],unrelated:{...input.unrelated,alive:actual.alive}};},
   async reconcileBrokers(){const state=current();effectGate('CLEANUP');const registry=options.ownedBrokerRegistry?.(freeze(structuredClone(state.intent)));
    if(!registry)failure('UNSUPPORTED_BROKER_INVENTORY');if(registry.schemaVersion!==1||registry.scope!=='campaign-owned-controlled-services'||registry.source!=='campaign-owned-resource-registry'||registry.targetHash!==startupTargetHash(state.intent)||registry.controlHash!==state.intent.controlHash||Object.entries(state.intent.owner).some(([key,value])=>registry.owner[key as keyof ExecutionOwner]!==value)||!Array.isArray(registry.registeredActionIds)||registry.registeredActionIds.some(id=>typeof id!=='string'||!id)||new Set(registry.registeredActionIds).size!==registry.registeredActionIds.length)failure('BROKER_REGISTRY_BINDING_CHANGED');
    const registryHash=fingerprint(registry),inventoryScope=registry.scope;
    if(registry.registeredActionIds.length===0&&!options.broker)return {ownership:structuredClone(state.identity),inventoryComplete:true,active:[],unresolved:[],inventoryScope,registryHash};
    const service=options.broker;if(!service||registry.registeredActionIds.length!==1||registry.registeredActionIds[0]!==service.ownership.actionId||service.ownership.runId!==state.intent.owner.runId||service.ownership.generation!==state.intent.owner.generation)failure('BROKER_REGISTRY_BINDING_CHANGED');
    const actual=await service.client.describe();if(ownershipHash(actual)!==ownershipHash(service.ownership))failure('BROKER_OWNERSHIP_CHANGED');
    const inventory=await service.client.inventory('reconcile',()=>effectGate('CLEANUP'));
    return {ownership:structuredClone(current().identity),inventoryComplete:!inventory.failed,active:[...inventory.children],unresolved:[...inventory.pending],inventoryScope,registryHash};},
   async checkpoint(input){if(!drained||!input.recoveryRequiresApproval||input.retry||input.providerFallback||ownershipHash(input.ownership)!==ownershipHash(current().identity))failure('CHECKPOINT_BEFORE_DRAIN');const path=options.fixture.checkpoint;const data={schemaVersion:1,owner:intent!.owner,reason:input.reason,retry:false,providerFallback:false,recoveryRequiresApproval:true};await writeFixture(path,Buffer.from(JSON.stringify(data)),'wx','CLEANUP');if(fingerprint(JSON.parse(text(await read(path))))!==fingerprint(data))failure('CHECKPOINT_PERSISTENCE_FAILED');return {saved:true,recoveryRequiresApproval:true};},
   async strictOutcome(){const state=current();if(state.intent.dispatchAuthorization.kind!=='qualification'||state.intent.dispatchAuthorization.probeId!=='auxiliary.strict-negative'||rpcCount!==0)failure('STRICT_NEGATIVE_SCOPE_REQUIRED');const status=await naturalStrictExit();return {exitCode:status.rootExitCode!,stderr,rpcCount};},
  };return process;
 }};
}
