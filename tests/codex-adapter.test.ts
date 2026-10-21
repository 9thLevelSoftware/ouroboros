import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCodexAdapter, projectCodexThreadSettings, codexThreadSettingsSafe } from '../src/providers/codex/adapter.ts';
import { CodexTransport, JsonlDecoder } from '../src/providers/codex/transport.ts';
import { prevalidateCodexLaunchArgv, CODEX_CONFIG_SCHEMA } from '../src/providers/codex/launch-config.ts';
import type { ChildOutput, OwnedExecution, Supervisor } from '../src/contracts/execution.ts';
import type { BoundaryProfile } from '../src/runtime/command-boundary.ts';
import { startupContext, approval, admittedStartup, admittedPreThread, admittedTurn } from './helpers/codex-admission.ts';
import { ownershipHash, ORDINARY_STARTUP_EFFECTS, startupTargetHash } from '../src/qualification/codex-startup-authority.ts';

const owner={runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'22222222-2222-4222-8222-222222222222',role:'implementation'};
const binaryHash='dd13bdb162a184fa04039488b234a8258ef9b76f84e926c505d5742b19249a6a';
function input() {
  const command={id:'check',executable:'C:\\Windows\\System32\\whoami.exe',argv:[],cwd:'C:\\work',environment:{},approvedEnvironmentKeys:[],timeoutMs:1000,inputScope:['C:\\work'],permittedOutputs:['C:\\work'],expectedExit:0};
  const policy={platform:'windows' as const,readRoots:['C:\\work'],writeRoots:['C:\\work'],deniedSensitiveRoots:['C:\\controller'],network:{allowedDomains:[],deniedDomains:['*']},verifier:{executable:'C:\\trusted\\codex.exe',runtimePath:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:binaryHash,settingsPath:'C:\\controller\\policy.toml',settingsHash:'c'.repeat(64)},registry:[command]};
  const boundary:BoundaryProfile={...policy,...owner,leaseTtlMs:10000,deadline:Date.now()+10000,qualification:{environment:'windows',qualificationRef:'fixture-boundary',runtimeVersion:'0.162.1',runtimeHash:binaryHash,policyHash:createHash('sha256').update(JSON.stringify(policy)).digest('hex'),seccompUnixSockets:false,inheritedDescriptorsRestricted:true}};
  return {owner,actionId:owner.actionId,workspaceRoot:'C:\\work',promptRef:{id:owner.runId,sha256:createHash('sha256').update('bounded fixture prompt').digest('hex')},contextRefs:[],model:'fixture-model',effort:'high',boundary,authorization:{kind:'qualified' as const,qualificationRef:'fixture-boundary'},mode:'IMPLEMENT' as const};
}
class Fixture implements OwnedExecution {
  listeners=new Set<(value:ChildOutput)=>void>();frames:any[]=[];order:string[]=[];launches:any[]=[];drains=0;
  source='chatgpt';provider='openai';profile='ouroboros_worker';settings=true;pages=0;quota=false;missingControl=false;endpoint:unknown='https://chatgpt.com/backend-api/';requiredEndpoint:unknown=undefined;
  push(value:unknown){const bytes=Buffer.from(JSON.stringify(value)+'\n');for(const listener of this.listeners)listener({stream:'stdout',data:bytes});}
  async describe(){this.order.push('inventory');return {schemaVersion:1,...owner,environment:'windows' as const,pid:10,creationIdentity:'pid10',helperPid:11,helperCreationIdentity:'pid11',jobIdentity:'job',boundaryHash:input().boundary.qualification.policyHash,assignedBeforeResume:true as const,capturedAt:Date.now()};}
  async fence(){this.order.push('fence');}
  async renewLease(_sequence:number){this.order.push('lease');}
  async drain(reason:string){this.drains++;this.order.push('drain');const t=Date.now();return {schemaVersion:1 as const,...owner,reason,requestAcknowledged:true,requestedAt:t,acknowledgedAt:t,rootExited:true,rootExitedAt:t,membershipEmpty:true,membershipObservedAt:t,activeProcesses:0,unresolvedExecutions:[],outputComplete:true,unresolvedOutputStreams:[],outputCompletedAt:t,childRanBeforeAssignment:false as const,completedAt:t};}
  onOutput(listener:(value:ChildOutput)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  async endInput(){return {ok:true as const,value:undefined};}
  async writeInput(bytes:Uint8Array){const frame=JSON.parse(Buffer.from(bytes).toString());this.frames.push(frame);this.order.push(frame.method??'response');
    let result:any;
    switch(frame.method){
      case 'initialize':result={userAgent:'codex/0.162.1',codexHome:'C:\\runtime',platformFamily:'windows',platformOs:'windows'};break;
      case 'account/read':result={account:{type:this.source,email:'private@example.test',planType:'plus'},requiresOpenaiAuth:true};break;
      case 'config/read':result={config:{model_provider:this.provider,chatgpt_base_url:this.endpoint,default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{apps:false,hooks:false},web_search:'disabled',mcp_servers:{},model_providers:{}},origins:{},layers:null};break;
      case 'configRequirements/read':result={requirements:{featureRequirements:this.missingControl?{}:{plugins:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:false},modelProviders:null,...(this.requiredEndpoint===undefined?{}:{chatgptBaseUrl:this.requiredEndpoint})},supportsIndependentSpeedModes:false};break;
      case 'model/list':this.pages++;result={data:frame.params.cursor?[{id:'fixture-model',model:'fixture-model',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'high',description:'fixture'}]}]:[],nextCursor:frame.params.cursor?null:'page2'};break;
      case 'thread/start':case 'thread/resume':result={thread:{id:'thread-1'},model:'fixture-model',modelProvider:this.provider,cwd:'C:\\work',approvalPolicy:'on-request',approvalsReviewer:'user',reasoningEffort:'high',activePermissionProfile:this.settings?{id:this.profile,extends:null}:null,sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
        break;
      case 'turn/start':if(this.quota){this.push({id:frame.id,error:{code:-32000,message:'secret quota detail'}});return {ok:true as const,value:undefined};}result={turn:{id:'turn-1',status:'inProgress'}};break;
      case 'turn/interrupt':result={};break;
      default:return {ok:true as const,value:undefined};
    }
    this.push({id:frame.id,result});return {ok:true as const,value:undefined};
  }
}
function fixtureAdapter(fixture=new Fixture(),qualify=true){const supervisor:Supervisor={async launchOwned(spec){fixture.launches.push(spec);return {ok:true,value:fixture};}};return {fixture,adapter:createCodexAdapter({startupContext,authorizePreThread:admittedPreThread,supervisor,executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:admittedStartup,authorizeObserved:async request=>({authorized:qualify,authorizationRef:'fixture-observed',admission:approval(request,'TURN')}),requestTimeoutMs:50})};}
async function session(fixture=new Fixture()){const pair=fixtureAdapter(fixture);const result=await pair.adapter.start(input());expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);return {fixture,...result.value};}

