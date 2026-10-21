import { supportedNodeVersion, nodeRuntimeCapabilities, installedCodexVersion, codexVersionObservation, runtimeCompatibilityDiagnostic } from '../runtime/compatibility.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, realpath } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { LaunchSpecSchema, WindowsDrainEvidenceSchema, type DrainEvidence, type LaunchSpec, type OwnedExecution, type Supervisor } from '../contracts/execution.ts';
import type { OwnerToken } from '../contracts/evidence.ts';
import type { RunStore } from '../store/database.ts';
import type { ArtifactRef, ProviderEvent } from '../providers/provider.ts';
import { createCodexAdapter, type CodexAdapterOptions, type DispatchAuthority, type SafeCodexProtocolDiagnostic, type CodexStartupStage } from '../providers/codex/adapter.ts';
import { createSupervisor, type SupervisorOptions } from '../runtime/supervisor.ts';
import type { ProviderAdapter, ProviderSession } from '../providers/provider.ts';
import { projectBootstrapDiagnostic, type SafeBootstrapDiagnostic } from '../qualification/bootstrap-diagnostic.ts';
import { buildCodexLaunchConfig, restrictedCodexOverrides, CODEX_CONFIG_SCHEMA } from '../providers/codex/launch-config.ts';
import { codexRequestedPermissionsHash, codexRequestedEnvironmentHash, compareCodexControlHashes } from '../providers/codex/policy.ts';
import { projectConfig, projectRequirements, record, denyServerRequest, subscriptionSourceAssessment, codexRemoteControlState, isInformationalCodexNotification } from '../providers/codex/policy.ts';
import { projectManagedAccount } from '../providers/codex/startup-metadata.ts';
import { CodexTransport, CodexRpcError, CodexTransportError } from '../providers/codex/transport.ts';
import { MANAGED_ENVIRONMENT_KEYS, ORDINARY_STARTUP_EFFECTS, ownershipHash, startupTargetHash, type StartupIntent, type PhaseAdmission } from '../qualification/codex-startup-authority.ts';
import { publishArtifact } from '../store/artifacts.ts';

export type TaskExecutionResult = {ok:boolean;code:string;evidenceIds:string[];runtimeDiagnostic?:string;drain?:DrainEvidence;exitCode?:number|null;diagnostic?:SafeBootstrapDiagnostic;protocolDiagnostics?:SafeCodexProtocolDiagnostic[]};
export type TaskCommand = {executable:string;argv:string[];timeoutMs:number};
export type CodexTaskRuntimeDependencies = {
  resolveExecutable?:(path:string)=>Promise<string>;
  runtimeVersion?:(path:string)=>string;
  runtimeCapabilities?:()=>boolean;
  hashFile?:(path:string)=>Promise<string>;
  readManagedConfig?:()=>Promise<{mcpServerIds:string[];sha256:string}>;
  environment?:()=>Record<string,string>;
  nodeIdentity?:()=>{path:string;version:string};
  makeTemp?:()=>Promise<string>;
  makeAdapter?:(options:CodexAdapterOptions)=>ProviderAdapter;
  makeSupervisor?:(options:SupervisorOptions)=>Supervisor;
};
export type CodexTaskRuntimeOptions = {
  store:RunStore;owner:OwnerToken;authorization:{kind:'user-task';authorizationId:string;taskHash:string};
  workspaceRoot:string;protectedRoots:string[];runtimePath:string;helperPath:string;model:string;effort:string;deadline:number;
  verificationCommand?:TaskCommand;
  onEvent?:(event:ProviderEvent)=>void;signal?:AbortSignal;dependencies?:CodexTaskRuntimeDependencies;
};
export type CodexTaskRuntime = {implement(promptRef:ArtifactRef):Promise<TaskExecutionResult>;verify(command:TaskCommand):Promise<TaskExecutionResult>;cancel():Promise<void>};

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code:string):TaskExecutionResult=>({ok:false,code,evidenceIds:[],...(runtimeCompatibilityDiagnostic(code)?{runtimeDiagnostic:runtimeCompatibilityDiagnostic(code)}:{})});
const absolute=(path:string)=>win32.isAbsolute(path)&&!path.startsWith('\\\\')&&!/[\x00-\x1f\x7f]/.test(path)&&!path.split(/[\\/]/).some(part=>part==='.'||part==='..');
const within=(path:string,root:string)=>{const relative=win32.relative(root,path);return relative===''||relative!=='..'&&!relative.startsWith('..\\')&&!win32.isAbsolute(relative);};
class StageFailure extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
type Prepared={runtime:{path:string;version:string;sha256:string};node:{path:string;version:string;sha256:string};helperPath:string;helperHash:string;configHash:string;environmentHash:string;controls:Array<{path:string;sha256:string}>;identities:Array<{requested:string;path:string;sha256:string}>;mcpServerIds:string[];env:Record<string,string>;temp:string;privateState:string;context:NonNullable<CodexAdapterOptions['startupContext']>};
type Action={id:string;role:string;startedAt:number;expected?:LaunchSpec;prepared:Prepared;profile:Record<string,unknown>;owned?:OwnedExecution;session?:ProviderSession;drain?:DrainEvidence;stop?:Promise<void>;abort?:()=>void;stderrPrefix:Buffer;stderrBytes:number;stderrHash:ReturnType<typeof createHash>;stdoutBytes:number;helperStdoutBytes:number;helperStderrBytes:number;code:string;detach?:()=>void;prerequisiteEvidenceIds?:string[];prerequisiteResult?:TaskExecutionResult;protocolDiagnostics:SafeCodexProtocolDiagnostic[]};

