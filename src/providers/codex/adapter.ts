import {codexVersionObservation} from '../../runtime/compatibility.ts';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { z } from 'zod';
import { HashSchema, IdSchema, PathSchema, TextSchema, type Result } from '../../contracts/common.ts';
import { ExecutionAuthorizationSchema, ExecutionOwnerSchema, LaunchSpecSchema, WindowsOwnershipReceiptSchema, type OwnershipReceipt, type ExecutionOwner, type LaunchSpec, type OwnedExecution, type Supervisor, type DrainEvidence } from '../../contracts/execution.ts';
import { assessPhaseAdmission, MANAGED_ENVIRONMENT_KEYS, ownershipHash, StartupIntentSchema, type PhaseAdmission, type StartupIntent } from '../../qualification/codex-startup-authority.ts';
import { projectManagedAccount } from './startup-metadata.ts';
import { BoundaryProfileSchema, compileCommandBoundary } from '../../runtime/command-boundary.ts';
import type { ArtifactRef, ExecutionInventory, InterruptReceipt, ProviderAdapter, ProviderEvent, ProviderResume, ProviderSession, ProviderStart } from '../provider.ts';
import { checkControls, codexRemoteControlState, denyServerRequest, projectConfig, projectRequirements, record, subscriptionSourceAssessment, isInformationalCodexNotification, type SubscriptionSourceAssessment, type EffectivePolicyAssessment, type SafeConfig, type SafeRequirements } from './policy.ts';
import { CodexTransport, CodexRpcError, CodexTransportError, type SafeCodexTransportFailure, type Incoming, type SafeCodexRpcFailure } from './transport.ts';
import { buildCodexLaunchConfig, CODEX_CONFIG_SCHEMA, restrictedCodexOverrides, type CodexConfigValue } from './launch-config.ts';
import type { ModelListResponse } from './protocol/0.162.1/typescript/v2/ModelListResponse.js';
import type { SandboxPolicy } from './protocol/0.162.1/typescript/v2/SandboxPolicy.js';
import type { TurnError } from './protocol/0.162.1/typescript/v2/TurnError.js';
import type { RateLimitReachedType } from './protocol/0.162.1/typescript/v2/RateLimitReachedType.js';

const PROFILE='ouroboros_worker';
const APPROVAL_POLICY='on-request';
const exhaustedQuotaStates:readonly RateLimitReachedType[]=['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached'];
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const artifactSchema=z.strictObject({id:IdSchema,sha256:HashSchema});
const boundarySchema=BoundaryProfileSchema.omit({qualification:true});
const startSchema=z.strictObject({owner:ExecutionOwnerSchema,actionId:IdSchema,workspaceRoot:TextSchema,
  promptRef:artifactSchema,contextRefs:z.array(artifactSchema).max(32),model:TextSchema,effort:TextSchema,
  boundary:BoundaryProfileSchema.or(boundarySchema),authorization:ExecutionAuthorizationSchema,mode:z.enum(['IMPLEMENT','REFLECT'])});
const reconciliationSchema=z.strictObject({priorOwner:ExecutionOwnerSchema,sessionId:TextSchema,evidenceIds:z.array(IdSchema).min(1),
  priorExecutionDrained:z.literal(true),outcome:z.literal('safe_to_resume')});
const resumeSchema=startSchema.extend({sessionId:TextSchema,reconciliation:reconciliationSchema});
type RuntimeIdentity={version:string;sha256:string;executable:string;profile:typeof PROFILE;policyHash:string};
type AuthorityBase={input:Readonly<ProviderStart>;runtime:Readonly<RuntimeIdentity>};
/** Controllers validate existing receipts or an independently approved bounded probe.
 * No callback may waive adapter-observed unsafe controls or mint qualification.
 * Startup permission describes approved ordinary effects and target-specific supported
 * controls or explicit disposable qualification containment before spawning.
 * A probe's authorization covers only its predeclared fixture operations and budget.
 * The supervisor's authorize(spec) remains separately mandatory and current. */