describe('pinned Codex adapter fixtures',()=>{
  it('binds initial model and effort in the launch configuration used by the actual response',async()=>{const f=new Fixture();const push=f.push.bind(f);f.push=value=>{const frame=value as any;if(frame.result?.thread){const parsed=prevalidateCodexLaunchArgv({entryPoint:'worker',schema:CODEX_CONFIG_SCHEMA,argv:f.launches[0].argv});if(!parsed.ok)throw Error('Invalid simulated argv');frame.result.reasoningEffort=parsed.value.configuration.model_reasoning_effort??null;expect(parsed.value.configuration.model).toBe('fixture-model');}push(frame);};const result=await fixtureAdapter(f).adapter.start(input());expect(result.ok).toBe(true);if(result.ok)await result.value.close();});
  it('sixty second initialization allowance admits a forty second cold backfill and remains capped',async()=>{vi.useFakeTimers();const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{if(JSON.parse(Buffer.from(bytes).toString()).method==='initialize'){setTimeout(()=>void write(bytes),40000);return {ok:true,value:undefined};}return write(bytes);};const transport=new CodexTransport(f,{timeoutMs:5000,initializationTimeoutMs:60000});try{const result=transport.initialize().then(()=>true,()=>false);await vi.advanceTimersByTimeAsync(40001);expect(await result).toBe(true);expect(()=>new CodexTransport(f,{initializationTimeoutMs:60001})).toThrow('Invalid initialization timeout');}finally{transport.stop();vi.useRealTimers();}});
  it('cold initialization uses its separate finite allowance while ordinary RPC deadlines remain short',async()=>{vi.useFakeTimers();const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='initialize'){setTimeout(()=>void write(bytes),6000);return {ok:true,value:undefined};}if(frame.method==='account/read')return {ok:true,value:undefined};return write(bytes);};const transport=new CodexTransport(f,{timeoutMs:1000,initializationTimeoutMs:10000});try{const startup=transport.initialize().then(()=>true,()=>false);await vi.advanceTimersByTimeAsync(6001);expect(await startup).toBe(true);const stalled=transport.request('account/read',{refreshToken:false}).then(()=>null,error=>error.fact);await vi.advanceTimersByTimeAsync(1001);expect(await stalled).toEqual({reason:'REQUEST_TIMEOUT',timeoutMs:1000});}finally{transport.stop();vi.useRealTimers();}});
  it('sandbox network compatibility equals the exact requested network mode',()=>{const response={thread:{id:'t'},model:'m',modelProvider:'openai',cwd:'C:\\w',approvalPolicy:'on-request',approvalsReviewer:'user',reasoningEffort:'high',activePermissionProfile:{id:'p',extends:null},sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:true,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};const settings=projectCodexThreadSettings(response,{profile:'p',model:'m',effort:'high',cwd:'C:\\w'},'response');expect(codexThreadSettingsSafe(settings,true)).toBe(true);expect(codexThreadSettingsSafe(settings,false)).toBe(false);response.sandbox.networkAccess=false;const offline=projectCodexThreadSettings(response,{profile:'p',model:'m',effort:'high',cwd:'C:\\w'},'response');expect(codexThreadSettingsSafe(offline,false)).toBe(true);expect(codexThreadSettingsSafe(offline,true)).toBe(false);});
  it('uses initial response controls without a fictional initial settings notification',async()=>{const f=new Fixture();const push=f.push.bind(f);f.push=value=>{const frame=value as any;if(frame.method==='thread/settings/updated')return;if(frame.id&&frame.result?.thread)Object.assign(frame.result,{activePermissionProfile:{id:'ouroboros_worker',extends:null},sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});push(frame);};const result=await fixtureAdapter(f).adapter.start(input());expect(result.ok).toBe(true);if(result.ok)await result.value.close();});
  it('serialized packaged endpoint permits the checked worker handshake',async()=>{const s=await session();expect(s.fixture.frames.some(frame=>frame.method==='turn/start')).toBe(true);await s.close();});
  it('initial account notification awaits an authenticated snapshot and later updates invalidate',async()=>{
    const f=new Fixture();const facts:any[]=[];let delivered=false;const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='account/read'&&!delivered){delivered=true;f.push({method:'account/updated',params:{authMode:'chatgpt',planType:'PRIVATE_PLAN'}});}return write(bytes);};
    const adapter=createCodexAdapter({startupContext,supervisor:{launchOwned:async()=>({ok:true,value:f})},executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:admittedStartup,authorizePreThread:admittedPreThread,authorizeObserved:admittedTurn,onDiagnostic:fact=>facts.push(fact)});
    const result=await adapter.start(input());expect(result.ok).toBe(true);expect(facts).toContainEqual({kind:'startup_account_update',stage:'ACCOUNT_READ',count:1});expect(JSON.stringify(facts)).not.toContain('PRIVATE_PLAN');if(!result.ok)return;
    f.push({method:'account/updated',params:{authMode:null}});expect((await result.value.events[Symbol.asyncIterator]().next()).value).toMatchObject({type:'auth_error',code:'AUTHORIZATION_INVALIDATED'});await result.value.close();
  });
  it.each(['bounded','unauthenticated','after-snapshot'])('account startup allowance preserves %s refusal',async fault=>{
    const f=new Fixture();if(fault==='unauthenticated')f.source='apiKey';const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method===(fault==='after-snapshot'?'config/read':'account/read'))for(let n=0;n<(fault==='bounded'?33:1);n++)f.push({method:'account/updated',params:{authMode:'chatgpt'}});return write(bytes);};
    const result=await fixtureAdapter(f).adapter.start(input());expect(result.ok).toBe(false);expect(f.frames.some(frame=>frame.method==='thread/start'||frame.method==='turn/start')).toBe(false);expect(f.drains).toBe(1);
  });
  it.each([['modelProvider/authRecovery/started','PROVIDER_AUTH_RECOVERY_REQUIRED'],['model/rerouted','PROVIDER_MODEL_REROUTED']])('startup %s remains specifically denied',async(method,code)=>{
    const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='account/read')f.push({method,params:{detail:'PRIVATE_ACCOUNT'}});return write(bytes);};expect(await fixtureAdapter(f).adapter.start(input())).toMatchObject({ok:false,error:{code}});expect(f.drains).toBe(1);
  });
  it('account update after the response re-observes account and policy once before thread admission',async()=>{
    const f=new Fixture();let delivered=false;const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='config/read'&&!delivered){delivered=true;await new Promise<void>(resolve=>setImmediate(resolve));f.push({method:'account/updated',params:{authMode:'chatgpt'}});}return write(bytes);};const s=await session(f);expect(f.frames.filter(frame=>frame.method==='account/read')).toHaveLength(2);expect(f.frames.filter(frame=>frame.method==='config/read')).toHaveLength(2);expect(f.frames.filter(frame=>frame.method==='configRequirements/read')).toHaveLength(2);await s.close();
  });
  it.each([1,2])('same-chunk account response then update count %s requires a stable observation',async count=>{
    const f=new Fixture();let delivered=0;const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='account/read'&&delivered<count){delivered++;f.frames.push(frame);const data=Buffer.from(JSON.stringify({id:frame.id,result:{account:{type:'chatgpt'},requiresOpenaiAuth:true}})+'\n'+JSON.stringify({method:'account/updated',params:{authMode:'chatgpt'}})+'\n');for(const listener of f.listeners)listener({stream:'stdout',data});return {ok:true,value:undefined};}return write(bytes);};const result=await fixtureAdapter(f).adapter.start(input());expect(result.ok).toBe(count===1);expect(f.frames.filter(frame=>frame.method==='account/read')).toHaveLength(2);expect(f.frames.filter(frame=>frame.method==='config/read')).toHaveLength(2);expect(f.frames.filter(frame=>frame.method==='configRequirements/read')).toHaveLength(2);if(result.ok)await result.value.close();else {expect(result.error.code).toBe('PROVIDER_STARTUP_ACCOUNT_UNSTABLE');expect(f.frames.some(frame=>frame.method==='thread/start'||frame.method==='turn/start')).toBe(false);}
  });
  it('account change after pre-thread admission refuses prompt dispatch',async()=>{
    const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='model/list')f.push({method:'account/updated',params:{authMode:null}});return write(bytes);};expect(await fixtureAdapter(f).adapter.start(input())).toMatchObject({ok:false,error:{code:'PROVIDER_ACCOUNT_INVALIDATED'}});expect(f.frames.some(frame=>frame.method==='turn/start')).toBe(false);expect(f.drains).toBe(1);
  });
  it('worker negotiates the experimental notification required to observe exact thread settings',async()=>{
    const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='initialize')f.settings=frame.params.capabilities.experimentalApi===true;return write(bytes);};
    const s=await session(f);expect(f.frames[0].params.capabilities.experimentalApi).toBe(true);await s.close();
  });
  it.each([
    ['initialize','INITIALIZE'],['account/read','ACCOUNT_READ'],['config/read','CONFIG_READ'],['configRequirements/read','REQUIREMENTS_READ'],['thread/start','THREAD_START'],['model/list','MODEL_CATALOG'],['turn/start','TURN_START'],
  ])('RPC failure at %s preserves a safe stage and numeric code',async(method,stage)=>{
    const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method===method){f.push({id:frame.id,error:{code:-32600,message:'PRIVATE_RPC_TOKEN',data:{token:'PRIVATE_RPC_TOKEN'}}});return {ok:true,value:undefined};}return write(bytes);};
    const facts:any[]=[];const adapter=createCodexAdapter({startupContext,supervisor:{launchOwned:async()=>({ok:true,value:f})},executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:admittedStartup,authorizePreThread:admittedPreThread,authorizeObserved:admittedTurn,onDiagnostic:fact=>facts.push(fact)});
    const result=await adapter.start(input());expect(result).toMatchObject({ok:false,error:{code:`PROVIDER_${stage}_FAILED`}});expect(facts.at(-1)).toMatchObject({kind:'startup_failure',stage,rpc:{code:-32600,reason:'UNRECOGNIZED'}});expect(JSON.stringify({result,facts})).not.toContain('PRIVATE_RPC_TOKEN');expect(f.drains).toBe(1);
  });
  it('initial configuration warnings permit checked startup while later warnings invalidate',async()=>{
    const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());const result=await write(bytes);if(frame.method==='initialize')f.push({method:'configWarning',params:{summary:'PRIVATE_WARNING'}});return result;};
    const s=await session(f);try{expect(f.frames.some(frame=>frame.method==='config/read')).toBe(true);f.push({method:'configWarning',params:{summary:'PRIVATE_WARNING'}});expect((await s.events[Symbol.asyncIterator]().next()).value).toMatchObject({type:'diagnostic',code:'TOOL_CONFIGURATION_INVALIDATED'});}finally{await s.close();}
  });
  it('initial warning cannot override missing effective controls',async()=>{
    const f=new Fixture();f.missingControl=true;const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());const result=await write(bytes);if(frame.method==='initialize')f.push({method:'configWarning',params:{summary:'PRIVATE_WARNING'}});return result;};
    expect((await fixtureAdapter(f).adapter.start(input())).ok).toBe(false);expect(f.frames.some(frame=>frame.method==='config/read')).toBe(true);expect(f.frames.some(frame=>frame.method==='thread/start')).toBe(false);
  });
  it('startup warning retention is bounded',async()=>{
    const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());const result=await write(bytes);if(frame.method==='initialize')for(let i=0;i<33;i++)f.push({method:'configWarning',params:{summary:'PRIVATE_WARNING'}});return result;};
    expect(await fixtureAdapter(f).adapter.start(input())).toMatchObject({ok:false,error:{code:'PROVIDER_STARTUP_WARNING_LIMIT'}});expect(f.frames.some(frame=>frame.method==='thread/start')).toBe(false);
  });
  it.each(['interrupted','failed','unexpected'])('terminal status %s cannot become successful completion',async status=>{
    const s=await session();s.fixture.push({method:'turn/completed',params:{threadId:s.sessionId,turn:{id:s.turnId,status,error:null}}});
    const event=(await s.events[Symbol.asyncIterator]().next()).value;expect(event.type).toBe('diagnostic');expect(event.code).toMatch(/^PROVIDER_TURN_/);await s.close();expect(s.fixture.drains).toBe(1);
  });
  it.each([false,true])('user-task admission uses its task identity without a fabricated qualification (tampered=%s)',async tampered=>{
    const f=new Fixture();const request:any=input();delete request.boundary.qualification;
    request.authorization={kind:'user-task',authorizationId:'33333333-3333-4333-8333-333333333333',taskHash:'a'.repeat(64)};
    const phases:string[]=[];
    const admit=(phase:string)=>async (observed:any)=>{
      const intent=observed.intent;phases.push(phase);expect(observed.kind).toBe('user-task');expect(observed).not.toHaveProperty('qualificationRef');
      return {authorized:true,authorizationRef:'fixture-user-task',admission:{schemaVersion:2,semantics:'requested-controls-and-observed-policy',phase,
        intentHash:startupTargetHash(intent),owner:intent.owner,issuedAt:intent.issuedAt,expiresAt:intent.expiresAt,argumentsHash:intent.argumentsHash,controlHash:intent.controlHash,
        ordinaryEffects:[...ORDINARY_STARTUP_EFFECTS],budget:{...intent.budget},authorization:{...request.authorization,...(tampered?{taskHash:'b'.repeat(64)}:{})},
        ...(observed.ownership?{ownershipHash:ownershipHash(observed.ownership),observationHash:observed.observationHash??observed.observedFingerprint}:{})}};
    };
    const adapter=createCodexAdapter({startupContext,supervisor:{launchOwned:async spec=>{f.launches.push(spec);return {ok:true,value:f};}},executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:admit('BOOTSTRAP'),authorizePreThread:admit('PRE_THREAD'),authorizeObserved:admit('TURN')});
    const result=await adapter.start(request);try{expect(result.ok).toBe(!tampered);expect(phases).toEqual(tampered?['BOOTSTRAP']:['BOOTSTRAP','PRE_THREAD','TURN']);if(tampered)expect(f.launches).toHaveLength(0);}
    finally{if(result.ok)await result.value.close();}
  });
  it('user-task resume is refused before any process launch',async()=>{
    const pair=fixtureAdapter();const request:any=input();request.authorization={kind:'user-task',authorizationId:'33333333-3333-4333-8333-333333333333',taskHash:'a'.repeat(64)};
    request.sessionId='prior-thread';request.reconciliation={priorOwner:{...owner,generation:1},sessionId:'prior-thread',evidenceIds:[owner.runId],priorExecutionDrained:true,outcome:'safe_to_resume'};request.owner={...owner,generation:2};
    expect((await pair.adapter.resume(request)).ok).toBe(false);expect(pair.fixture.launches).toHaveLength(0);
  });
  it('healthy sparse quota updates preserve the active turn',async()=>{
    const s=await session();try{
      s.fixture.push({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:25},secondary:null,planType:null,rateLimitReachedType:null}}});
      expect(s.fixture.drains).toBe(0);
      s.fixture.push({method:'turn/completed',params:{threadId:s.sessionId,turn:{id:s.turnId,status:'completed'}}});
      expect((await s.events[Symbol.asyncIterator]().next()).value.type).toBe('turn_completed');
    }finally{await s.close();}
  });
  it.each(['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_usage_limit_reached'])('reported quota exhaustion %s checkpoints and drains once',async rateLimitReachedType=>{
    const s=await session();s.fixture.push({method:'account/rateLimits/updated',params:{rateLimits:{rateLimitReachedType}}});
    expect((await s.events[Symbol.asyncIterator]().next()).value).toMatchObject({type:'quota_error',code:'PROVIDER_USAGE_LIMIT_EXCEEDED'});
    await s.close();expect(s.fixture.drains).toBe(1);expect(s.fixture.frames.filter(frame=>frame.method==='turn/start')).toHaveLength(1);
  });
  it('bootstrap admission expiry does not truncate an admitted task lifetime',async()=>{
    vi.useFakeTimers();const f=new Fixture();const pair=fixtureAdapter(f);const request=input();request.boundary.deadline=Date.now()+120000;
    try{
      const result=await pair.adapter.start(request);expect(result.ok).toBe(true);if(!result.ok)return;
      try{expect(f.launches[0].deadline).toBe(request.boundary.deadline);await vi.advanceTimersByTimeAsync(30001);expect(f.drains).toBe(0);}
      finally{await result.value.close();}
    }finally{vi.useRealTimers();}
  });
  it('uses supported on-request approvals while refusing escalation',async()=>{
    const f=new Fixture();const write=f.writeInput.bind(f);
    f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(['thread/start','turn/start'].includes(frame.method)&&frame.params.approvalPolicy!=='on-request')throw Error('Retired approval policy');return write(bytes);};
    const s=await session(f);try{expect(f.launches[0].argv).toContain('approval_policy="on-request"');}finally{await s.close();}
  });
  it.each(['plugin','notify','remote'])('conflicting effective %s settings refuse before thread admission',async surface=>{
    const f=new Fixture();const push=f.push.bind(f);f.push=value=>{const frame=value as any;if(frame.result?.config){if(surface==='plugin')frame.result.config.features.plugins=true;if(surface==='notify')frame.result.config.notify=['SECRET'];if(surface==='remote')frame.result.config.features.remote_control=true;}push(frame);};
    const result=await fixtureAdapter(f).adapter.start(input());if(result.ok)await result.value.close();expect(result.ok).toBe(false);expect(f.frames.some(frame=>frame.method==='thread/start')).toBe(false);expect(f.drains).toBe(1);expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('pre-thread denial fences and drains before any thread or prompt',async()=>{
    const f=new Fixture();const adapter=createCodexAdapter({startupContext,supervisor:{launchOwned:async()=>({ok:true,value:f})},executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:admittedStartup,authorizePreThread:async()=>({authorized:false,authorizationRef:'denied'}),authorizeObserved:admittedTurn});
    expect((await adapter.start(input())).ok).toBe(false);expect(f.frames.some(frame=>['thread/start','thread/resume','turn/start'].includes(frame.method))).toBe(false);expect(f.drains).toBe(1);
  });
  it('one adapter never dispatches concurrent or replayed action identities twice',async()=>{
    const p=fixtureAdapter();const request=input();const results=await Promise.all([p.adapter.start(request),p.adapter.start(request)]);
    expect(results.filter(result=>result.ok)).toHaveLength(1);expect(p.fixture.launches).toHaveLength(1);
    for(const result of results)if(result.ok)await result.value.close();expect((await p.adapter.start(request)).ok).toBe(false);expect(p.fixture.launches).toHaveLength(1);
  });
  it.each(['expiry','owner','account','budget'])('rejects %s drift across pre-thread admission before sending thread/start',async drift=>{
    const f=new Fixture();const adapter=createCodexAdapter({startupContext,supervisor:{launchOwned:async()=>({ok:true,value:f})},executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:admittedStartup,
      authorizePreThread:async request=>{const admission=approval(request,'PRE_THREAD');if(drift==='expiry')admission.expiresAt=Date.now();if(drift==='owner')admission.owner={...admission.owner,generation:2};if(drift==='account')f.push({method:'account/updated',params:{account:{email:'SECRET'}}});if(drift==='budget')admission.budget.outputBytes=1;return {authorized:true,authorizationRef:'test',admission};},authorizeObserved:admittedTurn});
    expect((await adapter.start(input())).ok).toBe(false);expect(f.frames.some(frame=>frame.method==='thread/start')).toBe(false);expect(f.drains).toBe(1);
  });
  it('owned kernel identity drift after turn admission prevents the prompt',async()=>{
    const f=new Fixture();let changed=false;const describe=f.describe.bind(f);f.describe=async()=>({...await describe(),creationIdentity:changed?'replacement':'pid10'});
    const adapter=createCodexAdapter({startupContext,supervisor:{launchOwned:async()=>({ok:true,value:f})},executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:admittedStartup,authorizePreThread:admittedPreThread,authorizeObserved:async request=>{changed=true;return admittedTurn(request);}});
    expect((await adapter.start(input())).ok).toBe(false);expect(f.frames.some(frame=>frame.method==='turn/start')).toBe(false);expect(f.drains).toBe(1);
  });
  it('turn admission expiry after model pagination prevents the prompt',async()=>{
    const f=new Fixture();const original=f.writeInput.bind(f);let clock=Date.now();const spy=vi.spyOn(Date,'now').mockImplementation(()=>clock);
    f.writeInput=async bytes=>{const result=await original(bytes);if(JSON.parse(Buffer.from(bytes).toString()).method==='model/list')clock+=10000;return result;};
    try{expect((await fixtureAdapter(f).adapter.start(input())).ok).toBe(false);expect(f.frames.some(frame=>frame.method==='turn/start')).toBe(false);expect(f.drains).toBe(1);}finally{spy.mockRestore();}
  });
  it('bare startup approval cannot authorize an unassessed bootstrap',async()=>{
    const f=new Fixture();const adapter=createCodexAdapter({startupContext,authorizePreThread:admittedPreThread,supervisor:{launchOwned:async(spec)=>{f.launches.push(spec);return {ok:true,value:f};}},executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:async()=>({authorized:true,authorizationRef:'bare-assertion'}),authorizeObserved:async()=>({authorized:true,authorizationRef:'bare-assertion'})});
    const result=await adapter.start(input());if(result.ok)await result.value.close();
    expect(result.ok).toBe(false);expect(f.launches).toHaveLength(0);
  });
  it('an account invalidation across configuration observation prevents thread creation',async()=>{
    const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{if(JSON.parse(Buffer.from(bytes).toString()).method==='configRequirements/read')f.push({method:'account/updated',params:{authMode:null}});return write(bytes);};
    const result=await fixtureAdapter(f).adapter.start(input());if(result.ok)await result.value.close();
    expect(result.ok).toBe(false);expect(f.frames.some(frame=>frame.method==='thread/start')).toBe(false);expect(f.drains).toBe(1);
  });
  it('config_requirements_request_omits_params_as_the_pinned_union_requires',async()=>{const s=await session();expect(s.fixture.frames.find(frame=>frame.method==='configRequirements/read')).not.toHaveProperty('params');await s.close();});
  it('initialization_order_and_request_correlation',async()=>{const s=await session();expect(s.fixture.frames.slice(0,3).map(f=>f.method)).toEqual(['initialize','initialized','account/read']);expect(s.fixture.pages).toBe(2);expect(s.fixture.frames.find(f=>f.method==='account/read').params).toEqual({refreshToken:false});expect(s.fixture.frames.find(f=>f.method==='turn/start').params.threadId).toBe('thread-1');expect(s.fixture.launches[0].stdin).toBe('pipe');expect(s.fixture.launches[0].argv).toContain('--strict-config');expect(s.fixture.launches[0].argv).toContain('windows.sandbox="mxc"');expect(s.fixture.launches[0].argv).not.toContain('--profile');await s.close();});
  it('late_generation_event_cannot_mutate_run',async()=>{const s=await session();const event=s.events[Symbol.asyncIterator]();await s.close();s.fixture.push({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});expect(await event.next()).toEqual({done:true,value:undefined});});
  it('turn_complete_is_not_ready',async()=>{const run={phase:'IMPLEMENTING'};const s=await session();const event=s.events[Symbol.asyncIterator]();s.fixture.push({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});expect((await event.next()).value.type).toBe('turn_completed');expect(run.phase).not.toBe('READY_FOR_REVIEW');expect((await s.inspectExecution()).complete).toBe(false);await s.close();});
  it('auth_or_quota_never_falls_back',async()=>{let paidFallbackCalls=0;const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{paidFallbackCalls++;throw Error('Unauthorized API fallback');});try{for(const source of ['apiKey','amazonBedrock']){const f=new Fixture();f.source=source;const p=fixtureAdapter(f);const result=await p.adapter.start(input());expect(result.ok).toBe(false);expect(f.frames.some(v=>v.method==='model/list'||v.method==='turn/start')).toBe(false);expect(f.drains).toBe(1);}const f=new Fixture();f.quota=true;expect((await fixtureAdapter(f).adapter.start(input())).ok).toBe(false);expect(paidFallbackCalls).toBe(0);expect(f.frames.filter(v=>v.method==='turn/start')).toHaveLength(1);expect(f.launches).toHaveLength(1);}finally{network.mockRestore();}});
  it('mandatory_external_controls_and_managed_restrictions_precede_model_catalog',async()=>{for(const kind of ['resolver','managed']){const f=new Fixture();f.missingControl=kind==='managed';const p=fixtureAdapter(f,kind!=='resolver');expect((await p.adapter.start(input())).ok).toBe(false);expect(f.frames.some(v=>v.method==='model/list')).toBe(false);expect(f.drains).toBe(1);}});
  it('wrong_profile_absent_settings_and_provider_are_rejected',async()=>{for(const kind of ['profile','settings','provider']){const f=new Fixture();if(kind==='profile')f.profile='unsafe';if(kind==='settings')f.settings=false;if(kind==='provider')f.provider='custom';expect((await fixtureAdapter(f).adapter.start(input())).ok).toBe(false);expect(f.frames.some(v=>v.method==='turn/start')).toBe(false);}});
  it('foreign_turn_events_are_ignored_and_unknown_requests_are_denied',async()=>{const s=await session();const events=s.events[Symbol.asyncIterator]();s.fixture.push({method:'turn/completed',params:{threadId:'other',turn:{id:'turn-1'}}});s.fixture.push({id:999,method:'unknown/grant',params:{}});const event=(await events.next()).value;expect(event.type).toBe('approval');expect(event.decision).toBe('deny');expect(s.fixture.frames.at(-1)).toEqual({id:999,error:{code:-32601,message:'Unsupported server request'}});await s.close();});
  it('interrupt_ack_is_not_drainage_and_inventory_precedes_drain',async()=>{const s=await session();s.fixture.push({method:'item/commandExecution/terminalInteraction',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1',processId:'proc-1',stdin:'SECRET'}});const receipt=await s.interrupt();expect(receipt.acknowledged).toBe(true);expect(receipt.inventory.complete).toBe(false);expect(receipt.inventory.observed).toContainEqual({kind:'terminal',id:'proc-1',status:'observed'});expect(s.fixture.order.indexOf('turn/interrupt')).toBeLessThan(s.fixture.order.indexOf('fence'));expect(s.fixture.order.lastIndexOf('inventory')).toBeLessThan(s.fixture.order.indexOf('drain'));expect(receipt.drain.outputComplete).toBe(true);expect(s.fixture.frames.find(v=>v.method==='turn/interrupt').params).toEqual({threadId:'thread-1',turnId:'turn-1'});});
  it('reflect_and_resume_without_reconciliation_never_launch',async()=>{const p=fixtureAdapter();expect((await p.adapter.start({...input(),mode:'REFLECT'})).ok).toBe(false);expect((await p.adapter.resume({...input(),sessionId:'thread-1',reconciliation:{}} as any)).ok).toBe(false);expect(p.fixture.launches).toHaveLength(0);expect((await p.adapter.inspect()).capabilities.execution.status).toBe('UNQUALIFIED');});
  it('changed_boundary_identity_or_runtime_never_launch',async()=>{for(const changed of [{...input(),actionId:'wrong'},{...input(),workspaceRoot:'C:\\controller'},{...input(),boundary:{...input().boundary,verifier:{...input().boundary.verifier,sha256:'f'.repeat(64)}}}]){const p=fixtureAdapter();expect((await p.adapter.start(changed)).ok).toBe(false);expect(p.fixture.launches).toHaveLength(0);}});
  it('startup_denial_cannot_be_repaired_by_postlaunch_observation',async()=>{const f=new Fixture();const adapter=createCodexAdapter({startupContext,authorizePreThread:admittedPreThread,supervisor:{launchOwned:async(spec)=>{f.launches.push(spec);return {ok:true,value:f};}},executable:'C:\\trusted\\codex.exe',binaryHash,env:{},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:async()=>({authorized:false,authorizationRef:'denied'}),authorizeObserved:async()=>({authorized:true,authorizationRef:'irrelevant'})});expect((await adapter.start(input())).ok).toBe(false);expect(f.launches).toHaveLength(0);});
  it('explicit_disposable_probe_needs_no_prior_qualification_but_does_not_upgrade_status',async()=>{const p=fixtureAdapter();const base=input();const {qualification,...policy}=base.boundary;const result=await p.adapter.start({...base,boundary:policy,authorization:{kind:'qualification',requestId:owner.runId,probeId:'fixture-probe',fixtureRoots:['C:\\work']}});expect(result.ok).toBe(true);expect((await p.adapter.inspect()).capabilities.execution.status).toBe('UNQUALIFIED');if(result.ok)await result.value.close();const denied=fixtureAdapter();expect((await denied.adapter.start({...base,boundary:policy,authorization:{kind:'qualification',requestId:owner.runId,probeId:'fixture-probe',fixtureRoots:['C:\\other']}})).ok).toBe(false);expect(denied.fixture.launches).toHaveLength(0);});
  it('later_profile_change_invalidates_dispatch_and_preserves_diagnostic',async()=>{const s=await session();s.fixture.push({method:'thread/settings/updated',params:{threadId:'thread-1',threadSettings:{activePermissionProfile:{id:'unsafe',extends:null},modelProvider:'openai',model:'fixture-model',cwd:'C:\\work',approvalPolicy:'on-request',approvalsReviewer:'user'}}});const event=await s.events[Symbol.asyncIterator]().next();expect(event.value.code).toBe('AUTHORIZATION_INVALIDATED');await s.close();expect(s.fixture.drains).toBe(1);});
  it('tampered_artifact_or_api_environment_never_launch',async()=>{const p=fixtureAdapter();expect((await p.adapter.start({...input(),promptRef:{id:owner.runId,sha256:'f'.repeat(64)}})).ok).toBe(false);expect(p.fixture.launches).toHaveLength(0);const f=new Fixture();const adapter=createCodexAdapter({startupContext,authorizePreThread:admittedPreThread,supervisor:{launchOwned:async(spec)=>{f.launches.push(spec);return {ok:true,value:f};}},executable:'C:\\trusted\\codex.exe',binaryHash,env:{OPENAI_API_KEY:'SENTINEL'},loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:async()=>({authorized:true,authorizationRef:'fixture'}),authorizeObserved:async()=>({authorized:true,authorizationRef:'fixture'})});const result=await adapter.start(input());expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('SENTINEL');expect(f.launches).toHaveLength(0);});
  it('bounded_event_queue_stops_the_owned_producer',async()=>{const s=await session();for(let i=0;i<257;i++)s.fixture.push({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});await s.close();expect(s.fixture.drains).toBe(1);});
  it('interrupt_respects_identity_bound_stdin_fence',async()=>{const f=new Fixture();let fenced=false;const original=f.writeInput.bind(f);f.fence=async()=>{fenced=true;f.order.push('fence');};f.writeInput=async(bytes)=>fenced?{ok:false,error:{code:'INPUT_CLOSED',message:'Owned stdin is fenced',evidenceIds:[]}}:await original(bytes);const s=await session(f);const receipt=await s.interrupt();expect(receipt.acknowledged).toBe(true);expect(f.order.indexOf('turn/interrupt')).toBeLessThan(f.order.indexOf('fence'));expect(f.order.lastIndexOf('inventory')).toBeLessThan(f.order.indexOf('fence'));expect(receipt.inventory.complete).toBe(false);expect(receipt.drain.outputComplete).toBe(true);});
  it('missing_response_profile_settles_and_attempts_drain',async()=>{const f=new Fixture();f.settings=false;f.fence=async()=>{throw Error('Fence acknowledgement lost');};const original=f.writeInput.bind(f);f.writeInput=async(bytes)=>{const result=await original(bytes);if(JSON.parse(Buffer.from(bytes).toString()).method==='thread/start')setTimeout(()=>{for(const listener of f.listeners)listener({stream:'stdout',data:Buffer.from([0xff,10])});},0);return result;};const result=await Promise.race([fixtureAdapter(f).adapter.start(input()),new Promise(resolve=>setTimeout(()=>resolve('HUNG'),200))]);expect(result).not.toBe('HUNG');expect((result as any).ok).toBe(false);expect(f.drains).toBe(1);});
});
describe('bounded JSONL and transport',()=>{
  function remoteMetadataFixture(){
    const f=new Fixture();f.writeInput=async(bytes)=>{const frame=JSON.parse(Buffer.from(bytes).toString());f.frames.push(frame);if(frame.id)f.push({id:frame.id,result:frame.method==='initialize'?{userAgent:'codex/0.162.1',codexHome:'C:\\fixture\\home',platformFamily:'windows',platformOs:'windows'}:frame.method==='account/read'?{account:null,requiresOpenaiAuth:true}:frame.method==='config/read'?{config:{},origins:{},layers:null}:{requirements:null}});return {ok:true,value:undefined};};
    const transport=new CodexTransport(f,{timeoutMs:50,metadata:{cwd:'C:\\fixture',clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222'}});
    return {f,transport,params:{status:'disabled',serverName:'PRIVATE_SERVER',installationId:'PRIVATE_INSTALLATION',environmentId:null}};
  }
  it('metadata transport accepts source-shaped disabled remote status without retaining identities or expanding outbound frames',async()=>{
    const {f,transport,params}=remoteMetadataFixture(),messages:unknown[]=[];transport.onMessage(message=>messages.push(message));
    try{await transport.initialize();for(let n=0;n<32;n++)f.push({method:'remoteControl/status/changed',params});await transport.request('account/read',{refreshToken:false});await transport.request('config/read',{includeLayers:false,cwd:'C:\\fixture'});await transport.request('configRequirements/read',undefined);transport.fence();f.push({method:'remoteControl/status/changed',params:{...params,status:'connected'}});expect(transport.metadataEvidence().boundaryFailed).toBe(true);expect(messages).toEqual([]);expect(f.frames.map(frame=>frame.method)).toEqual(['initialize','initialized','account/read','config/read','configRequirements/read']);expect(JSON.stringify(f.frames)).not.toContain('PRIVATE_');}finally{transport.stop();}
  });
  it.each(['connecting','connected','errored',null,'malformed','overflow'] as const)('metadata transport refuses unsafe remote status %s',async status=>{
    const {f,transport,params}=remoteMetadataFixture();try{await transport.initialize();if(status==='overflow')for(let n=0;n<32;n++)f.push({method:'remoteControl/status/changed',params});f.push({method:'remoteControl/status/changed',params:status==='malformed'?{...params,serverName:false}:{...params,status:status==='overflow'?'disabled':status}});await expect(transport.request('account/read',{refreshToken:false})).rejects.toThrow();expect(transport.metadataEvidence().boundaryFailed).toBe(true);expect(f.frames.map(frame=>frame.method)).toEqual(['initialize','initialized']);}finally{transport.stop();}
  });
  it('decodes_fragmented_utf8_and_rejects_oversize_invalid_utf8_and_truncation',()=>{const d=new JsonlDecoder();const bytes=Buffer.from('{"id":1,"result":"é"}\r\n');expect(d.push(bytes.subarray(0,20))).toEqual([]);expect(d.push(bytes.subarray(20))).toEqual([{id:1,result:'é'}]);d.finish();expect(()=>new JsonlDecoder().push(Buffer.alloc(1048577,65))).toThrow();expect(()=>new JsonlDecoder().push(Buffer.from([0xff,10]))).toThrow();const partial=new JsonlDecoder();partial.push(Buffer.from('{'));expect(()=>partial.finish()).toThrow();});
  it('correlates_out_of_order_responses_and_rejects_duplicate_response',async()=>{const f=new Fixture();f.writeInput=async(bytes)=>{f.frames.push(JSON.parse(Buffer.from(bytes).toString()));return {ok:true,value:undefined};};const transport=new CodexTransport(f,{timeoutMs:50});const a=transport.request('account/read',{refreshToken:false});const b=transport.request('model/list',{});for(let i=0;i<8;i++)await Promise.resolve();f.push({id:f.frames[1].id,result:{data:[],nextCursor:null}});f.push({id:f.frames[0].id,result:{account:null,requiresOpenaiAuth:true}});expect((await b).data).toEqual([]);expect((await a).account).toBeNull();f.push({id:f.frames[0].id,result:{}});await expect(transport.request('account/read',{})).rejects.toThrow();transport.stop();});
  it('request_timeout_never_retries_and_output_budget_stops_transport',async()=>{const f=new Fixture();f.writeInput=async()=>({ok:true,value:undefined});const t=new CodexTransport(f,{timeoutMs:10});await expect(t.request('account/read',{})).rejects.toThrow('timeout');t.stop();const out=new Fixture();const limit=new CodexTransport(out,{timeoutMs:10});for(const listener of out.listeners)listener({stream:'stderr',data:Buffer.alloc(10485761)});await expect(limit.request('account/read',{})).rejects.toThrow();limit.stop();});
  it('pending_request_budget_is_finite',async()=>{const f=new Fixture();f.writeInput=async()=>({ok:true,value:undefined});const t=new CodexTransport(f,{timeoutMs:50});const pending=Array.from({length:64},()=>t.request('account/read',{}).catch(()=>undefined));await expect(t.request('account/read',{})).rejects.toThrow('budget');t.stop();await Promise.all(pending);});
  it('large_frames_are_chunked_without_interleaving',async()=>{const f=new Fixture();let buffered='';const chunks:number[]=[];const received:any[]=[];f.writeInput=async(bytes)=>{chunks.push(bytes.length);if(bytes.length>65536)return {ok:false,error:{code:'INPUT_TOO_LARGE',message:'64 KiB cap',evidenceIds:[]}};await new Promise<void>(resolve=>queueMicrotask(resolve));buffered+=Buffer.from(bytes).toString();let end:number;while((end=buffered.indexOf('\n'))>=0){const frame=JSON.parse(buffered.slice(0,end));buffered=buffered.slice(end+1);received.push(frame);f.push({id:frame.id,result:{data:[],nextCursor:null}});}return {ok:true,value:undefined};};const t=new CodexTransport(f,{timeoutMs:50});try{await Promise.all([t.request('model/list',{cursor:'a'.repeat(140000)}),t.request('model/list',{cursor:'b'.repeat(140000)})]);expect(received.map(frame=>frame.params.cursor)).toEqual(['a'.repeat(140000),'b'.repeat(140000)]);expect(Math.max(...chunks)).toBeLessThanOrEqual(65536);expect(buffered).toBe('');const blocked=new Fixture();blocked.writeInput=async()=>await new Promise(()=>{});const budget=new CodexTransport(blocked,{timeoutMs:10});const queued=budget.request('model/list',{cursor:'x'.repeat(800000)}).catch(()=>undefined);await expect(budget.request('model/list',{cursor:'y'.repeat(800000)})).rejects.toThrow();budget.stop();await queued;}finally{t.stop();}});
});

describe('Task 5 scoped review regressions',()=>{
  it('review1_synchronous_startup_invalidation_is_not_discarded',async()=>{
    for(const method of ['hook/started','mcpServer/startupStatus/updated']){
      const f=new Fixture();const subscribe=f.onOutput.bind(f);
      f.onOutput=listener=>{const dispose=subscribe(listener);listener({stream:'stdout',data:Buffer.from(JSON.stringify({method,params:{message:'STARTUP_SECRET'}})+'\n')});return dispose;};
      const result=await fixtureAdapter(f).adapter.start(input());
      try {expect(result.ok).toBe(false);expect(f.frames.some(frame=>frame.method==='model/list'||frame.method==='turn/start')).toBe(false);expect(f.drains).toBe(1);expect(JSON.stringify(result)).not.toContain('STARTUP_SECRET');}
      finally{if(result.ok)await result.value.close();}
    }
  });
  it('review1_startup_notification_retention_is_bounded',async()=>{
    const f=new Fixture();const subscribe=f.onOutput.bind(f);f.onOutput=listener=>{const dispose=subscribe(listener);for(let n=0;n<33;n++)listener({stream:'stdout',data:Buffer.from(JSON.stringify({method:'warning',params:{message:'SECRET'}})+'\n')});return dispose;};
    const transport=new CodexTransport(f,{timeoutMs:50});try{const failures:string[]=[];transport.onFailure(error=>failures.push(error.message));expect([...failures]).toEqual(['Codex startup notification retention budget exhausted']);expect(f.frames).toHaveLength(0);await expect(transport.request('account/read',{})).rejects.toThrow('retention budget');}finally{transport.stop();}
  });
  for(const scenario of [
    {name:'review1_notification_before_response_error_fails_after_drain',method:'error',params:{threadId:'thread-1',turnId:'turn-1',willRetry:false,error:{message:'PRE_RESPONSE_SECRET',additionalDetails:'PRE_RESPONSE_SECRET',codexErrorInfo:'unauthorized',misalignment:null}},code:'PROVIDER_UNAUTHORIZED'},
    {name:'review1_notification_before_response_unexpected_tool_fails_after_drain',method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',startedAtMs:1,item:{id:'item-unknown',type:'mcpToolCall',payload:'PRE_RESPONSE_SECRET'}},code:'UNEXPECTED_TOOL_SURFACE'},
  ])it(scenario.name,async()=>{
    const f=new Fixture();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{if(JSON.parse(Buffer.from(bytes).toString()).method==='turn/start')f.push({method:scenario.method,params:scenario.params});return await write(bytes);};
    let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});let attempting=false;const drain=f.drain.bind(f);f.drain=async reason=>{attempting=true;await barrier;return await drain(reason);};
    let settled=false;const pending=fixtureAdapter(f).adapter.start(input());void pending.then(()=>{settled=true;});
    try{await vi.waitFor(()=>expect(attempting).toBe(true),{interval:1,timeout:100});expect(settled).toBe(false);}
    finally{release();}
    const result=await pending;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe(scenario.code);expect(f.drains).toBe(1);expect(JSON.stringify(result)).not.toContain('PRE_RESPONSE_SECRET');
  });
  const classifications=[
    {discriminant:'unauthorized',type:'auth_error',code:'PROVIDER_UNAUTHORIZED'},
    {discriminant:'usageLimitExceeded',type:'quota_error',code:'PROVIDER_USAGE_LIMIT_EXCEEDED'},
    {discriminant:'rateLimitExceeded',type:'quota_error',code:'PROVIDER_RATE_LIMIT_EXCEEDED'},
    {discriminant:'sessionBudgetExceeded',type:'quota_error',code:'PROVIDER_SESSION_BUDGET_EXCEEDED'},
  ];
  for(const completion of [false,true])it(completion?'review1_failed_completion_auth_quota_are_sanitized_and_foreign_rejected':'review1_correlated_auth_quota_errors_are_sanitized_and_foreign_rejected',async()=>{
    for(const classification of classifications){
      const s=await session();const iterator=s.events[Symbol.asyncIterator]();
      const error={message:'ERROR_SECRET',additionalDetails:'DETAIL_SECRET',codexErrorInfo:classification.discriminant,misalignment:null};
      const notification=(threadId:string,turnId:string)=>completion?{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',error}}}:{method:'error',params:{threadId,turnId,error,willRetry:false}};
      try{
        s.fixture.push(notification('foreign-thread','turn-1'));s.fixture.push(notification('thread-1','foreign-turn'));
        expect(s.fixture.drains).toBe(0);
        s.fixture.push(notification('thread-1','turn-1'));
        const event=(await iterator.next()).value;
        expect(event.type).toBe(classification.type);expect(event.code).toBe(classification.code);expect(event.sessionId).toBe('thread-1');expect(event.turnId).toBe('turn-1');
        expect(JSON.stringify(event)).not.toMatch(/ERROR_SECRET|DETAIL_SECRET/);await s.close();expect(s.fixture.drains).toBe(1);
      }finally{await s.close();}
    }
  });
  it.each([undefined,{type:'dangerFullAccess'},{type:'workspaceWrite',writableRoots:['C:\\SECRET'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true},{type:'workspaceWrite',writableRoots:[],networkAccess:true,excludeTmpdirEnvVar:true,excludeSlashTmp:true}])('refuses missing or incompatible response sandbox %j',async policy=>{const f=new Fixture();const push=f.push.bind(f);f.push=value=>{const frame=value as any;if(frame.result?.thread)frame.result.sandbox=policy;push(frame);};const result=await fixtureAdapter(f).adapter.start(input());expect(result.ok).toBe(false);expect(f.frames.some(f=>f.method==='turn/start')).toBe(false);expect(JSON.stringify(result)).not.toContain('SECRET');});
  it('retryable stream notification continues the same turn to terminal completion',async()=>{const s=await session();s.fixture.push({method:'error',params:{threadId:'thread-1',turnId:'turn-1',willRetry:true,error:{codexErrorInfo:'serverOverloaded',message:'SECRET'}}});s.fixture.push({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});const events=s.events[Symbol.asyncIterator]();expect((await events.next()).value).toMatchObject({type:'diagnostic',code:'PROVIDER_STREAM_RETRYING'});expect((await events.next()).value.type).toBe('turn_completed');expect(s.fixture.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);await s.close();});});

it('informational notification payloads never establish turn completion',async()=>{
  const s=await session();const events=s.events[Symbol.asyncIterator]();s.fixture.push({method:'deprecationNotice',params:{summary:'completed',threadId:'thread-1',turnId:'turn-1',turn:{status:'completed'}}});s.fixture.push({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});expect((await events.next()).value.type).toBe('turn_started');await s.close();expect(s.fixture.drains).toBe(1);
});