export function createCodexTaskRuntime(input:CodexTaskRuntimeOptions):CodexTaskRuntime {
  const options={...input,owner:{...input.owner},authorization:{...input.authorization},protectedRoots:[...input.protectedRoots],verificationCommand:input.verificationCommand?{executable:input.verificationCommand.executable,argv:[...input.verificationCommand.argv],timeoutMs:input.verificationCommand.timeoutMs}:undefined};
  const deps=options.dependencies??{};
  const hashFile=deps.hashFile??(async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex'));
  const resolveExecutable=deps.resolveExecutable??realpath;
  const nodeIdentity=deps.nodeIdentity??(()=>({path:process.execPath,version:process.versions.node}));
  const environment=deps.environment??(()=>Object.fromEntries(MANAGED_ENVIRONMENT_KEYS.flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]])));
  const readManagedConfig=deps.readManagedConfig??(async()=>{
    const env=environment();if(!env.USERPROFILE||!absolute(env.USERPROFILE))throw new StageFailure('MANAGED_ENVIRONMENT_INVALID');
    let bytes:Buffer;try{bytes=await readFile(win32.join(env.USERPROFILE,'.codex','config.toml'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {mcpServerIds:[],sha256:digest(null)};throw new StageFailure('CONFIG_INSPECTION_FAILED');}
    if(bytes.length>1048576)throw new StageFailure('CONFIG_INSPECTION_FAILED');
    const config=parse(bytes.toString('utf8'));const servers=config.mcp_servers;
    if(servers!==undefined&&(!servers||typeof servers!=='object'||Array.isArray(servers)))throw new StageFailure('CONFIG_INSPECTION_FAILED');
    const mcpServerIds=Object.keys(servers??{});if(mcpServerIds.length>128||mcpServerIds.some(id=>!/^[A-Za-z0-9_-]{1,64}$/.test(id)))throw new StageFailure('MCP_IDENTIFIER_UNSUPPORTED');
    return {mcpServerIds,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
  let privateState:Promise<string>|undefined;
  let preparedRun:Promise<Prepared>|undefined;
  let fixedCommand:TaskCommand|undefined=options.verificationCommand;
  let active:Action|undefined;let busy=false;let cancelled=options.signal?.aborted??false;let deadlineExpired=false;
  const remaining=()=>Math.max(1,Math.min(2147483647,options.deadline-Date.now()));
  async function bounded<T>(operation:Promise<T>,ms:number,code:string):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new StageFailure(code)),ms);})]);}finally{clearTimeout(timer);}}
  async function capture():Promise<Prepared>{
    if(cancelled)throw new StageFailure('CANCELLED');
    const recovery=options.store.reconcileEvidence(options.owner.runId);
    if(!recovery.ok||!recovery.value.allowsReady)throw new StageFailure('RECOVERY_REQUIRED');
    if(![options.workspaceRoot,options.runtimePath,options.helperPath,...options.protectedRoots].every(absolute)||options.deadline<=Date.now())throw new StageFailure('TASK_SCOPE_INVALID');
    const node=nodeIdentity();
    if(!supportedNodeVersion(node.version)||(deps.runtimeCapabilities??nodeRuntimeCapabilities)()!==true)throw new StageFailure('NODE_CAPABILITY_UNSUPPORTED');
    const identities:Array<{requested:string;path:string;sha256:string}>=[];
    for(const requested of [...new Set([options.runtimePath,node.path,options.helperPath,...(fixedCommand?[fixedCommand.executable]:[])])]){
      const path=await resolveExecutable(requested);if(!absolute(path))throw new StageFailure('EXECUTABLE_PATH_UNSUPPORTED');
      const sha256=await hashFile(path);if(!/^[a-f0-9]{64}$/.test(sha256))throw new StageFailure('EXECUTABLE_IDENTITY_INVALID');identities.push({requested,path,sha256});
    }
    const identity=(requested:string)=>identities.find(value=>value.requested===requested)!;
    const runtime={path:identity(options.runtimePath).path,sha256:identity(options.runtimePath).sha256,version:(deps.runtimeVersion??installedCodexVersion)(identity(options.runtimePath).path)};
    const resolvedNode={path:identity(node.path).path,version:node.version,sha256:identity(node.path).sha256};
    const helperPath=identity(options.helperPath).path,helperHash=identity(options.helperPath).sha256;
    const managed=await readManagedConfig();const env={...environment()};const environmentHash=digest(env);
    if(Object.keys(env).some(key=>!(MANAGED_ENVIRONMENT_KEYS as readonly string[]).includes(key))||Object.keys(env).length!==8||!/^\w:$/.test(env.SystemDrive)||Object.entries(env).some(([key,path])=>key!=='SystemDrive'&&!absolute(path)))throw new StageFailure('MANAGED_ENVIRONMENT_INVALID');
    const temp=await (deps.makeTemp?.()??mkdtemp(join(tmpdir(),'ouroboros-task-')));if(!absolute(temp)||within(temp,options.workspaceRoot))throw new StageFailure('TEMP_SCOPE_INVALID');
    env.TEMP=temp;env.TMP=temp;
    const state=await(privateState??=mkdtemp(join(options.store.root,'codex-state-')));
    if(!absolute(state)||!within(state,options.store.root)||within(state,options.workspaceRoot)||within(state,temp))throw new StageFailure('PRIVATE_STATE_SCOPE_INVALID');
    const extension=import.meta.url.endsWith('.ts')?'.ts':'.js';
    const controls=await Promise.all(['./codex-task-runtime','../providers/codex/adapter','../providers/codex/transport','../providers/codex/policy','../providers/codex/startup-metadata','../providers/codex/launch-config','../runtime/supervisor','../runtime/compatibility','../qualification/codex-startup-authority','../runtime/command-boundary','../contracts/execution','./run-task','../store/database','../store/artifacts','../contracts/task','../contracts/evidence','../contracts/provider','../contracts/common','../providers/provider'].map(async name=>{const path=fileURLToPath(new URL(name+extension,import.meta.url));return {path,sha256:await hashFile(path)};}));
    for(const relative of ['../../package.json','../../package-lock.json']){const path=fileURLToPath(new URL(relative,import.meta.url));controls.push({path,sha256:await hashFile(path)});}
    const [controllerHash,adapterHash,protocolHash]=controls.map(value=>value.sha256);const verifierHash=controls[5].sha256;
    return {runtime,node:resolvedNode,helperPath,helperHash,configHash:managed.sha256,environmentHash,controls,identities,mcpServerIds:[...managed.mcpServerIds],env,temp,privateState:state,context:{node:resolvedNode,helper:{path:helperPath,sha256:helperHash},controllerHash,adapterHash,protocolHash,verifierHash,osCapabilitiesHash:digest({platform:process.platform,arch:process.arch}),configHash:managed.sha256,controlHash:digest({controls,protectedRoots:options.protectedRoots,workspace:options.workspaceRoot,verification:fixedCommand}),budget:{activeMs:60000,outputBytes:262144,cleanupMs:15000}}};
  }
  async function prepare():Promise<Prepared>{
    const recovery=options.store.reconcileEvidence(options.owner.runId);if(!recovery.ok||!recovery.value.allowsReady)throw new StageFailure('RECOVERY_REQUIRED');
    const prepared=await(preparedRun??=capture());await unchanged(prepared);return prepared;
  }

  function profile(prepared:Prepared,writeWorkspace:boolean,command?:TaskCommand):Record<string,unknown>{
    const filesystem:Record<string,string>={':minimal':'read',[options.workspaceRoot]:writeWorkspace?'write':'read',[prepared.temp]:'write',[win32.dirname(prepared.node.path)]:'read'};
    if(command)filesystem[win32.dirname(command.executable)]='read';
    const denied=[...new Set([...options.protectedRoots,options.store.root,win32.join(prepared.env.USERPROFILE,'.codex')])];
    const grants=Object.keys(filesystem).filter(path=>path!==':minimal');
    if(denied.some(root=>grants.some(grant=>within(grant,root)||within(root,grant))))throw new StageFailure('TASK_SCOPE_OVERLAP');
    for(const root of denied)filesystem[root]='deny';
    return {filesystem,network:{enabled:false,allow_local_binding:false,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains:{}}};
  }
  async function unchanged(prepared:Prepared):Promise<boolean>{
    if(cancelled||deadlineExpired||Date.now()>=options.deadline)return false;
    const changed=(code:string):never=>{if(active)active.code=code;throw new StageFailure(code);};
    for(const pin of prepared.identities){
      try{if((await resolveExecutable(pin.requested)).toLowerCase()!==pin.path.toLowerCase()||await hashFile(pin.path)!==pin.sha256)throw Error();}
      catch{changed('EXECUTABLE_CHANGED_DURING_RUN');}
    }
    const node=nodeIdentity();
    if(node.path!==prepared.identities.find(pin=>pin.path===prepared.node.path)?.requested||node.version!==prepared.node.version||digest(environment())!==prepared.environmentHash)changed('LAUNCH_CONTROLS_CHANGED');
    for(const pin of prepared.controls){try{if(await hashFile(pin.path)!==pin.sha256)changed('LAUNCH_CONTROLS_CHANGED');}catch{changed('LAUNCH_CONTROLS_CHANGED');}}
    try{const config=await readManagedConfig();if(config.sha256!==prepared.configHash||digest(config.mcpServerIds)!==digest(prepared.mcpServerIds))changed('POLICY_CONTROLS_CHANGED');}catch{changed('POLICY_CONTROLS_CHANGED');}
    return true;
  }
  function shellPolicy(prepared:Prepared){
    // Pinned populate_env applies include_only after merged `set` overrides.
    // Unknown executable-injection variables cannot survive this final filter.
    return {inherit:'none',ignore_default_excludes:false,exclude:[],include_only:[...MANAGED_ENVIRONMENT_KEYS],set:{...prepared.env},experimental_use_profile:false};
  }
  function protocolDiagnostic(action:Action,fact:SafeCodexProtocolDiagnostic):void{
    // Reserve room for both policy projections and the terminal failure
    // even when earlier informational notifications filled the diagnostic cap.
    if(fact.kind==='subscription_policy'&&action.protocolDiagnostics.length>=31)action.protocolDiagnostics.splice(30);
    if((fact.kind==='effective_policy'||fact.kind==='thread_policy')&&action.protocolDiagnostics.length>=31)action.protocolDiagnostics.splice(0,action.protocolDiagnostics.length-30);
    if(action.protocolDiagnostics.length<32)action.protocolDiagnostics.push(structuredClone(fact));
    else if(fact.kind==='startup_failure')action.protocolDiagnostics[31]=structuredClone(fact);
  }
  function saveIntent(action:Action,spec:LaunchSpec):void{
    if(cancelled||deadlineExpired||Date.now()>=options.deadline)throw new StageFailure(deadlineExpired?'TASK_DEADLINE_EXPIRED':'CANCELLED');
    // Use the same strict schema snapshot as createSupervisor. Object creation
    // order must not change authorization; every validated value stays bound.
    const normalized=LaunchSpecSchema.parse(spec);
    if(action.expected&&digest(action.expected)!==digest(normalized))throw new StageFailure('LAUNCH_INTENT_CHANGED');
    if(action.expected)return;
    const result=options.store.intent(options.owner,{schemaVersion:1,id:action.id,runId:options.owner.runId,kind:action.role==='verifier'?'VERIFY':action.role==='verifier-policy'?'INSPECT_POLICY':'IMPLEMENT',payload:{spec:normalized,helperHash:action.prepared.helperHash,nodeHash:action.prepared.node.sha256,runtimeHash:action.prepared.runtime.sha256,configHash:action.prepared.configHash}});
    if(!result.ok)throw new StageFailure(result.error.code);action.expected=structuredClone(normalized);
  }
  function supervisor(action:Action):Supervisor{
    const base=(deps.makeSupervisor??createSupervisor)({helperPath:action.prepared.helperPath,observation:{waitHelperExit:true,onRawBytes:(_source,stream,bytes)=>{
      if(stream==='stdout')action.helperStdoutBytes+=bytes.byteLength;else action.helperStderrBytes+=bytes.byteLength;
      const reserved=options.store.reserveOutput(options.owner,action.id,bytes.byteLength);
      if(!reserved.ok||reserved.value.limit){action.code=reserved.ok?'OUTPUT_LIMIT_EXCEEDED':'OUTPUT_ACCOUNTING_FAILED';if(action.owned)void stop(action).catch(()=>{});}
    },onProcessCompleted:meter=>{
      const charged=options.store.recordProcessUsage(options.owner,action.id,meter);
      if(!charged.ok||charged.value.limit){action.code=charged.ok?'ACTIVE_LIMIT_EXCEEDED':'TIME_ACCOUNTING_FAILED';void stop(action).catch(()=>{});}
    }},authorize:async spec=>{
      try{
      if(!action.expected||digest(spec)!==digest(action.expected)||!await unchanged(action.prepared)||spec.deadline>Date.now()+2147483647||spec.launchNotAfter===undefined||Date.now()>=spec.launchNotAfter)return false;
      const stored=options.store.loadAction(action.id);if(!stored.ok||stored.value.state!=='INTENDED'||stored.value.generation!==options.owner.generation||digest(stored.value.payload.spec)!==digest(spec)||stored.value.payload.helperHash!==action.prepared.helperHash||stored.value.payload.nodeHash!==action.prepared.node.sha256||stored.value.payload.runtimeHash!==action.prepared.runtime.sha256)return false;
      return options.store.dispatch(options.owner,action.id).ok;
      }catch(error){if(error instanceof StageFailure)action.code=error.code;return false;}
    }});
    return {launchOwned:async spec=>{
      const result=await base.launchOwned(spec);if(!result.ok){if(action.code==='PROVIDER_DISPATCH_FAILED')action.code=result.error.code;return result;}
      const owned=result.value;const listeners=new Set<Parameters<OwnedExecution['onOutput']>[0]>();let drainPromise:Promise<DrainEvidence>|undefined;
      const early:Array<Parameters<Parameters<OwnedExecution['onOutput']>[0]>[0]>=[];let earlyBytes=0;
      const wrapped:OwnedExecution={describe:()=>owned.describe(),fence:()=>owned.fence(),renewLease:sequence=>owned.renewLease(sequence),drain:reason=>drainPromise??=(async()=>{const receipt=await owned.drain(reason);action.drain=receipt;return receipt;})(),writeInput:bytes=>owned.writeInput(bytes),endInput:()=>owned.endInput(),
        ...(owned.waitForDrain?{waitForDrain:()=>owned.waitForDrain!()}:{}),
        onOutput:listener=>{listeners.add(listener);for(const output of early.splice(0))listener(output);earlyBytes=0;return()=>listeners.delete(listener);}};
      action.owned=wrapped;
      if(action.code!=='PROVIDER_DISPATCH_FAILED')void stop(action).catch(()=>{});
      action.detach=owned.onOutput(output=>{
        try{
          const reserved=options.store.reserveOutput(options.owner,action.id,output.data.byteLength);
          if(!reserved.ok||reserved.value.limit){action.code=reserved.ok?'OUTPUT_LIMIT_EXCEEDED':'OUTPUT_ACCOUNTING_FAILED';void stop(action).catch(()=>{});}
        }catch{action.code='OUTPUT_ACCOUNTING_FAILED';void stop(action).catch(()=>{});}
        if(output.stream==='stderr'){
          action.stderrBytes+=output.data.byteLength;action.stderrHash.update(output.data);
          const remaining=16384-action.stderrPrefix.length;if(remaining>0)action.stderrPrefix=Buffer.concat([action.stderrPrefix,output.data.subarray(0,remaining)]);
        }else action.stdoutBytes+=output.data.byteLength;
        if(listeners.size){for(const listener of listeners)listener(output);}
        else if(action.role!=='verifier'){
          earlyBytes+=output.data.byteLength;
          if(early.length>=128||earlyBytes>1048576){action.code='STARTUP_OUTPUT_LIMIT';void stop(action).catch(()=>{});}
          else early.push({stream:output.stream,data:Buffer.from(output.data)});
        }
      });
      return {ok:true,value:wrapped};
    }};
  }
  function admission(action:Action,intent:StartupIntent,phase:PhaseAdmission['phase'],owned?:Parameters<typeof ownershipHash>[0],observationHash?:string):PhaseAdmission{
    return {schemaVersion:2,semantics:'requested-controls-and-observed-policy',phase,intentHash:startupTargetHash(intent),owner:intent.owner,issuedAt:Date.now(),expiresAt:intent.expiresAt,ordinaryEffects:[...ORDINARY_STARTUP_EFFECTS],budget:{...intent.budget},authorization:{...options.authorization},argumentsHash:intent.argumentsHash,controlHash:intent.controlHash,...(owned?{ownershipHash:ownershipHash(owned),observationHash}: {})};
  }
  function validDrain(action:Action,raw:unknown):raw is DrainEvidence{
    const parsed=WindowsDrainEvidenceSchema.safeParse(raw);if(!parsed.success)return false;const d=parsed.data;
    return d.runId===options.owner.runId&&d.generation===options.owner.generation&&d.actionId===action.id&&d.role===action.role&&d.rootExited&&d.membershipEmpty&&d.activeProcesses===0&&d.unresolvedExecutions.length===0&&d.outputComplete&&d.unresolvedOutputStreams.length===0&&d.rootExitedAt!==null&&d.outputCompletedAt!==null&&d.requestedAt>=action.startedAt&&d.rootExitedAt>=action.startedAt&&d.membershipObservedAt>=action.startedAt&&d.outputCompletedAt>=action.startedAt&&d.completedAt>=Math.max(d.rootExitedAt,d.membershipObservedAt,d.outputCompletedAt)&&d.completedAt<=Date.now();
  }
  async function stop(action:Action):Promise<void>{
    if(action.stop)return action.stop;
    action.stop=(async()=>{
      if(action.session){const receipt=await bounded(action.session.interrupt(),15000,'INTERRUPT_DRAIN_TIMEOUT');action.drain=receipt.drain;}
      else if(action.owned){try{await bounded(action.owned.fence(),5000,'FENCE_TIMEOUT');}catch{/* Drain still owns cleanup. */}action.drain=await bounded(action.owned.drain(cancelled?'task_cancelled':'task_cleanup'),15000,'DRAIN_TIMEOUT');}
    })();return action.stop;
  }
  async function finish(action:Action,success:boolean,code:string):Promise<TaskExecutionResult>{
    if(action.owned&&!action.drain){try{if(action.session)action.drain=await bounded(action.session.close(),15000,'DRAIN_TIMEOUT');else await stop(action);}catch{code='DRAIN_UNPROVEN';}}
    if(action.code!=='PROVIDER_DISPATCH_FAILED'){success=false;code=action.code;}
    action.detach?.();
    const state=options.store.loadAction(action.id);
    if(state.ok&&state.value.state==='INTENDED'){options.store.cancelUndispatched(options.owner,action.id);return fail(code);}
    if(!state.ok)return action.prerequisiteResult?{...action.prerequisiteResult,ok:false,code}:fail(code);
    const complete=validDrain(action,action.drain);
    const diagnostic=projectBootstrapDiagnostic({prefix:action.stderrPrefix,totalBytes:action.stderrBytes,streamHash:action.stderrHash.digest('hex'),stream:'stderr',runtimeIdentity:action.prepared.runtime.sha256,streamIdentity:digest({actionId:action.id,stream:'stderr'}),truncated:action.stderrBytes>action.stderrPrefix.length,drainageComplete:complete});
    const finalCode=!complete?'DRAIN_UNPROVEN':cancelled?'CANCELLED':code;
    const protocolDiagnostics=[...(action.prerequisiteResult?.protocolDiagnostics??[]),...action.protocolDiagnostics].slice(-32);
    const result:TaskExecutionResult={ok:success&&complete&&!cancelled,code:finalCode,evidenceIds:[],...(runtimeCompatibilityDiagnostic(finalCode)?{runtimeDiagnostic:runtimeCompatibilityDiagnostic(finalCode)}:{}),...(action.drain?{drain:action.drain}:{}),...(action.drain&&'rootExitCode' in action.drain?{exitCode:action.drain.rootExitCode??null}:{}),diagnostic,...(protocolDiagnostics.length?{protocolDiagnostics}:{})};
    async function* body(){yield Buffer.from(JSON.stringify({schemaVersion:1,kind:action.role,runtime:{codex:action.prepared.runtime,node:action.prepared.node,supervisor:{path:action.prepared.helperPath,sha256:action.prepared.helperHash},controlHash:action.prepared.context.controlHash},ok:result.ok,code:result.code,runtimeDiagnostic:result.runtimeDiagnostic,drain:action.drain??null,diagnostic,protocolDiagnostics,stdoutBytes:action.stdoutBytes,stderrBytes:action.stderrBytes,helperStdoutBytes:action.helperStdoutBytes,helperStderrBytes:action.helperStderrBytes}));}
    const artifact=await publishArtifact(options.store,body(),{schemaVersion:1,id:randomUUID(),owner:options.owner,actionId:action.id,mediaType:'application/json',secrets:[]});
    if(!complete||!artifact.ok||artifact.value.truncated){options.store.unknown(options.owner,action.id);return {...result,ok:false,code:complete?'EVIDENCE_NOT_DURABLE':'DRAIN_UNPROVEN',evidenceIds:artifact.ok?[artifact.value.id]:[]};}
    result.evidenceIds=[...(action.prerequisiteEvidenceIds??[]),artifact.value.id];
    const outcome=options.store.outcome(options.owner,action.id,{schemaVersion:1,status:cancelled?'CANCELLED':result.ok?'SUCCEEDED':'FAILED',evidenceIds:result.evidenceIds});
    if(!outcome.ok){options.store.unknown(options.owner,action.id);return {...result,ok:false,code:'OUTCOME_NOT_DURABLE'};}
    return result;
  }
  async function observeVerifierPolicy(parent:Action,name:string):Promise<void>{
    const p=parent.prepared;const policy=shellPolicy(p);
    const config=buildCodexLaunchConfig({entryPoint:'metadata',schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name},overrides:restrictedCodexOverrides({profileName:name,profile:parent.profile as any,defaultPermissions:true,mcpServerIds:p.mcpServerIds,shellEnvironmentPolicy:policy,sqliteHome:p.privateState})}});
    if(!config.ok)throw new StageFailure(config.error.code);
    const action:Action={id:randomUUID(),role:'verifier-policy',startedAt:Date.now(),prepared:p,profile:parent.profile,stderrPrefix:Buffer.alloc(0),stderrBytes:0,stderrHash:createHash('sha256'),stdoutBytes:0,helperStdoutBytes:0,helperStderrBytes:0,code:'PROVIDER_DISPATCH_FAILED',protocolDiagnostics:[]};
    active=action;let transport:CodexTransport|undefined;let observed=false;let code='VERIFIER_POLICY_UNOBSERVED';let lease:NodeJS.Timeout|undefined;let stage:CodexStartupStage='OWNERSHIP';let startupWarnings=0;let policyObserved=false;let startupAccountUpdates=0;let accountObserved=false;
    try{
      const deadline=Math.min(options.deadline,Date.now()+60000);
      const spec:LaunchSpec={runId:options.owner.runId,generation:options.owner.generation,actionId:action.id,role:action.role,executable:p.runtime.path,argv:config.value.argv,cwd:options.workspaceRoot,env:p.env,boundaryHash:digest(parent.profile),authorization:options.authorization,stdin:'pipe',leaseTtlMs:10000,launchNotAfter:deadline,deadline};
      saveIntent(action,spec);const launched=await supervisor(action).launchOwned(spec);if(!launched.ok)throw new StageFailure(launched.error.code);
      let sequence=0;lease=setInterval(()=>{void launched.value.renewLease(++sequence).catch(()=>{action.code='POLICY_LEASE_LOST';void stop(action).catch(()=>{});});},2000);
      transport=new CodexTransport(launched.value,{timeoutMs:5000,initializationTimeoutMs:Math.max(1,Math.min(60000,deadline-Date.now())),maxOutputBytes:262144});
      action.abort=()=>transport?.fence();
      let invalid=false;let remoteControlUpdates=0;let informationalUpdates=0;
      transport.onMessage(message=>{
        if(message.id===undefined&&isInformationalCodexNotification(message.method,message.params)){
          if(++informationalUpdates>32){invalid=true;action.code='PROVIDER_INFORMATIONAL_NOTIFICATION_LIMIT';void stop(action).catch(()=>{});}return;
        }
        if(message.id===undefined&&message.method==='remoteControl/status/changed'){
          const state=codexRemoteControlState(message.params);protocolDiagnostic(action,{kind:'remote_control_status',stage,state});
          if(state!=='disabled'||++remoteControlUpdates>32){invalid=true;action.code=state!=='disabled'?'REMOTE_CONTROL_NOT_DISABLED':'PROVIDER_REMOTE_CONTROL_UPDATE_LIMIT';void stop(action).catch(()=>{});}
          return;
        }
        if(message.id===undefined&&message.method==='configWarning'&&!policyObserved&&++startupWarnings<=32){protocolDiagnostic(action,{kind:'startup_warning',stage,count:startupWarnings});return;}
        if(message.id===undefined&&message.method==='account/updated'&&!accountObserved&&++startupAccountUpdates<=32){protocolDiagnostic(action,{kind:'startup_account_update',stage,count:startupAccountUpdates});return;}
        if(message.id!==undefined){void transport!.send(denyServerRequest({id:message.id,method:message.method}).response).catch(()=>{});invalid=true;action.code='UNSUPPORTED_SERVER_REQUEST';void stop(action).catch(()=>{});return;}
        if(message.method!=='account/rateLimits/updated'){invalid=true;action.code=startupWarnings>32?'PROVIDER_STARTUP_WARNING_LIMIT':startupAccountUpdates>32?'PROVIDER_STARTUP_ACCOUNT_UPDATE_LIMIT':message.method==='account/updated'?'PROVIDER_ACCOUNT_INVALIDATED':message.method==='model/rerouted'?'PROVIDER_MODEL_REROUTED':message.method.startsWith('modelProvider/authRecovery')?'PROVIDER_AUTH_RECOVERY_REQUIRED':'TOOL_CONFIGURATION_INVALIDATED';void stop(action).catch(()=>{});}
      });
      stage='INITIALIZE';const initialized=await transport.initialize();protocolDiagnostic(action,{kind:'runtime_observation',stage,version:codexVersionObservation(initialized.userAgent)});
      const readStartup=async()=>{
        const accountVersion=startupAccountUpdates;
        stage='ACCOUNT_READ';const account=projectManagedAccount(await transport!.request('account/read',{refreshToken:false}));stage='ACCOUNT_CHECK';
        if(account.state!=='authenticated')throw new StageFailure('VERIFIER_AUTH_UNAVAILABLE');
        stage='CONFIG_READ';const raw=await transport!.request('config/read',{includeLayers:false,cwd:options.workspaceRoot});
        stage='REQUIREMENTS_READ';const requirementsRaw=await transport!.request('configRequirements/read',undefined);
        return {raw,requirementsRaw,accountVersion};
      };
      let observation=await readStartup();if(observation.accountVersion!==startupAccountUpdates)observation=await readStartup();
      if(observation.accountVersion!==startupAccountUpdates)throw new StageFailure('PROVIDER_STARTUP_ACCOUNT_UNSTABLE');
      accountObserved=true;const {raw,requirementsRaw}=observation;const effective=projectConfig(raw);const requirements=projectRequirements(requirementsRaw);const required=record(record(requirementsRaw).requirements);const allowed=required.allowedPermissionProfiles;stage='CONTROLS';
      protocolDiagnostic(action,{kind:'subscription_policy',stage,assessment:subscriptionSourceAssessment(effective,requirements)});
      const assessment={permissions:compareCodexControlHashes(codexRequestedPermissionsHash(parent.profile),effective.selectedPermissionsHash),environment:compareCodexControlHashes(codexRequestedEnvironmentHash(policy),effective.shellEnvironmentPolicyHash),state:compareCodexControlHashes(digest(p.privateState),effective.sqliteHomeHash)};
      protocolDiagnostic(action,{kind:'effective_policy',stage,assessment});
      if(invalid||record(raw.config).default_permissions!==name||assessment.permissions.result!=='MATCH'||assessment.environment.result!=='MATCH'||assessment.state.result!=='MATCH'||effective.provider!=='openai'||!effective.mxc||!effective.appsDisabled||!effective.hooksDisabled||!effective.webDisabled||!effective.mcpDisabled||effective.optionalConflict||effective.disallowedAuth||!requirements.providerSafe||!requirements.loginSafe||!requirements.approvalSafe||requirements.disallowedAuth||['plugins','browser','browserExternal','browserCdp','computer'].some(key=>requirements.states[key]==='enabled')||allowed!==undefined&&allowed!==null&&record(allowed)[name]!==true)throw new StageFailure('VERIFIER_POLICY_CONFLICT');
      policyObserved=true;if(!await unchanged(p)||invalid)throw new StageFailure('VERIFIER_CONFIG_CHANGED');
      observed=true;code='VERIFIER_POLICY_OBSERVED';
    }catch(error){code=error instanceof StageFailure?error.code:`VERIFIER_${stage}_FAILED`;protocolDiagnostic(action,{kind:'startup_failure',stage,code,startupWarnings,...(error instanceof CodexRpcError?{rpc:error.fact}:{}),...(error instanceof CodexTransportError?{transport:error.fact}:{})});}
    finally{clearInterval(lease);transport?.fence();action.abort=undefined;}
    const result=await finish(action,observed,code);transport?.stop();active=parent;parent.prerequisiteResult=result;
    if(!result.ok)throw new StageFailure(result.code);parent.prerequisiteEvidenceIds=result.evidenceIds;
  }
  async function execute(kind:'implementation'|'verifier',operation:(action:Action)=>Promise<{ok:boolean;code:string}>,command?:TaskCommand):Promise<TaskExecutionResult>{
    if(busy)return fail('TASK_RUNTIME_BUSY');if(cancelled)return fail('CANCELLED');if(deadlineExpired)return fail('TASK_DEADLINE_EXPIRED');busy=true;let action:Action|undefined;let deadlineTimer:NodeJS.Timeout|undefined;
    try{
      const prepared=await bounded(prepare(),remaining(),'PREFLIGHT_TIMEOUT');
      const resolvedCommand=command?{...command,executable:prepared.identities.find(pin=>pin.requested===command.executable)?.path??command.executable}:undefined;
      action={id:randomUUID(),role:kind,startedAt:Date.now(),prepared,profile:profile(prepared,kind==='implementation',resolvedCommand),stderrPrefix:Buffer.alloc(0),stderrBytes:0,stderrHash:createHash('sha256'),stdoutBytes:0,helperStdoutBytes:0,helperStderrBytes:0,code:'PROVIDER_DISPATCH_FAILED',protocolDiagnostics:[]};active=action;
      // A deadline cancels the owned operation rather than abandoning its promise.
      // In particular, auxiliary metadata must finish drainage/accounting and
      // persistence before the caller can close the store. Its pending RPCs are
      // fenced synchronously; stop/finish retain their finite cleanup bounds.
      deadlineTimer=setTimeout(()=>{deadlineExpired=true;action!.code='TASK_DEADLINE_EXPIRED';if(active){active.code='TASK_DEADLINE_EXPIRED';active.abort?.();void stop(active).catch(()=>{});}},remaining());
      const result=await operation(action);clearTimeout(deadlineTimer);return await finish(action,result.ok,result.code);
    }catch(error){const code=error instanceof StageFailure?error.code:'TASK_RUNTIME_FAILURE';return action?await finish(action,false,code):fail(code);}
    finally{clearTimeout(deadlineTimer);active=undefined;busy=false;}
  }
  const runtime:CodexTaskRuntime={
    implement:requestedPrompt=>{
      const promptRef={id:requestedPrompt.id,sha256:requestedPrompt.sha256};
      return execute('implementation',async action=>{
      const p=action.prepared;
      const decide=(intent:StartupIntent,phase:PhaseAdmission['phase'],owned?:Parameters<typeof ownershipHash>[0],observationHash?:string)=>({authorized:!cancelled&&!deadlineExpired,authorizationRef:options.authorization.authorizationId,admission:admission(action,intent,phase,owned,observationHash)});
      const adapter=(deps.makeAdapter??createCodexAdapter)({supervisor:supervisor(action),executable:p.runtime.path,binaryHash:p.runtime.sha256,runtimeVersion:p.runtime.version,env:p.env,mcpServerIds:p.mcpServerIds,shellEnvironmentPolicy:shellPolicy(p),sqliteHome:p.privateState,startupContext:p.context,onDiagnostic:fact=>protocolDiagnostic(action,fact),
        loadArtifact:async ref=>{const stored=options.store.loadArtifact(ref.id);if(!stored.ok||stored.value.runId!==options.owner.runId||stored.value.sha256!==ref.sha256)throw new StageFailure('INVALID_ARTIFACT');return await readFile(join(options.store.root,'artifacts',ref.sha256),'utf8');},
        authorizeStartup:async request=>{
          if(request.kind!=='user-task'||request.taskHash!==options.authorization.taskHash||request.authorizationId!==options.authorization.authorizationId||!await unchanged(p))return {authorized:false,authorizationRef:options.authorization.authorizationId};
          const approval=decide(request.intent,'BOOTSTRAP');saveIntent(action,{...request.launch,launchNotAfter:Math.min(request.launch.deadline,request.intent.expiresAt,approval.admission.expiresAt)});return approval;
        },
        authorizePreThread:async request=>{
          if(!await unchanged(p))return {authorized:false,authorizationRef:options.authorization.authorizationId};
          const assessment={permissions:compareCodexControlHashes(codexRequestedPermissionsHash(action.profile),request.config.selectedPermissionsHash),environment:compareCodexControlHashes(codexRequestedEnvironmentHash(shellPolicy(p)),request.config.shellEnvironmentPolicyHash),state:compareCodexControlHashes(digest(p.privateState),request.config.sqliteHomeHash)};
          protocolDiagnostic(action,{kind:'effective_policy',stage:'PRE_THREAD_AUTH',assessment});
          if(assessment.permissions.result!=='MATCH'){action.code='EFFECTIVE_PERMISSIONS_MISMATCH';return {authorized:false,authorizationRef:options.authorization.authorizationId};}
          if(assessment.environment.result!=='MATCH'){action.code='EFFECTIVE_ENVIRONMENT_MISMATCH';return {authorized:false,authorizationRef:options.authorization.authorizationId};}
          if(assessment.state.result!=='MATCH'){action.code='EFFECTIVE_STATE_MISMATCH';return {authorized:false,authorizationRef:options.authorization.authorizationId};}
          return decide(request.intent,'PRE_THREAD',request.ownership,request.observationHash);
        },
        authorizeObserved:async request=>{if(!await unchanged(p))return {authorized:false,authorizationRef:options.authorization.authorizationId};return decide(request.intent,'TURN',request.ownership,request.observedFingerprint);},
      });
      const filesystem=action.profile.filesystem as Record<string,string>;
      const readRoots=Object.entries(filesystem).filter(([path,mode])=>path!==':minimal'&&mode!=='deny').map(([path])=>path);
      const command={id:'controller-verification',executable:p.node.path,argv:['--version'],cwd:options.workspaceRoot,environment:{},approvedEnvironmentKeys:[],timeoutMs:1000,inputScope:[options.workspaceRoot],permittedOutputs:[],expectedExit:0};
      const started=await adapter.start({owner:{runId:options.owner.runId,generation:options.owner.generation,actionId:action.id,role:action.role},actionId:action.id,workspaceRoot:options.workspaceRoot,promptRef:{id:promptRef.id,sha256:promptRef.sha256},contextRefs:[],model:options.model,effort:options.effort,mode:'IMPLEMENT',authorization:options.authorization,boundary:{platform:'windows',readRoots,writeRoots:Object.entries(filesystem).filter(([,mode])=>mode==='write').map(([path])=>path),deniedSensitiveRoots:Object.entries(filesystem).filter(([,mode])=>mode==='deny').map(([path])=>path),network:{allowedDomains:[],deniedDomains:[]},verifier:{executable:p.runtime.path,runtimePath:p.runtime.path,version:p.runtime.version,sha256:p.runtime.sha256,settingsPath:join(options.store.root,'task-policy'),settingsHash:digest(action.profile)},registry:[command],runId:options.owner.runId,generation:options.owner.generation,actionId:action.id,role:action.role,leaseTtlMs:10000,deadline:options.deadline}});
      if(!started.ok)return {ok:false,code:action.code==='PROVIDER_DISPATCH_FAILED'?started.error.code:action.code};
      action.session=started.value;if(cancelled){await stop(action);return {ok:false,code:'CANCELLED'};}
      let completed=false;let failure:string|undefined;
      for await(const event of started.value.events){
        if(event.runId!==options.owner.runId||event.generation!==options.owner.generation||event.actionId!==action.id||event.sessionId!==started.value.sessionId)continue;
        try{options.onEvent?.(event);}catch{/* Presentation cannot change task authority. */}
        if(event.type==='auth_error'||event.type==='quota_error'||event.type==='diagnostic'&&event.code!=='PROVIDER_STREAM_RETRYING')failure=event.code;
        if(event.type==='turn_completed'){completed=true;break;}
      }
      return {ok:completed&&!failure,code:failure??(completed?'IMPLEMENTED':'TURN_COMPLETION_UNPROVEN')};
      });
    },
    verify:requestedCommand=>{
      const command={executable:requestedCommand.executable,argv:[...requestedCommand.argv],timeoutMs:requestedCommand.timeoutMs};
      if(!absolute(command.executable)||!Array.isArray(command.argv)||command.argv.length>128||command.argv.some(arg=>typeof arg!=='string'||arg.includes('\0'))||!Number.isSafeInteger(command.timeoutMs)||command.timeoutMs<1||command.timeoutMs>300000||/^(?:cmd|powershell|pwsh|bash|sh|zsh)(?:\.exe)?$/i.test(win32.basename(command.executable)))return Promise.resolve(fail('VERIFIER_COMMAND_INVALID'));
      if(fixedCommand&&digest(fixedCommand)!==digest(command))return Promise.resolve(fail('VERIFIER_COMMAND_CHANGED'));
      fixedCommand??=command;
      return execute('verifier',async action=>{
        // An unpredictable action-specific name avoids recursively inheriting an
        // existing user/project profile with a predictable verifier identifier.
        const name='ouroboros_verifier_'+action.id.replaceAll('-','');
        await observeVerifierPolicy(action,name);
        const p=action.prepared;const commandExecutable=p.identities.find(pin=>pin.requested===command.executable)?.path;
        if(!commandExecutable)return {ok:false,code:'VERIFIER_IDENTITY_NOT_CAPTURED'};
        const commandArgv=win32.normalize(commandExecutable).toLowerCase()===win32.normalize(p.node.path).toLowerCase()?['--preserve-symlinks','--preserve-symlinks-main',...command.argv]:command.argv;
        const config=buildCodexLaunchConfig({entryPoint:'verifier',schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name},overrides:restrictedCodexOverrides({profileName:name,profile:action.profile as any,defaultPermissions:false,mcpServerIds:p.mcpServerIds,shellEnvironmentPolicy:shellPolicy(p),sqliteHome:p.privateState})},verifier:{cwd:options.workspaceRoot,command:[commandExecutable,...commandArgv]}});
        if(!config.ok)return {ok:false,code:config.error.code};
        const spec:LaunchSpec={runId:options.owner.runId,generation:options.owner.generation,actionId:action.id,role:action.role,executable:p.runtime.path,argv:config.value.argv,cwd:options.workspaceRoot,env:p.env,boundaryHash:digest(action.profile),authorization:options.authorization,stdin:'closed',leaseTtlMs:10000,launchNotAfter:Math.min(options.deadline,Date.now()+30000),deadline:Math.min(options.deadline,Date.now()+command.timeoutMs)};
        spec.launchNotAfter=Math.min(spec.launchNotAfter!,spec.deadline);saveIntent(action,spec);
        const launched=await supervisor(action).launchOwned(spec);if(!launched.ok)return {ok:false,code:launched.error.code};
        if(!launched.value.waitForDrain)return {ok:false,code:'NATURAL_COMPLETION_UNAVAILABLE'};
        let sequence=0;const lease=setInterval(()=>{void launched.value.renewLease(++sequence).catch(()=>{void stop(action).catch(()=>{});});},2000);
        try{action.drain=await bounded(launched.value.waitForDrain(),Math.max(1,spec.deadline-Date.now()+5000),'VERIFIER_DEADLINE_EXPIRED');}
        finally{clearInterval(lease);}
        const d=action.drain;return {ok:validDrain(action,d)&&d.reason==='root_exit'&&'rootExitCode' in d&&d.rootExitCode===0,code:d.reason==='root_exit'&&'rootExitCode' in d&&d.rootExitCode===0?'VERIFIED':'VERIFIER_FAILED'};
      },command);
    },
    cancel:async()=>{cancelled=true;if(active){active.abort?.();await stop(active);}},
  };
  options.signal?.addEventListener('abort',()=>{void runtime.cancel().catch(()=>{});},{once:true});
  return runtime;
}