export type DispatchAuthority = AuthorityBase & (
  | {kind:'qualified';qualificationRef:string}
  | {kind:'qualification';requestId:string;probeId:string;fixtureRoots:readonly string[]}
  | {kind:'user-task';authorizationId:string;taskHash:string}
);
type Decision={authorized:boolean;authorizationRef:string;admission?:PhaseAdmission};
export type CodexStartupStage='OWNERSHIP'|'INITIALIZE'|'ACCOUNT_READ'|'ACCOUNT_CHECK'|'CONFIG_READ'|'REQUIREMENTS_READ'|'CONTROLS'|'PRE_THREAD_AUTH'|'OWNERSHIP_PRE_THREAD'|'THREAD_START'|'THREAD_RESUME'|'THREAD_METADATA'|'THREAD_SETTINGS'|'TURN_AUTH'|'MODEL_CATALOG'|'MODEL_SELECTION'|'OWNERSHIP_PRE_TURN'|'TURN_START'|'TURN_METADATA';
export type SafeCodexProtocolDiagnostic={kind:'runtime_observation';stage:'INITIALIZE';version:string}|{kind:'informational_notification';stage:CodexStartupStage;count:number}|{kind:'startup_warning'|'startup_account_update';stage:CodexStartupStage;count:number}|{kind:'remote_control_status';stage:CodexStartupStage;state:'disabled'|'unsafe'}|{kind:'subscription_policy';stage:'CONTROLS';assessment:SubscriptionSourceAssessment}|{kind:'effective_policy';stage:'PRE_THREAD_AUTH'|'CONTROLS';assessment:EffectivePolicyAssessment}|{kind:'thread_policy';stage:'THREAD_SETTINGS';profile:boolean;parent:boolean;model:boolean;effort:boolean;cwd:boolean;approval:boolean;sandbox:boolean}|{kind:'startup_failure';stage:CodexStartupStage;code:string;startupWarnings:number;rpc?:SafeCodexRpcFailure;transport?:SafeCodexTransportFailure};
export type CodexAdapterOptions={
  supervisor:Supervisor;executable:string;binaryHash:string;runtimeVersion?:string;env:Record<string,string>;
  /** Predeclared non-secret identifiers only; startup authority verifies completeness. */
  mcpServerIds?:string[];
  shellEnvironmentPolicy?:CodexConfigValue;
  sqliteHome?:string;
  onDiagnostic?:(fact:SafeCodexProtocolDiagnostic)=>void;
  loadArtifact:(ref:Readonly<ArtifactRef>)=>Promise<string>;
  authorizeStartup:(request:DispatchAuthority & {launch:Readonly<LaunchSpec>;intent:Readonly<StartupIntent>})=>Promise<Decision>;
  /** Separately validates integration activation before the thread/resume boundary. */
  authorizePreThread?:(request:DispatchAuthority & {intent:Readonly<StartupIntent>;ownership:OwnershipReceipt;account:ReturnType<typeof projectManagedAccount>;config:SafeConfig;requirements:SafeRequirements;observationHash:string})=>Promise<Decision>;
  /** Exact reviewed identities for modules/OS/control assessment not derivable from argv. */
  startupContext?:{node:StartupIntent['node'];helper:StartupIntent['helper'];controllerHash:string;protocolHash:string;adapterHash:string;verifierHash:string;osCapabilitiesHash:string;configHash:string;controlHash:string;budget:StartupIntent['budget']};
  authorizeObserved:(request:DispatchAuthority & {startupAuthorizationRef:string;config:SafeConfig;requirements:SafeRequirements;
    intent:Readonly<StartupIntent>;ownership:OwnershipReceipt;account:ReturnType<typeof projectManagedAccount>;settings:SafeSettings;observedFingerprint:string})=>Promise<Decision>;
  requestTimeoutMs?:number;
};
export type SafeSettings={threadId:string;expectedProfile:boolean;noParentProfile:boolean;expectedProvider:boolean;
  expectedModel:boolean;expectedEffort:boolean;expectedCwd:boolean;expectedApproval:boolean;expectedReviewer:boolean;sandboxPolicy:SandboxPolicyEvidence};
export type SandboxPolicyEvidence={coverage:'present';policy:SandboxPolicy}|{coverage:'missing'|'invalid'};
type EventBody<E> = E extends unknown ? Omit<E,keyof ExecutionOwner|'sessionId'|'turnId'> : never;
const reportedSandboxSchema:z.ZodType<SandboxPolicy>=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('dangerFullAccess')}),
  z.strictObject({type:z.literal('readOnly'),networkAccess:z.boolean()}),
  z.strictObject({type:z.literal('externalSandbox'),networkAccess:z.enum(['restricted','enabled'])}),
  z.strictObject({type:z.literal('workspaceWrite'),writableRoots:z.array(PathSchema.refine(path=>absolute(path)&&Buffer.byteLength(path)<=4096)).max(64)
    .refine(roots=>roots.reduce((bytes,root)=>bytes+Buffer.byteLength(root),0)<=16384),networkAccess:z.boolean(),excludeTmpdirEnvVar:z.boolean(),excludeSlashTmp:z.boolean()}),
]);
/** This is bounded reported legacy evidence, not an interpretation of named-profile
 * enforcement. Task7/controller must qualify the correspondence and required coverage. */
function projectSandboxPolicy(value:unknown):SandboxPolicyEvidence {
  if(value===undefined||value===null)return {coverage:'missing'};
  const parsed=reportedSandboxSchema.safeParse(value);
  return parsed.success?{coverage:'present',policy:parsed.data}:{coverage:'invalid'};
}
type SettingsExpectation={profile:string;model:string;effort:string;cwd:string};
/** Initial settings come from ThreadStart/ResumeResponse. settings/updated is
 * change-only. Keep the response and notification wire names distinct. */
