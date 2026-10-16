import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { z } from 'zod';
import { HashSchema, IdSchema, PathSchema, TextSchema, type Result } from '../../contracts/common.ts';
import { ExecutionAuthorizationSchema, ExecutionOwnerSchema, LaunchSpecSchema, type ExecutionOwner, type LaunchSpec, type OwnedExecution, type Supervisor, type DrainEvidence } from '../../contracts/execution.ts';
import { BoundaryProfileSchema, compileCommandBoundary } from '../../runtime/command-boundary.ts';
import type { ArtifactRef, ExecutionInventory, InterruptReceipt, ProviderAdapter, ProviderEvent, ProviderResume, ProviderSession, ProviderStart } from '../provider.ts';
import { checkControls, denyServerRequest, projectConfig, projectRequirements, record, type SafeConfig, type SafeRequirements } from './policy.ts';
import { CodexTransport, type Incoming } from './transport.ts';
import type { ThreadSettingsUpdatedNotification } from './protocol/0.162.1/typescript/v2/ThreadSettingsUpdatedNotification.js';
import type { ModelListResponse } from './protocol/0.162.1/typescript/v2/ModelListResponse.js';
import type { SandboxPolicy } from './protocol/0.162.1/typescript/v2/SandboxPolicy.js';
import type { TurnError } from './protocol/0.162.1/typescript/v2/TurnError.js';

export const CODEX_VERSION='0.162.1';
export const CODEX_BINARY_HASH='dd13bdb162a184fa04039488b234a8258ef9b76f84e926c505d5742b19249a6a';
const PROFILE='ouroboros_worker';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const artifactSchema=z.strictObject({id:IdSchema,sha256:HashSchema});
const boundarySchema=BoundaryProfileSchema.omit({qualification:true});
const startSchema=z.strictObject({owner:ExecutionOwnerSchema,actionId:IdSchema,workspaceRoot:TextSchema,
  promptRef:artifactSchema,contextRefs:z.array(artifactSchema).max(32),model:TextSchema,effort:TextSchema,
  boundary:BoundaryProfileSchema.or(boundarySchema),authorization:ExecutionAuthorizationSchema,mode:z.enum(['IMPLEMENT','REFLECT'])});
const reconciliationSchema=z.strictObject({priorOwner:ExecutionOwnerSchema,sessionId:TextSchema,evidenceIds:z.array(IdSchema).min(1),
  priorExecutionDrained:z.literal(true),outcome:z.literal('safe_to_resume')});
const resumeSchema=startSchema.extend({sessionId:TextSchema,reconciliation:reconciliationSchema});
type RuntimeIdentity={version:typeof CODEX_VERSION;sha256:typeof CODEX_BINARY_HASH;executable:string;profile:typeof PROFILE;policyHash:string};
type AuthorityBase={input:Readonly<ProviderStart>;runtime:Readonly<RuntimeIdentity>};
/** Controllers validate existing receipts or an independently approved bounded probe.
 * No callback may waive adapter-observed unsafe controls or mint qualification.
 * Startup proof must cover exact argv/env/loaded config, including hooks/MCP/plugin
 * startup and managed surfaces BEFORE spawning; config/read cannot supply that proof.
 * A probe's authorization covers only its predeclared fixture operations and budget.
 * The supervisor's authorize(spec) remains separately mandatory and current. */