export function projectCodexThreadSettings(value:unknown,expected:SettingsExpectation,source:'response'|'notification'):SafeSettings{
  const p=record(value),s=source==='response'?p:record(p.threadSettings),active=record(s.activePermissionProfile);
  const knownProfile=Object.keys(active).every(key=>key==='id'||key==='extends');
  return {threadId:source==='response'?String(record(p.thread).id??''):typeof p.threadId==='string'?p.threadId:'',expectedProfile:knownProfile&&active.id===expected.profile,noParentProfile:active.extends===null,expectedProvider:s.modelProvider==='openai',expectedModel:s.model===expected.model,expectedEffort:(source==='response'?s.reasoningEffort:s.effort)===expected.effort,expectedCwd:s.cwd===expected.cwd,expectedApproval:s.approvalPolicy===APPROVAL_POLICY,expectedReviewer:s.approvalsReviewer==='user',sandboxPolicy:projectSandboxPolicy(source==='response'?s.sandbox:s.sandboxPolicy)};
}
export function codexThreadSettingsSafe(value:SafeSettings,expectedNetwork=false):boolean{
  return value.expectedProfile&&value.noParentProfile&&value.expectedProvider&&value.expectedModel&&value.expectedEffort&&value.expectedCwd&&value.expectedApproval&&value.expectedReviewer&&value.sandboxPolicy.coverage==='present'&&value.sandboxPolicy.policy.type==='workspaceWrite'&&value.sandboxPolicy.policy.networkAccess===expectedNetwork;
}
function classifyTurnError(error:unknown):Extract<EventBody<ProviderEvent>,{type:'auth_error'|'quota_error'|'diagnostic'}> {
  const discriminant=record(error).codexErrorInfo as TurnError['codexErrorInfo'];
  switch(discriminant){
    case 'unauthorized':return {type:'auth_error',code:'PROVIDER_UNAUTHORIZED'};
    case 'usageLimitExceeded':return {type:'quota_error',code:'PROVIDER_USAGE_LIMIT_EXCEEDED'};
    case 'rateLimitExceeded':return {type:'quota_error',code:'PROVIDER_RATE_LIMIT_EXCEEDED'};
    case 'sessionBudgetExceeded':return {type:'quota_error',code:'PROVIDER_SESSION_BUDGET_EXCEEDED'};
    default:return {type:'diagnostic',code:'PROVIDER_TURN_ERROR'};
  }
}
function immutable<T>(value:T):Readonly<T>{if(value && typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}
function failure<T>(code:string,message:string):Result<T>{return {ok:false,error:{code,message,evidenceIds:[]}};}
function sameOwner(a:ExecutionOwner,b:ExecutionOwner){return a.runId===b.runId&&a.generation===b.generation&&a.actionId===b.actionId&&a.role===b.role;}
function contained(value:string,root:string){const relative=win32.relative(root,value);return relative===''||relative!=='..'&&!relative.startsWith('..\\')&&!win32.isAbsolute(relative);}
function absolute(value:string){return win32.isAbsolute(value)&&!value.split(/[\\/]/).some(v=>v==='..'||v==='.')&&!value.startsWith('\\\\');}
async function bounded<T>(operation:()=>Promise<T>,deadline:number):Promise<T>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([operation(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Controller operation deadline expired')),Math.max(1,Math.min(15000,deadline-Date.now())));})]);}
  finally{clearTimeout(timer);}
}
function buildLaunch(input:ProviderStart,options:CodexAdapterOptions):Result<LaunchSpec>{
  const profile=input.boundary;
  if(input.mode==='REFLECT')return failure('CAPABILITY_UNAVAILABLE','REFLECT has no separately qualified supported no-tools control');
  if(!sameOwner(input.owner,profile)||input.actionId!==input.owner.actionId||profile.platform!=='windows'||
      !HashSchema.safeParse(options.binaryHash).success||profile.verifier.sha256!==options.binaryHash||options.runtimeVersion!==undefined&&profile.verifier.version!==options.runtimeVersion||
      profile.verifier.executable!==options.executable||!absolute(options.executable)||!absolute(input.workspaceRoot)||
      !profile.readRoots.some(root=>contained(input.workspaceRoot,root))||!profile.writeRoots.some(root=>contained(input.workspaceRoot,root)))
    return failure('CAPABILITY_UNAVAILABLE','Owner, workspace or exact native runtime boundary mismatch');
  const paths=[...profile.readRoots,...profile.writeRoots,...profile.deniedSensitiveRoots];
  if(paths.some(path=>!absolute(path))||profile.deniedSensitiveRoots.some(root=>contained(input.workspaceRoot,root)||contained(options.executable,root))||
      profile.readRoots.some(root=>profile.deniedSensitiveRoots.some(denied=>contained(root,denied)||contained(denied,root)))||
      profile.writeRoots.some(root=>!profile.readRoots.some(read=>contained(root,read))))return failure('CAPABILITY_UNAVAILABLE','Unsupported or overlapping native scope');
  if(Object.keys(options.env).some(key=>!(MANAGED_ENVIRONMENT_KEYS as readonly string[]).includes(key)))
    return failure('SUBSCRIPTION_SOURCE_UNSAFE','Disallowed API/provider or startup environment key is present');
  let policyHash:string;
  if(input.authorization.kind==='qualified'){
    if(!profile.qualification||input.authorization.qualificationRef!==profile.qualification.qualificationRef)return failure('EXECUTION_NOT_AUTHORIZED','Current qualified boundary receipt required');
    const validated=compileCommandBoundary(profile.registry[0],profile as z.infer<typeof BoundaryProfileSchema>);
    if(!validated.ok)return validated;policyHash=validated.value.boundaryHash;
  }else{
    if(input.authorization.kind==='qualification'){
    const fixtureRoots=input.authorization.fixtureRoots;
    if(!fixtureRoots.every(absolute)||!fixtureRoots.some(root=>contained(input.workspaceRoot,root))||
        profile.readRoots.some(root=>!fixtureRoots.some(fixture=>contained(root,fixture)))||
        profile.writeRoots.some(root=>!fixtureRoots.some(fixture=>contained(root,fixture))))
      return failure('EXECUTION_NOT_AUTHORIZED','Qualification probe policy exceeds declared disposable fixtures');
    }
    const {qualification:_qualification,runId:_runId,generation:_generation,actionId:_actionId,role:_role,leaseTtlMs:_lease,deadline:_deadline,...policy}=profile;
    policyHash=digest(policy);
  }
  if(profile.network.allowedDomains.length && !profile.qualification?.networkProxy)return failure('CAPABILITY_UNAVAILABLE','Network proxy enforcement is not qualified');
  const filesystem:Record<string,string>={':minimal':'read'};
  for(const root of profile.readRoots)filesystem[root]='read';for(const root of profile.writeRoots)filesystem[root]='write';for(const root of profile.deniedSensitiveRoots)filesystem[root]='deny';
  const allDomains=[...profile.network.allowedDomains,...profile.network.deniedDomains];
  if(new Set(allDomains).size!==allDomains.length)return failure('CAPABILITY_UNAVAILABLE','Duplicate or conflicting network domain controls');
  const domains=Object.fromEntries([...profile.network.allowedDomains.map(domain=>[domain,'allow']),...profile.network.deniedDomains.map(domain=>[domain,'deny'])]);
  const network={enabled:profile.network.allowedDomains.length>0,allow_local_binding:false,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains};
  const launchConfig=buildCodexLaunchConfig({entryPoint:'worker',schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name:PROFILE},
    overrides:restrictedCodexOverrides({profileName:PROFILE,profile:{filesystem,network},defaultPermissions:true,model:input.model,effort:input.effort,networkProxy:profile.network.allowedDomains.length>0,mcpServerIds:options.mcpServerIds,shellEnvironmentPolicy:options.shellEnvironmentPolicy,sqliteHome:options.sqliteHome})}});
  if(!launchConfig.ok)return launchConfig;
  const argv=launchConfig.value.argv;
  return {ok:true,value:LaunchSpecSchema.parse({...input.owner,executable:options.executable,argv,cwd:input.workspaceRoot,env:options.env,
    boundaryHash:policyHash,authorization:input.authorization,stdin:'pipe',leaseTtlMs:profile.leaseTtlMs,deadline:profile.deadline})};
}
class EventQueue implements AsyncIterable<ProviderEvent>{
  private values:ProviderEvent[]=[];private waiter:((value:IteratorResult<ProviderEvent>)=>void)|undefined;private ended=false;
  push(value:ProviderEvent):void{if(this.ended)return;if(this.waiter){const next=this.waiter;this.waiter=undefined;next({done:false,value});}
    else {if(this.values.length>=256)throw Error('Provider event budget exhausted');this.values.push(value);}}
  end():void{this.ended=true;this.waiter?.({done:true,value:undefined});this.waiter=undefined;}
  [Symbol.asyncIterator]():AsyncIterator<ProviderEvent>{return {next:async()=>{if(this.values.length)return {done:false,value:this.values.shift()!};
    if(this.ended)return {done:true,value:undefined};if(this.waiter)throw Error('Single event consumer required');return await new Promise(resolve=>{this.waiter=resolve;});}};}
}

export function createCodexAdapter(optionsInput:CodexAdapterOptions):ProviderAdapter {
  if(typeof optionsInput.authorizeStartup!=='function'||typeof optionsInput.authorizeObserved!=='function'||typeof optionsInput.loadArtifact!=='function')throw Error('External startup, observed authorization and artifact resolver required');
  const options={...optionsInput,startupContext:optionsInput.startupContext?immutable(structuredClone(optionsInput.startupContext)):undefined,shellEnvironmentPolicy:optionsInput.shellEnvironmentPolicy?immutable(structuredClone(optionsInput.shellEnvironmentPolicy)):undefined,env:immutable({...optionsInput.env}),mcpServerIds:Object.freeze([...(optionsInput.mcpServerIds??[])])} as CodexAdapterOptions;
  const timeout=options.requestTimeoutMs??5000;
  // In-memory duplicate suppression complements, and never replaces, durable
  // controller action ownership and the supervisor's current dispatch fence.
  const dispatched=new Set<string>();
  async function dispatch(raw:ProviderStart|ProviderResume,resume:boolean):Promise<Result<ProviderSession>>{
    const parsed=(resume?resumeSchema:startSchema).safeParse(raw);if(!parsed.success)return failure('INVALID_CONTRACT','Invalid provider dispatch or reconciliation contract');
    const input=immutable(parsed.data) as ProviderStart|ProviderResume;
    if(input.authorization.kind==='user-task'&&(resume||input.mode!=='IMPLEMENT'))return failure('CAPABILITY_UNAVAILABLE','User tasks currently support only a new implementation session');
    if(resume){const resumed=input as ProviderResume;if(resumed.reconciliation.sessionId!==resumed.sessionId||resumed.reconciliation.priorOwner.runId!==input.owner.runId||resumed.reconciliation.priorOwner.generation>=input.owner.generation)
      return failure('EXECUTION_NOT_AUTHORIZED','Resume requires prior generation drainage and exact persisted session reconciliation');}
    const compiled=buildLaunch(input,options);if(!compiled.ok)return compiled;
    const launch=immutable(compiled.value);const runtime=immutable<RuntimeIdentity>({version:options.runtimeVersion??input.boundary.verifier.version,sha256:options.binaryHash,executable:launch.executable,profile:PROFILE,policyHash:launch.boundaryHash});
    const issuedAt=Date.now();const ancestry:string[]=[];let parent=input.workspaceRoot;for(;;){ancestry.unshift(parent);const next=win32.dirname(parent);if(next===parent)break;parent=next;}
    const parsedIntent=StartupIntentSchema.safeParse({schemaVersion:2,phase:'PRE_PROCESS',requestId:input.authorization.kind==='qualification'?input.authorization.requestId:input.authorization.kind==='user-task'?input.authorization.authorizationId:input.actionId,owner:input.owner,
      workspace:input.workspaceRoot,configAncestry:ancestry,runtime:{path:launch.executable,sha256:options.binaryHash,version:options.runtimeVersion??input.boundary.verifier.version},...options.startupContext,
      environmentHash:digest(launch.env),argumentsHash:digest(launch.argv),boundaryHash:launch.boundaryHash,dispatchHash:digest(input),dispatchAuthorization:input.authorization,profile:PROFILE,sandbox:'mxc',environmentKeys:Object.keys(launch.env),issuedAt,expiresAt:Math.min(launch.deadline,issuedAt+(options.startupContext?.budget.activeMs??0)),authMode:'managed-chatgpt',action:resume?'worker-resume':'worker-start',model:input.model,effort:input.effort});
    if(!parsedIntent.success)return failure('EXECUTION_NOT_AUTHORIZED','Reviewed startup context required');
    const intent=immutable(parsedIntent.data);
    const dispatchKey=`${input.owner.runId}:${input.owner.generation}:${input.actionId}`;
    if(dispatched.has(dispatchKey))return failure('EXECUTION_NOT_AUTHORIZED','Action already dispatched or outcome unresolved');
    dispatched.add(dispatchKey);
    const authority:DispatchAuthority=immutable(input.authorization.kind==='user-task'?{kind:'user-task',input,runtime,authorizationId:input.authorization.authorizationId,taskHash:input.authorization.taskHash}:input.authorization.kind==='qualified'?{kind:'qualified',input,runtime,qualificationRef:input.authorization.qualificationRef}:
      {kind:'qualification',input,runtime,requestId:input.authorization.requestId,probeId:input.authorization.probeId,fixtureRoots:input.authorization.fixtureRoots});
    let startup:Decision;
    try {startup=await bounded(()=>options.authorizeStartup({...authority,launch,intent}),intent.expiresAt);if(startup.authorized!==true||typeof startup.authorizationRef!=='string'||!startup.authorizationRef||!assessPhaseAdmission(intent,startup.admission,Date.now(),'BOOTSTRAP').authorized)return failure('EXECUTION_NOT_AUTHORIZED','Startup boundary authorization denied');
      startup=immutable(structuredClone(startup));}
    catch{return failure('EXECUTION_NOT_AUTHORIZED','Startup boundary authorization unavailable');}
    if(launch.deadline<=Date.now())return failure('DEADLINE_EXPIRED','Dispatch deadline expired');
    // Validate immutable artifact bytes before launching or making any model request.
    let prompt='';
    try {for(const ref of [input.promptRef,...input.contextRefs]){const value=await bounded(()=>options.loadArtifact(ref),intent.expiresAt);if(typeof value!=='string'||createHash('sha256').update(value).digest('hex')!==ref.sha256)throw Error('Artifact mismatch');
      prompt+=(prompt?'\n\n':'')+value;if(Buffer.byteLength(prompt)>64*1024)throw Error('Prompt budget exhausted');}}
    catch{return failure('INVALID_ARTIFACT','Provider prompt/context bytes are unavailable, changed or oversized');}
    if(!assessPhaseAdmission(intent,startup.admission,Date.now(),'BOOTSTRAP').authorized)return failure('EXECUTION_NOT_AUTHORIZED','Startup permission expired before launch');
    // Bootstrap permission limits process creation. Once phase admission has
    // completed, the original task deadline governs the owned process lifetime.
    // The supervisor rechecks the creation cutoff after durable authorization.
    const effectiveLaunch=immutable({...launch,launchNotAfter:Math.min(launch.deadline,intent.expiresAt,startup.admission!.expiresAt)});
    const launched=await options.supervisor.launchOwned(effectiveLaunch);if(!launched.ok)return launched;
    const owned=launched.value;const transport=new CodexTransport(owned,{timeoutMs:timeout,maxOutputBytes:intent.budget.outputBytes,initializationTimeoutMs:Math.max(1,Math.min(input.authorization.kind==='user-task'?60000:30000,intent.expiresAt-Date.now())),observeThreadSettings:true});const events=new EventQueue();
    let sessionId='';let turnId='';let stopped=false;let halted=false;let closePromise:Promise<DrainEvidence>|undefined;let interruptPromise:Promise<InterruptReceipt>|undefined;
    let dispatchFailureCode='PROVIDER_DISPATCH_FAILED';
    let stage:CodexStartupStage='OWNERSHIP';let startupWarnings=0;let policyObserved=false;let transportFailure:unknown;let startupAccountUpdates=0;let accountObserved=false;
    const diagnose=(fact:SafeCodexProtocolDiagnostic)=>{try{options.onDiagnostic?.(fact);}catch{/* Diagnostic consumers cannot change permission. */}};
    let settings:SafeSettings|undefined;let observedFingerprint='';let currentSettingsHash='';
    const settingsByThread=new Map<string,SafeSettings>();const early:Incoming[]=[];const observed=new Map<string,ExecutionInventory['observed'][number]>();
    let leaseSequence=0;
    const close=():Promise<DrainEvidence>=>{
      if(closePromise)return closePromise;halted=true;stopped=true;clearInterval(leaseTimer);clearTimeout(deadlineTimer);
      closePromise=(async()=>{
        try {
          const cleanupDeadline=Date.now()+intent.budget.cleanupMs;
          try {await bounded(()=>owned.fence(),Math.min(cleanupDeadline,Date.now()+5000));}catch {if(sessionId)emit({type:'diagnostic',code:'FENCE_ACKNOWLEDGMENT_FAILED'});}
          // Only the actual supervisor receipt proves drainage. A lost fence ACK
          // remains diagnostic evidence and never skips the drainage attempt.
          return await bounded(()=>owned.drain('provider_close'),cleanupDeadline);
        } finally {transport.stop();events.end();}
      })();void closePromise.catch(()=>{});return closePromise;
    };
    const stopOnFailure=(error?:unknown)=>{if(stopped)return;if(error instanceof Error)transportFailure=error;halted=true;void close().catch(()=>{});};
    const leaseTimer=setInterval(()=>{if(!stopped)void owned.renewLease(++leaseSequence).catch(stopOnFailure);},Math.min(2000,Math.floor(launch.leaseTtlMs/2)||1));
    const deadlineTimer=setTimeout(stopOnFailure,Math.min(2147483647,Math.max(1,effectiveLaunch.deadline-Date.now())));
    const emit=(event:EventBody<ProviderEvent>)=>events.push({...input.owner,sessionId,turnId:turnId||null,...event} as ProviderEvent);
    const expectation={profile:PROFILE,model:input.model,effort:input.effort,cwd:input.workspaceRoot};
    const safeSettings=(params:unknown)=>projectCodexThreadSettings(params,expectation,'notification');
    let remoteControlUpdates=0;let informationalUpdates=0;
    function consume(message:Incoming):void{
      if(stopped)return;
      if(message.id!==undefined){const denial=denyServerRequest({id:message.id,method:message.method});void transport.send(denial.response).catch(stopOnFailure);
        dispatchFailureCode='UNSUPPORTED_SERVER_REQUEST';if(sessionId){emit({type:'approval',decision:'deny',method:'unsupported_or_denied'});emit({type:'diagnostic',code:dispatchFailureCode});}stopOnFailure();return;}
      const params=record(message.params);
      if(isInformationalCodexNotification(message.method,message.params)){if(++informationalUpdates>4096){dispatchFailureCode='PROVIDER_INFORMATIONAL_NOTIFICATION_LIMIT';stopOnFailure();}else diagnose({kind:'informational_notification',stage,count:informationalUpdates});return;}
      if(message.method==='remoteControl/status/changed'){
        const state=codexRemoteControlState(params);diagnose({kind:'remote_control_status',stage,state});
        if(state!=='disabled'||++remoteControlUpdates>32){dispatchFailureCode=state!=='disabled'?'REMOTE_CONTROL_NOT_DISABLED':'PROVIDER_REMOTE_CONTROL_UPDATE_LIMIT';if(sessionId)emit({type:'diagnostic',code:dispatchFailureCode});stopOnFailure();}
        return;
      }
      if(message.method==='thread/settings/updated'){
        const next=safeSettings(params);if(!next.threadId)return;
        if(!sessionId){if(settingsByThread.size>=16&&!settingsByThread.has(next.threadId))throw Error('Settings budget exhausted');settingsByThread.set(next.threadId,next);}
        else if(next.threadId===sessionId){settings=next;
          if(currentSettingsHash && digest(next)!==currentSettingsHash){dispatchFailureCode='AUTHORIZATION_INVALIDATED';emit({type:'diagnostic',code:dispatchFailureCode});stopOnFailure();}}
        return;
      }
      if(message.method==='account/updated'&&!accountObserved){
        if(++startupAccountUpdates>32){dispatchFailureCode='PROVIDER_STARTUP_ACCOUNT_UPDATE_LIMIT';stopOnFailure();return;}
        diagnose({kind:'startup_account_update',stage,count:startupAccountUpdates});return;
      }
      if(message.method==='account/updated'||message.method.startsWith('modelProvider/authRecovery')||message.method==='model/rerouted'){
        dispatchFailureCode=message.method==='account/updated'?'PROVIDER_ACCOUNT_INVALIDATED':message.method==='model/rerouted'?'PROVIDER_MODEL_REROUTED':'PROVIDER_AUTH_RECOVERY_REQUIRED';if(sessionId)emit({type:'auth_error',code:message.method==='account/updated'?'AUTHORIZATION_INVALIDATED':dispatchFailureCode});stopOnFailure();return;
      }
      if(message.method==='account/rateLimits/updated'){
        // Rolling updates are informational; nullable sparse fields do not mean
        // exhaustion. Only an explicit backend exhaustion signal stops the run.
        const limits=record(params.rateLimits);
        if(limits.spendControlReached===true||exhaustedQuotaStates.includes(limits.rateLimitReachedType as RateLimitReachedType)){
          dispatchFailureCode='PROVIDER_USAGE_LIMIT_EXCEEDED';if(sessionId)emit({type:'quota_error',code:dispatchFailureCode});stopOnFailure();
        }
        return;
      }
      if(message.method==='configWarning'&&!policyObserved){
        if(++startupWarnings>32){dispatchFailureCode='PROVIDER_STARTUP_WARNING_LIMIT';stopOnFailure();return;}
        diagnose({kind:'startup_warning',stage,count:startupWarnings});return;
      }
      if(message.method==='hook/started'||message.method.startsWith('mcpServer/')||message.method==='skills/changed'||message.method==='app/list/updated'||message.method==='configWarning'){
        dispatchFailureCode='TOOL_CONFIGURATION_INVALIDATED';if(sessionId)emit({type:'diagnostic',code:dispatchFailureCode});stopOnFailure();return;
      }
      if(!['turn/started','turn/completed','item/started','item/completed','item/commandExecution/terminalInteraction','error'].includes(message.method)){dispatchFailureCode='UNSUPPORTED_NOTIFICATION';if(sessionId)emit({type:'diagnostic',code:dispatchFailureCode});stopOnFailure();return;}
      if(!sessionId||!turnId){if(['turn/started','turn/completed','item/started','item/completed','error'].includes(message.method)){
        if(early.length>=32)throw Error('Early notification budget exhausted');early.push(message);}return;}
      const notificationTurn=typeof params.turnId==='string'?params.turnId:record(params.turn).id;
      if(params.threadId!==sessionId||notificationTurn!==turnId)return;
      switch(message.method){
        case 'turn/started':emit({type:'turn_started'});break;
        case 'turn/completed':{
          const turn=record(params.turn);
          if(turn.status!=='completed'){
            const classified=turn.status==='failed'?classifyTurnError(turn.error):{type:'diagnostic' as const,code:turn.status==='interrupted'?'PROVIDER_TURN_INTERRUPTED':'PROVIDER_TURN_STATUS_INVALID'};
            dispatchFailureCode=classified.code;emit(classified);emit({type:'turn_completed'});stopOnFailure();
          }else emit({type:'turn_completed'});
          break;
        }
        case 'item/started':case 'item/completed':{
          const item=record(params.item);if(item.type!=='commandExecution'&&item.type!=='fileChange'){
            if(!['agentMessage','userMessage','reasoning','plan'].includes(String(item.type))){dispatchFailureCode='UNEXPECTED_TOOL_SURFACE';emit({type:'diagnostic',code:dispatchFailureCode});stopOnFailure();}break;}
          if(typeof item.id!=='string')throw Error('Invalid tool item');const status=message.method==='item/started'?'started':'completed';
          if(observed.size>=256&&!observed.has('item:'+item.id))throw Error('Inventory budget exhausted');observed.set('item:'+item.id,{kind:'item',id:item.id,status});emit({type:'tool_execution',itemId:item.id,status});break;}
        case 'item/commandExecution/terminalInteraction':if(typeof params.processId==='string'){
          if(observed.size>=256&&!observed.has('terminal:'+params.processId))throw Error('Inventory budget exhausted');observed.set('terminal:'+params.processId,{kind:'terminal',id:params.processId,status:'observed'});}break;
        case 'error':{const classified=classifyTurnError(params.error);if(params.willRetry===true&&classified.type==='diagnostic'){emit({type:'diagnostic',code:'PROVIDER_STREAM_RETRYING'});break;}dispatchFailureCode=classified.code;emit(classified);stopOnFailure();break;}
      }
    }
    transport.onMessage(consume);transport.onFailure(stopOnFailure);
    const inventory=async():Promise<ExecutionInventory>=>({owner:input.owner,sessionId,turnId,complete:false,
      reason:'Pinned protocol provides observed events only; no complete runtime execution inventory RPC',capturedAt:Date.now(),ownership:await owned.describe(),observed:[...observed.values()].map(value=>({...value}))});
    try {
      const active=()=>{if(halted||Date.now()>=effectiveLaunch.deadline||!assessPhaseAdmission(intent,startup.admission,Date.now(),'BOOTSTRAP').authorized)throw Error('Dispatch invalidated or startup permission expired');};
      const describe=async()=>{active();const parsed=WindowsOwnershipReceiptSchema.safeParse(await bounded(()=>owned.describe(),intent.expiresAt));active();if(!parsed.success||parsed.data.pid===parsed.data.helperPid||!sameOwner(parsed.data,input.owner)||parsed.data.boundaryHash!==launch.boundaryHash||parsed.data.capturedAt<issuedAt||parsed.data.capturedAt>Date.now())throw Error('Owned process identity mismatch');return parsed.data;};
      if(halted)throw Error('Startup notification invalidated dispatch');
      const identity=immutable(await describe());
      stage='INITIALIZE';const initialized=await transport.initialize();diagnose({kind:'runtime_observation',stage,version:codexVersionObservation(initialized.userAgent)});active();
      const readStartup=async()=>{
        // Sample before sending: response + notification can be decoded in one
        // chunk before this await's continuation runs.
        const accountVersion=startupAccountUpdates;
        stage='ACCOUNT_READ';const account=immutable(projectManagedAccount(await transport.request('account/read',{refreshToken:false})));active();stage='ACCOUNT_CHECK';
        if(account.state!=='authenticated')throw Error('Subscription source unavailable');
        stage='CONFIG_READ';const config=immutable(projectConfig(await transport.request('config/read',{includeLayers:false,cwd:input.workspaceRoot})));active();
        stage='REQUIREMENTS_READ';const requirements=immutable(projectRequirements(await transport.request('configRequirements/read',undefined)));active();
        return {account,config,requirements,accountVersion};
      };
      // Initial routing notifications race account/read. A later update makes
      // the whole observation dirty; refresh all three once before admission.
      let observation=await readStartup();
      if(observation.accountVersion!==startupAccountUpdates)observation=await readStartup();
      if(observation.accountVersion!==startupAccountUpdates){dispatchFailureCode='PROVIDER_STARTUP_ACCOUNT_UNSTABLE';throw Error('Startup account observation did not stabilize');}
      accountObserved=true;const {account,config,requirements}=observation;
      stage='CONTROLS';diagnose({kind:'subscription_policy',stage,assessment:subscriptionSourceAssessment(config,requirements)});const controls=checkControls(config,requirements,PROFILE);if(!controls.ok){diagnose({kind:'startup_failure',stage,code:controls.error.code,startupWarnings});await close();return controls;}policyObserved=true;
      const observationHash=digest({account,config,requirements});
      stage='PRE_THREAD_AUTH';if(!options.authorizePreThread)throw Error('Pre-thread admission required');
      const preThread=immutable(structuredClone(await bounded(()=>options.authorizePreThread!({...authority,intent,ownership:identity,account,config,requirements,observationHash}),intent.expiresAt)));active();
      if(!preThread.authorized||!preThread.authorizationRef||!assessPhaseAdmission(intent,preThread.admission,Date.now(),'PRE_THREAD',identity,observationHash).authorized)throw Error('Pre-thread permission refused');
      stage='OWNERSHIP_PRE_THREAD';if(ownershipHash(await describe())!==ownershipHash(identity))throw Error('Owned process changed');active();
      if(!assessPhaseAdmission(intent,preThread.admission,Date.now(),'PRE_THREAD',identity,observationHash).authorized)throw Error('Pre-thread permission expired');
      stage=resume?'THREAD_RESUME':'THREAD_START';const response=resume?await transport.request('thread/resume',{threadId:(input as ProviderResume).sessionId,model:input.model,modelProvider:'openai',cwd:input.workspaceRoot,approvalPolicy:APPROVAL_POLICY,approvalsReviewer:'user',excludeTurns:true}):
        await transport.request('thread/start',{model:input.model,modelProvider:'openai',cwd:input.workspaceRoot,approvalPolicy:APPROVAL_POLICY,approvalsReviewer:'user',ephemeral:false});
      active();
      stage='THREAD_METADATA';const thread=record(response.thread);if(typeof thread.id!=='string'||resume&&thread.id!==(input as ProviderResume).sessionId||response.modelProvider!=='openai'||response.cwd!==input.workspaceRoot||response.model!==input.model||response.approvalPolicy!==APPROVAL_POLICY||response.approvalsReviewer!=='user')throw Error('Thread metadata mismatch');
      sessionId=thread.id;
      stage='THREAD_SETTINGS';settings=projectCodexThreadSettings(response,expectation,'response');const queued=settingsByThread.get(sessionId);settingsByThread.clear();
      const sandbox=settings.sandboxPolicy;
      const sandboxSafe=codexThreadSettingsSafe(settings,input.boundary.network.allowedDomains.length>0)&&sandbox.coverage==='present'&&sandbox.policy.type==='workspaceWrite'&&sandbox.policy.excludeTmpdirEnvVar&&sandbox.policy.excludeSlashTmp&&sandbox.policy.writableRoots.every(root=>input.boundary.writeRoots.some(allowed=>contained(root,allowed)));
      diagnose({kind:'thread_policy',stage,profile:settings.expectedProfile,parent:settings.noParentProfile,model:settings.expectedModel&&settings.expectedProvider,effort:settings.expectedEffort,cwd:settings.expectedCwd,approval:settings.expectedApproval&&settings.expectedReviewer,sandbox:sandboxSafe});
      if(!sandboxSafe||queued&&digest(queued)!==digest(settings))throw Error('Effective profile/settings mismatch');currentSettingsHash=digest(settings);
      observedFingerprint=digest({runtime,config,requirements,settings});
      const authorizedSettings=immutable(settings);
      stage='TURN_AUTH';const decision=immutable(structuredClone(await bounded(()=>options.authorizeObserved({...authority,intent,ownership:identity,account,startupAuthorizationRef:startup.authorizationRef,config,requirements,settings:authorizedSettings,observedFingerprint}),intent.expiresAt)));active();
      if(decision.authorized!==true||typeof decision.authorizationRef!=='string'||!decision.authorizationRef||halted||digest(settings)!==currentSettingsHash)throw Error('Observed dispatch authorization denied or stale');
      if(!assessPhaseAdmission(intent,decision.admission,Date.now(),'TURN',identity,observedFingerprint).authorized)throw Error('Turn permission refused');
      // Token-free auth and exact effective/control authorization precede catalog access.
      let cursor:string|null=null;let selected=false;const seen=new Set<string>();
      for(let page=0;page<64;page++){
        stage='MODEL_CATALOG';
        active();const catalog:ModelListResponse=await transport.request('model/list',{cursor,limit:100,includeHidden:false});active();
        if(!Array.isArray(catalog.data)||catalog.data.length>100||catalog.nextCursor!==null&&typeof catalog.nextCursor!=='string')throw Error('Malformed model catalog');
        for(const model of catalog.data){if(model.model===input.model&&!model.hidden&&Array.isArray(model.supportedReasoningEfforts)&&model.supportedReasoningEfforts.some(option=>option.reasoningEffort===input.effort))selected=true;}
        cursor=catalog.nextCursor;if(cursor===null)break;if(seen.has(cursor)||page===63)throw Error('Model pagination exceeded bounds');seen.add(cursor);
      }
      stage='MODEL_SELECTION';if(!selected||halted)throw Error('Selected model/effort unavailable or authorization invalidated');
      stage='OWNERSHIP_PRE_TURN';if(ownershipHash(await describe())!==ownershipHash(identity))throw Error('Owned process changed');active();
      if(!assessPhaseAdmission(intent,decision.admission,Date.now(),'TURN',identity,observedFingerprint).authorized||digest(settings)!==currentSettingsHash)throw Error('Turn permission expired or changed');
      stage='TURN_START';const turn=await transport.request('turn/start',{threadId:sessionId,input:[{type:'text',text:prompt,text_elements:[]}],model:input.model,effort:input.effort,cwd:input.workspaceRoot,approvalPolicy:APPROVAL_POLICY,approvalsReviewer:'user'});
      stage='TURN_METADATA';
      if(typeof turn.turn?.id!=='string'||halted)throw Error('Turn identity unavailable');turnId=turn.turn.id;for(const message of early.splice(0))consume(message);
      if(halted)throw Error('Early owned turn notification invalidated dispatch');
      return {ok:true,value:{sessionId,turnId,events,inspectExecution:inventory,close,
        interrupt(){if(interruptPromise)return interruptPromise;
          halted=true;interruptPromise=(async()=>{
            // halted fences new provider starts. OwnedExecution.fence closes stdin,
            // so retain the identity-bound pipe until this exact interrupt is sent.
            let acknowledged=false;let captured:ExecutionInventory;
            try {await transport.request('turn/interrupt',{threadId:sessionId,turnId});acknowledged=true;}catch{/* Missing acknowledgment cannot establish completion. */}
            try {captured=await inventory();}catch {await close();throw Error('Inventory observation failed; drainage attempted');}
            const drain=await close();return {owner:input.owner,sessionId,turnId,acknowledged,inventory:captured,drain};
          })();void interruptPromise.catch(()=>{});return interruptPromise;}}};
    }catch(error){const observed=error instanceof CodexRpcError?error:transportFailure instanceof CodexRpcError?transportFailure:undefined;
      const code=dispatchFailureCode==='PROVIDER_DISPATCH_FAILED'?`PROVIDER_${stage}_FAILED`:dispatchFailureCode;
      diagnose({kind:'startup_failure',stage,code,startupWarnings,...(observed?{rpc:observed.fact}:{}),...(error instanceof CodexTransportError?{transport:error.fact}:transportFailure instanceof CodexTransportError?{transport:transportFailure.fact}:{})});
      await close();return failure(code,'Codex protocol, subscription, authorization or configuration precondition failed');}
  }
  return {inspect:async()=>({provider:'codex',runtimeVersion:options.runtimeVersion??'unobserved',extraUsage:'unknown',capabilities:{
    execution:{status:'UNQUALIFIED',reason:'Task7 must accept exact live startup, sandbox and tool-control evidence'},
    reflect:{status:'UNQUALIFIED',reason:'Supported separately qualified no-tools configuration unavailable'},
    executionInventory:{status:'UNQUALIFIED',reason:'Pinned protocol has no complete runtime inventory RPC'}}}),
    start:input=>dispatch(input,false),resume:input=>dispatch(input,true)};
}