export type DispatchAuthority = AuthorityBase & (
  | {kind:'qualified';qualificationRef:string}
  | {kind:'qualification';requestId:string;probeId:string;fixtureRoots:readonly string[]}
);
type Decision={authorized:boolean;authorizationRef:string};
export type CodexAdapterOptions={
  supervisor:Supervisor;executable:string;binaryHash:string;env:Record<string,string>;
  /** Predeclared non-secret identifiers only; startup authority verifies completeness. */
  mcpServerIds?:string[];
  loadArtifact:(ref:Readonly<ArtifactRef>)=>Promise<string>;
  authorizeStartup:(request:DispatchAuthority & {launch:Readonly<LaunchSpec>})=>Promise<Decision>;
  authorizeObserved:(request:DispatchAuthority & {startupAuthorizationRef:string;config:SafeConfig;requirements:SafeRequirements;
    settings:SafeSettings;observedFingerprint:string})=>Promise<Decision>;
  requestTimeoutMs?:number;
};
type SafeSettings={threadId:string;expectedProfile:boolean;noParentProfile:boolean;expectedProvider:boolean;
  expectedModel:boolean;expectedCwd:boolean;expectedApproval:boolean;expectedReviewer:boolean;sandboxPolicy:SandboxPolicyEvidence};
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
      options.binaryHash!==CODEX_BINARY_HASH||profile.verifier.sha256!==CODEX_BINARY_HASH||profile.verifier.version!==CODEX_VERSION||
      profile.verifier.executable!==options.executable||!absolute(options.executable)||!absolute(input.workspaceRoot)||
      !profile.readRoots.some(root=>contained(input.workspaceRoot,root))||!profile.writeRoots.some(root=>contained(input.workspaceRoot,root)))
    return failure('CAPABILITY_UNAVAILABLE','Owner, workspace or exact native runtime boundary mismatch');
  const paths=[...profile.readRoots,...profile.writeRoots,...profile.deniedSensitiveRoots];
  if(paths.some(path=>!absolute(path))||profile.deniedSensitiveRoots.some(root=>contained(input.workspaceRoot,root)||contained(options.executable,root))||
      profile.readRoots.some(root=>profile.deniedSensitiveRoots.some(denied=>contained(root,denied)||contained(denied,root)))||
      profile.writeRoots.some(root=>!profile.readRoots.some(read=>contained(root,read))))return failure('CAPABILITY_UNAVAILABLE','Unsupported or overlapping native scope');
  if(Object.keys(options.env).some(key=>/^(?:OPENAI_API_KEY|CODEX_API_KEY|AZURE_OPENAI_API_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|NODE_OPTIONS|BASH_ENV|ENV|PYTHONPATH|PYTHONHOME|LD_.+|DYLD_.+)$/i.test(key)))
    return failure('SUBSCRIPTION_SOURCE_UNSAFE','Disallowed API/provider or startup environment key is present');
  let policyHash:string;
  if(input.authorization.kind==='qualified'){
    if(!profile.qualification||input.authorization.qualificationRef!==profile.qualification.qualificationRef)return failure('EXECUTION_NOT_AUTHORIZED','Current qualified boundary receipt required');
    const validated=compileCommandBoundary(profile.registry[0],profile as z.infer<typeof BoundaryProfileSchema>);
    if(!validated.ok)return validated;policyHash=validated.value.boundaryHash;
  }else{
    const fixtureRoots=input.authorization.fixtureRoots;
    if(!fixtureRoots.every(absolute)||!fixtureRoots.some(root=>contained(input.workspaceRoot,root))||
        profile.readRoots.some(root=>!fixtureRoots.some(fixture=>contained(root,fixture)))||
        profile.writeRoots.some(root=>!fixtureRoots.some(fixture=>contained(root,fixture))))
      return failure('EXECUTION_NOT_AUTHORIZED','Qualification probe policy exceeds declared disposable fixtures');
    const {qualification:_qualification,runId:_runId,generation:_generation,actionId:_actionId,role:_role,leaseTtlMs:_lease,deadline:_deadline,...policy}=profile;
    policyHash=digest(policy);
  }
  if(profile.network.allowedDomains.length && !profile.qualification?.networkProxy)return failure('CAPABILITY_UNAVAILABLE','Network proxy enforcement is not qualified');
  const filesystem:Record<string,string>={':minimal':'read'};
  for(const root of profile.readRoots)filesystem[root]='read';for(const root of profile.writeRoots)filesystem[root]='write';for(const root of profile.deniedSensitiveRoots)filesystem[root]='deny';
  const table=Object.entries(filesystem).map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
  const domains=[...profile.network.allowedDomains.map(v=>`${JSON.stringify(v)}="allow"`),...profile.network.deniedDomains.map(v=>`${JSON.stringify(v)}="deny"`)].join(',');
  const network=`enabled=${profile.network.allowedDomains.length>0},allow_local_binding=false,allow_upstream_proxy=false,dangerously_allow_all_unix_sockets=false,dangerously_allow_non_loopback_proxy=false,domains={${domains}}`;
  const argv=['app-server','--strict-config','--stdio','-c','windows.sandbox="mxc"','-c',`permissions.${PROFILE}={filesystem={${table}},network={${network}}}`,
    '-c',`default_permissions="${PROFILE}"`,'-c','features.apps=false','-c','features.hooks=false','-c','web_search="disabled"'];
  if(profile.network.allowedDomains.length)argv.push('-c','features.network_proxy=true');
  for(const id of options.mcpServerIds??[]) {if(!/^[A-Za-z0-9_-]+$/.test(id))return failure('CAPABILITY_UNAVAILABLE','Unsupported MCP identifier');argv.push('-c',`mcp_servers.${id}.enabled=false`);}
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
  const options={...optionsInput,env:immutable({...optionsInput.env}),mcpServerIds:Object.freeze([...(optionsInput.mcpServerIds??[])])} as CodexAdapterOptions;
  const timeout=options.requestTimeoutMs??5000;
  async function dispatch(raw:ProviderStart|ProviderResume,resume:boolean):Promise<Result<ProviderSession>>{
    const parsed=(resume?resumeSchema:startSchema).safeParse(raw);if(!parsed.success)return failure('INVALID_CONTRACT','Invalid provider dispatch or reconciliation contract');
    const input=immutable(parsed.data) as ProviderStart|ProviderResume;
    if(resume){const resumed=input as ProviderResume;if(resumed.reconciliation.sessionId!==resumed.sessionId||resumed.reconciliation.priorOwner.runId!==input.owner.runId||resumed.reconciliation.priorOwner.generation>=input.owner.generation)
      return failure('EXECUTION_NOT_AUTHORIZED','Resume requires prior generation drainage and exact persisted session reconciliation');}
    const compiled=buildLaunch(input,options);if(!compiled.ok)return compiled;
    const launch=immutable(compiled.value);const runtime=immutable<RuntimeIdentity>({version:CODEX_VERSION,sha256:CODEX_BINARY_HASH,executable:launch.executable,profile:PROFILE,policyHash:launch.boundaryHash});
    const authority:DispatchAuthority=immutable(input.authorization.kind==='qualified'?{kind:'qualified',input,runtime,qualificationRef:input.authorization.qualificationRef}:
      {kind:'qualification',input,runtime,requestId:input.authorization.requestId,probeId:input.authorization.probeId,fixtureRoots:input.authorization.fixtureRoots});
    let startup:Decision;
    try {startup=await bounded(()=>options.authorizeStartup({...authority,launch}),launch.deadline);if(startup.authorized!==true||typeof startup.authorizationRef!=='string'||!startup.authorizationRef)return failure('EXECUTION_NOT_AUTHORIZED','Startup boundary authorization denied');}
    catch{return failure('EXECUTION_NOT_AUTHORIZED','Startup boundary authorization unavailable');}
    if(launch.deadline<=Date.now())return failure('DEADLINE_EXPIRED','Dispatch deadline expired');
    // Validate immutable artifact bytes before launching or making any model request.
    let prompt='';
    try {for(const ref of [input.promptRef,...input.contextRefs]){const value=await bounded(()=>options.loadArtifact(ref),launch.deadline);if(typeof value!=='string'||createHash('sha256').update(value).digest('hex')!==ref.sha256)throw Error('Artifact mismatch');
      prompt+=(prompt?'\n\n':'')+value;if(Buffer.byteLength(prompt)>64*1024)throw Error('Prompt budget exhausted');}}
    catch{return failure('INVALID_ARTIFACT','Provider prompt/context bytes are unavailable, changed or oversized');}
    const launched=await options.supervisor.launchOwned(launch);if(!launched.ok)return launched;
    const owned=launched.value;const transport=new CodexTransport(owned,{timeoutMs:timeout});const events=new EventQueue();
    let sessionId='';let turnId='';let stopped=false;let halted=false;let closePromise:Promise<DrainEvidence>|undefined;let interruptPromise:Promise<InterruptReceipt>|undefined;
    let dispatchFailureCode='PROVIDER_DISPATCH_FAILED';
    let settings:SafeSettings|undefined;let observedFingerprint='';let currentSettingsHash='';
    const settingsByThread=new Map<string,SafeSettings>();const early:Incoming[]=[];const observed=new Map<string,ExecutionInventory['observed'][number]>();
    let settingsWait:((value:SafeSettings)=>void)|undefined;let rejectSettings:((error:Error)=>void)|undefined;let settingsTimer:NodeJS.Timeout|undefined;
    let leaseSequence=0;
    const close=():Promise<DrainEvidence>=>{
      if(closePromise)return closePromise;halted=true;stopped=true;clearInterval(leaseTimer);clearTimeout(deadlineTimer);clearTimeout(settingsTimer);
      rejectSettings?.(Error('Settings observation cancelled'));rejectSettings=undefined;settingsWait=undefined;
      closePromise=(async()=>{
        try {
          try {await owned.fence();}catch {if(sessionId)emit({type:'diagnostic',code:'FENCE_ACKNOWLEDGMENT_FAILED'});}
          // Only the actual supervisor receipt proves drainage. A lost fence ACK
          // remains diagnostic evidence and never skips the drainage attempt.
          return await owned.drain('provider_close');
        } finally {transport.stop();events.end();}
      })();void closePromise.catch(()=>{});return closePromise;
    };
    const stopOnFailure=()=>{halted=true;void close().catch(()=>{});};
    const leaseTimer=setInterval(()=>{if(!stopped)void owned.renewLease(++leaseSequence).catch(stopOnFailure);},Math.min(2000,Math.floor(launch.leaseTtlMs/2)||1));
    const deadlineTimer=setTimeout(stopOnFailure,Math.min(2147483647,Math.max(1,launch.deadline-Date.now())));
    const emit=(event:EventBody<ProviderEvent>)=>events.push({...input.owner,sessionId,turnId:turnId||null,...event} as ProviderEvent);
    const safeSettings=(params:unknown):SafeSettings=>{
      const p=record(params);const s=record(p.threadSettings) as Partial<ThreadSettingsUpdatedNotification['threadSettings']>;
      const active=record(s.activePermissionProfile);
      return {threadId:typeof p.threadId==='string'?p.threadId:'',expectedProfile:active.id===PROFILE,noParentProfile:active.extends===null,
        expectedProvider:s.modelProvider==='openai',expectedModel:s.model===input.model,expectedCwd:s.cwd===input.workspaceRoot,
        expectedApproval:s.approvalPolicy==='untrusted',expectedReviewer:s.approvalsReviewer==='user',sandboxPolicy:projectSandboxPolicy(s.sandboxPolicy)};
    };
    const settingsSafe=(value:SafeSettings)=>value.expectedProfile&&value.noParentProfile&&value.expectedProvider&&value.expectedModel&&value.expectedCwd&&value.expectedApproval&&value.expectedReviewer;
    function consume(message:Incoming):void{
      if(stopped)return;
      if(message.id!==undefined){const denial=denyServerRequest({id:message.id,method:message.method});void transport.send(denial.response).catch(stopOnFailure);
        if(sessionId)emit({type:'approval',decision:'deny',method:'unsupported_or_denied'});return;}
      const params=record(message.params);
      if(message.method==='thread/settings/updated'){
        const next=safeSettings(params);if(!next.threadId)return;
        if(!sessionId){if(settingsByThread.size>=16&&!settingsByThread.has(next.threadId))throw Error('Settings budget exhausted');settingsByThread.set(next.threadId,next);}
        else if(next.threadId===sessionId){settings=next;settingsWait?.(next);settingsWait=undefined;
          if(currentSettingsHash && digest(next)!==currentSettingsHash){emit({type:'diagnostic',code:'AUTHORIZATION_INVALIDATED'});stopOnFailure();}}
        return;
      }
      if(message.method==='account/updated'||message.method.startsWith('modelProvider/authRecovery')||message.method==='model/rerouted'){
        if(sessionId)emit({type:'auth_error',code:'AUTHORIZATION_INVALIDATED'});stopOnFailure();return;
      }
      if(message.method==='account/rateLimits/updated'){
        if(sessionId)emit({type:'quota_error',code:'QUOTA_STATE_CHANGED'});stopOnFailure();return;
      }
      if(message.method==='hook/started'||message.method.startsWith('mcpServer/')||message.method==='skills/changed'||message.method==='app/list/updated'||message.method==='configWarning'){
        if(sessionId)emit({type:'diagnostic',code:'TOOL_CONFIGURATION_INVALIDATED'});stopOnFailure();return;
      }
      if(!sessionId||!turnId){if(['turn/started','turn/completed','item/started','item/completed','error'].includes(message.method)){
        if(early.length>=32)throw Error('Early notification budget exhausted');early.push(message);}return;}
      const notificationTurn=typeof params.turnId==='string'?params.turnId:record(params.turn).id;
      if(params.threadId!==sessionId||notificationTurn!==turnId)return;
      switch(message.method){
        case 'turn/started':emit({type:'turn_started'});break;
        case 'turn/completed':{
          const turn=record(params.turn);
          if(turn.status==='failed'||turn.status==='interrupted'&&turn.error!==null&&turn.error!==undefined){
            const classified=classifyTurnError(turn.error);dispatchFailureCode=classified.code;emit(classified);emit({type:'turn_completed'});stopOnFailure();
          }else emit({type:'turn_completed'});
          break;
        }
        case 'item/started':case 'item/completed':{
          const item=record(params.item);if(item.type!=='commandExecution'&&item.type!=='fileChange'){
            if(!['agentMessage','userMessage','reasoning','plan'].includes(String(item.type))){emit({type:'diagnostic',code:'UNEXPECTED_TOOL_SURFACE'});stopOnFailure();}break;}
          if(typeof item.id!=='string')throw Error('Invalid tool item');const status=message.method==='item/started'?'started':'completed';
          if(observed.size>=256&&!observed.has('item:'+item.id))throw Error('Inventory budget exhausted');observed.set('item:'+item.id,{kind:'item',id:item.id,status});emit({type:'tool_execution',itemId:item.id,status});break;}
        case 'item/commandExecution/terminalInteraction':if(typeof params.processId==='string'){
          if(observed.size>=256&&!observed.has('terminal:'+params.processId))throw Error('Inventory budget exhausted');observed.set('terminal:'+params.processId,{kind:'terminal',id:params.processId,status:'observed'});}break;
        case 'error':{const classified=classifyTurnError(params.error);dispatchFailureCode=classified.code;emit(classified);stopOnFailure();break;}
      }
    }
    transport.onMessage(consume);transport.onFailure(stopOnFailure);
    const inventory=async():Promise<ExecutionInventory>=>({owner:input.owner,sessionId,turnId,complete:false,
      reason:'Pinned protocol provides observed events only; no complete runtime execution inventory RPC',capturedAt:Date.now(),ownership:await owned.describe(),observed:[...observed.values()].map(value=>({...value}))});
    try {
      if(halted)throw Error('Startup notification invalidated dispatch');
      const identity=await owned.describe();if(identity.environment!=='windows'||!sameOwner(identity,input.owner)||identity.boundaryHash!==launch.boundaryHash)throw Error('Owned process identity mismatch');
      await transport.initialize();
      const account=await transport.request('account/read',{refreshToken:false});
      if(record(account.account).type!=='chatgpt'||account.requiresOpenaiAuth!==true)throw Error('Subscription source unavailable');
      const config=projectConfig(await transport.request('config/read',{includeLayers:false,cwd:input.workspaceRoot}));
      const requirements=projectRequirements(await transport.request('configRequirements/read',undefined));
      const controls=checkControls(config,requirements,PROFILE);if(!controls.ok){await close();return controls;}
      // Coarse observations gate catalog access; the external observed authorization
      // additionally needs thread settings and binds unobservable surfaces before turn/start.
      const response=resume?await transport.request('thread/resume',{threadId:(input as ProviderResume).sessionId,model:input.model,modelProvider:'openai',cwd:input.workspaceRoot,approvalPolicy:'untrusted',approvalsReviewer:'user',excludeTurns:true}):
        await transport.request('thread/start',{model:input.model,modelProvider:'openai',cwd:input.workspaceRoot,approvalPolicy:'untrusted',approvalsReviewer:'user',ephemeral:false});
      const thread=record(response.thread);if(typeof thread.id!=='string'||resume&&thread.id!==(input as ProviderResume).sessionId||response.modelProvider!=='openai'||response.cwd!==input.workspaceRoot||response.model!==input.model||response.approvalPolicy!=='untrusted'||response.approvalsReviewer!=='user')throw Error('Thread metadata mismatch');
      sessionId=thread.id;
      settings=settingsByThread.get(sessionId);settingsByThread.clear();
      if(!settings)settings=await new Promise<SafeSettings>((resolve,reject)=>{settingsWait=resolve;rejectSettings=reject;settingsTimer=setTimeout(()=>{settingsWait=undefined;rejectSettings=undefined;reject(Error('Settings timeout'));},timeout);});
      clearTimeout(settingsTimer);rejectSettings=undefined;if(!settingsSafe(settings))throw Error('Effective profile/settings mismatch');currentSettingsHash=digest(settings);
      observedFingerprint=digest({runtime,config,requirements,settings});
      const authorizedSettings=immutable(settings);
      const decision=await bounded(()=>options.authorizeObserved({...authority,startupAuthorizationRef:startup.authorizationRef,config,requirements,settings:authorizedSettings,observedFingerprint}),launch.deadline);
      if(decision.authorized!==true||typeof decision.authorizationRef!=='string'||!decision.authorizationRef||halted||digest(settings)!==currentSettingsHash)throw Error('Observed dispatch authorization denied or stale');
      // Token-free auth and exact effective/control authorization precede catalog access.
      let cursor:string|null=null;let selected=false;const seen=new Set<string>();
      for(let page=0;page<64;page++){
        const catalog:ModelListResponse=await transport.request('model/list',{cursor,limit:100,includeHidden:false});
        if(!Array.isArray(catalog.data)||catalog.data.length>100||catalog.nextCursor!==null&&typeof catalog.nextCursor!=='string')throw Error('Malformed model catalog');
        for(const model of catalog.data){if(model.model===input.model&&!model.hidden&&Array.isArray(model.supportedReasoningEfforts)&&model.supportedReasoningEfforts.some(option=>option.reasoningEffort===input.effort))selected=true;}
        cursor=catalog.nextCursor;if(cursor===null)break;if(seen.has(cursor)||page===63)throw Error('Model pagination exceeded bounds');seen.add(cursor);
      }
      if(!selected||halted)throw Error('Selected model/effort unavailable or authorization invalidated');
      const turn=await transport.request('turn/start',{threadId:sessionId,input:[{type:'text',text:prompt,text_elements:[]}],model:input.model,effort:input.effort,cwd:input.workspaceRoot,approvalPolicy:'untrusted',approvalsReviewer:'user'});
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
    }catch {await close();return failure(dispatchFailureCode,'Codex protocol, subscription, authorization or configuration precondition failed');}
  }
  return {inspect:async()=>({provider:'codex',runtimeVersion:CODEX_VERSION,extraUsage:'unknown',capabilities:{
    execution:{status:'UNQUALIFIED',reason:'Task7 must accept exact live startup, sandbox and tool-control evidence'},
    reflect:{status:'UNQUALIFIED',reason:'Supported separately qualified no-tools configuration unavailable'},
    executionInventory:{status:'UNQUALIFIED',reason:'Pinned protocol has no complete runtime inventory RPC'}}}),
    start:input=>dispatch(input,false),resume:input=>dispatch(input,true)};
}
