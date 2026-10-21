import { describe, expect, it, vi } from 'vitest';
import type { ChildOutput, OwnedExecution } from '../src/contracts/execution.ts';
import { prepareStartupMetadataInspection, type StartupInput } from '../src/qualification/codex-startup-authority.ts';
import { inspectCodexStartupMetadata, projectStartupMetadata } from '../src/providers/codex/startup-metadata.ts';
import { CodexTransport } from '../src/providers/codex/transport.ts';
import { startupContext, approval } from './helpers/codex-admission.ts';
function startupInput():StartupInput {
  return { schemaVersion:1, phase:'PRE_PROCESS', requestId:'33333333-3333-4333-8333-333333333333',
    owner:{runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'22222222-2222-4222-8222-222222222222',role:'startup-metadata'},
    workspace:'C:\\disposable\\case', configAncestry:['C:\\','C:\\disposable','C:\\disposable\\case'],
    runtime:{path:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:'a'.repeat(64)},
    node:{path:'C:\\trusted\\node.exe',version:'24.19.0',sha256:'b'.repeat(64)},
    helper:{path:'C:\\trusted\\helper.exe',sha256:'c'.repeat(64)}, controllerHash:'d'.repeat(64),protocolHash:'e'.repeat(64),
    environmentHash:'f'.repeat(64),configHash:'1'.repeat(64),boundaryHash:'2'.repeat(64),argumentsHash:'3'.repeat(64), profile:'ouroboros_metadata',sandbox:'mxc',
    environmentKeys:['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'],
    issuedAt:1000,expiresAt:61000,
    expectedExecution:{pid:10,creationIdentity:'root-10',helperPid:11,helperCreationIdentity:'helper-11',jobIdentity:'job-1'} };
}



const SECRET='private-token-https://secret.example.test';
function config(){return {config:{features:{plugins:false,hooks:false,apps:false},notify:[],mcp_servers:{},web_search:'disabled',model_provider:'openai',chatgpt_base_url:'https://chatgpt.com/backend-api/',default_permissions:'ouroboros_metadata',windows:{sandbox:'mxc'},instructions:SECRET,model_providers:{}},origins:{'features.plugins':{name:{type:'system',file:SECRET},version:'v1'}},layers:null};}
function requirements(){return {requirements:{allowRemoteControl:false,allowBrowserAndComputerUse:false,featureRequirements:{plugins:false},modelProviders:null},supportsIndependentSpeedModes:null};}
class Execution implements OwnedExecution {
  listeners=new Set<(value:ChildOutput)=>void>(); frames:any[]=[]; order:string[]=[]; drains=0;fences=0;
  scenario='normal'; input=startupInput();
  endpoint:unknown='https://chatgpt.com/backend-api/';requiredEndpoint:unknown=undefined;
  push(value:unknown){this.raw(Buffer.from(JSON.stringify(value)+'\n'));}
  raw(data:Buffer,stream:'stdout'|'stderr'='stdout'){for(const listener of this.listeners)listener({stream,data});}
  async describe(){this.order.push('describe');if(this.scenario==='describe-hang')return await new Promise<never>(()=>{});if(this.scenario==='describe-error')throw Error(SECRET);return {schemaVersion:1 as const,...this.input.owner,environment:'windows' as const,...this.input.expectedExecution,boundaryHash:'2'.repeat(64),assignedBeforeResume:true as const,capturedAt:1001};}
  async fence(){this.fences++;this.order.push('fence');if(this.scenario==='fence-hang')await new Promise(()=>{});}
  async renewLease(_sequence:number){if(this.scenario==='renew-fail')throw Error(SECRET);}
  async drain(_reason:string){this.drains++;this.order.push('drain');if(this.scenario==='drain-hang')return await new Promise<never>(()=>{});if(this.scenario==='truncated')this.raw(Buffer.from('{'));if(this.scenario==='drain-notification')this.push({method:'late',params:{secret:SECRET}});const t=1005;return {schemaVersion:1 as const,...this.input.owner,reason:SECRET,requestAcknowledged:true,requestedAt:t,acknowledgedAt:t,rootExited:true,rootExitedAt:t,membershipEmpty:true,membershipObservedAt:t,activeProcesses:0,unresolvedExecutions:[],outputComplete:this.scenario!=='incomplete',unresolvedOutputStreams:this.scenario==='incomplete'?['stderr' as const]:[],outputCompletedAt:this.scenario==='incomplete'?null:t,childRanBeforeAssignment:false as const,completedAt:t};}
  onOutput(listener:(value:ChildOutput)=>void){this.listeners.add(listener);if(this.scenario==='early-notification')this.push({method:'startup',params:{secret:SECRET}});return()=>this.listeners.delete(listener);}
  async endInput(){return {ok:true as const,value:undefined};}
  async writeInput(bytes:Uint8Array){const frame=JSON.parse(Buffer.from(bytes).toString());this.frames.push(frame);this.order.push(frame.method);
    if(this.scenario==='renew-fail')await new Promise(resolve=>setTimeout(resolve,10));
    if(this.scenario==='stall')return await new Promise<never>(()=>{});
    if(frame.method==='initialized')return {ok:true as const,value:undefined};
    if(this.scenario==='notification'){this.push({id:9,method:'item/commandExecution/requestApproval',params:{secret:SECRET}});return {ok:true as const,value:undefined};}
    if(this.scenario==='utf8'){this.raw(Buffer.from([255,10]));return {ok:true as const,value:undefined};}
    if(this.scenario==='error'){this.push({id:frame.id,error:{message:SECRET}});return {ok:true as const,value:undefined};}
    if(this.scenario==='oversize'){this.raw(Buffer.alloc(1048577,65));return {ok:true as const,value:undefined};}
    if(this.scenario==='output-limit'){this.raw(Buffer.alloc(10485761,65),'stderr');return {ok:true as const,value:undefined};}
    const result=frame.method==='initialize'?{userAgent:'codex/0.162.1',codexHome:SECRET,platformFamily:'windows',platformOs:'windows'}:frame.method==='account/read'?{account:{type:'chatgpt',email:SECRET,planType:'plus'},requiresOpenaiAuth:true}:frame.method==='config/read'?config():requirements();
    if(frame.method==='config/read')(result as ReturnType<typeof config>).config.chatgpt_base_url=this.endpoint as string;
    if(frame.method==='configRequirements/read'&&this.requiredEndpoint!==undefined)(result as any).requirements.chatgptBaseUrl=this.requiredEndpoint;
    this.push({id:this.scenario==='correlation'?'wrong':frame.id,result});
    if(this.scenario==='duplicate')this.push({id:frame.id,result});
    return {ok:true as const,value:undefined};
  }
}
function binding(){const r=prepareStartupMetadataInspection(startupInput(),1001);if(!r.ok)throw Error('Expected fixture binding');return r.value;}
async function admittedBinding(f:Execution,expiresAt=61000,budget={activeMs:30000,outputBytes:262144,cleanupMs:15000}){
  const {expectedExecution:_,...legacy}=startupInput();
  const intent={...legacy,...startupContext,schemaVersion:2 as const,authMode:'managed-chatgpt' as const,action:'metadata' as const,model:'fixture-model',effort:'high',dispatchHash:'a'.repeat(64),dispatchAuthorization:{kind:'qualification' as const,requestId:legacy.requestId,probeId:'metadata',fixtureRoots:['C:\\disposable']},budget};
  const admission=approval({intent},'BOOTSTRAP');admission.expiresAt=expiresAt;
  const bound=prepareStartupMetadataInspection(intent,1002,{approval:admission,ownership:await f.describe()});if(!bound.ok)throw Error('Expected admitted metadata binding');return bound.value;
}
async function inspect(f=new Execution()){return await inspectCodexStartupMetadata(binding(),f,{now:()=>1002,responseMs:20,activeMs:100,graceMs:20,drainMs:30,renewalMs:5});}
it.each([undefined,null,'https://chatgpt.com/backend-api/'])('terminal metadata accepts only the supported endpoint category %j',async endpoint=>{const f=new Execution();f.endpoint=endpoint;f.requiredEndpoint=endpoint;const result=await inspect(f);expect(result.status).toBe('OBSERVED');expect(f.drains).toBe(1);expect(JSON.stringify(result)).not.toContain('https://');});
it.each(['config','managed'])('terminal metadata rejects %s endpoint overrides without retaining values',async scope=>{const f=new Execution();if(scope==='config')f.endpoint=SECRET;else f.requiredEndpoint=SECRET;const result=await inspect(f);expect(result.code).toBe('METADATA_CONFLICT');expect(f.drains).toBe(1);expect(JSON.stringify(result)).not.toContain(SECRET);});

describe('closed offline metadata exchange',()=>{
  it('shorter metadata admission expiry refuses consumption without protocol bytes',async()=>{
    const f=new Execution();const plan=await admittedBinding(f,1003);
    const result=await inspectCodexStartupMetadata(plan,f,{now:()=>1003});
    expect(result.status).toBe('REFUSED');expect(result.code).toBe('STALE_STARTUP_INPUT');expect(f.frames).toHaveLength(0);
  });
  it('metadata admission expiry during owned observation prevents initialize dispatch',async()=>{
    const f=new Execution();const plan=await admittedBinding(f,1003);let clock=1002;const describe=f.describe.bind(f);
    f.describe=async()=>{clock=1003;return describe();};
    const result=await inspectCodexStartupMetadata(plan,f,{now:()=>clock,responseMs:20,activeMs:100,graceMs:20,drainMs:30,renewalMs:5});
    expect(result.status).toBe('BLOCKED');expect(f.frames).toHaveLength(0);expect(f.drains).toBe(1);
  });
  it.each(['pending-renewal','fence-timeout'])('cleanup %s retains reserved terminal drain dispatch within the admitted budget',async scenario=>{
    const f=new Execution();const plan=await admittedBinding(f,61000,{activeMs:100,outputBytes:262144,cleanupMs:10});
    let renewalStarted!:()=>void;const started=new Promise<void>(resolve=>{renewalStarted=resolve;});
    let lastObservationAt=performance.now();const write=f.writeInput.bind(f);
    f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(scenario==='pending-renewal'&&frame.method==='configRequirements/read')await started;const result=await write(bytes);if(frame.method==='configRequirements/read')lastObservationAt=performance.now();return result;};
    if(scenario==='pending-renewal'){
      f.renewLease=async()=>{renewalStarted();return await new Promise<void>(()=>{});};
    }else f.fence=async()=>{f.fences++;return await new Promise<void>(()=>{});};
    const result=await inspectCodexStartupMetadata(plan,f,{now:()=>1002,responseMs:200,activeMs:500,graceMs:200,drainMs:30,renewalMs:50});
    expect(f.drains).toBe(1);expect(performance.now()-lastObservationAt).toBeLessThan(30);expect(result.status).toBe('BLOCKED');expect(result.drainComplete).toBe(false);
  });
  it('uses a newly admitted non-secret intent and separate owned receipt for a terminal inspection',async()=>{
    const f=new Execution();const {expectedExecution:_,...legacy}=startupInput();
    const intent={...legacy,...startupContext,schemaVersion:2 as const,authMode:'managed-chatgpt' as const,action:'metadata' as const,model:'fixture-model',effort:'high',dispatchHash:'a'.repeat(64),dispatchAuthorization:{kind:'qualification' as const,requestId:legacy.requestId,probeId:'metadata',fixtureRoots:['C:\\disposable']},budget:{activeMs:30000,outputBytes:262144,cleanupMs:15000}};
    const plan=prepareStartupMetadataInspection(intent,1002,{approval:approval({intent},'BOOTSTRAP'),ownership:await f.describe()});expect(plan.ok).toBe(true);if(!plan.ok)throw Error('Expected admitted plan');
    const result=await inspectCodexStartupMetadata(plan.value,f,{now:()=>1002,responseMs:20,activeMs:100,graceMs:20,drainMs:30,renewalMs:5});
    expect(result.status).toBe('OBSERVED');expect(result.workerQualification).toBe('UNQUALIFIED');expect(result.shutdown).toBe('DRAINED');expect(f.frames.some(frame=>frame.method.startsWith('thread/'))).toBe(false);expect(f.drains).toBe(1);
  });
  it('enforces the explicitly admitted metadata output budget before completing observations',async()=>{
    const f=new Execution();const {expectedExecution:_,...legacy}=startupInput();
    const intent={...legacy,...startupContext,schemaVersion:2 as const,authMode:'managed-chatgpt' as const,action:'metadata' as const,model:'fixture-model',effort:'high',dispatchHash:'a'.repeat(64),dispatchAuthorization:{kind:'qualification' as const,requestId:legacy.requestId,probeId:'metadata',fixtureRoots:['C:\\disposable']},budget:{activeMs:100,outputBytes:200,cleanupMs:50}};
    const admission=approval({intent},'BOOTSTRAP');admission.budget=intent.budget;
    const plan=prepareStartupMetadataInspection(intent,1002,{approval:admission,ownership:await f.describe()});expect(plan.ok).toBe(true);if(!plan.ok)throw Error('Expected admitted plan');
    const result=await inspectCodexStartupMetadata(plan.value,f,{now:()=>1002,responseMs:20,activeMs:100,graceMs:20,drainMs:30,renewalMs:5});
    expect(result.status).toBe('BLOCKED');expect(result.protocol.boundaryFailed).toBe(true);expect(f.drains).toBe(1);expect(f.frames.some(frame=>frame.method==='config/read')).toBe(false);
  });
  it('observes managed account without refreshing or retaining an account identifier',async()=>{
    const f=new Execution();const result=await inspect(f);
    expect(f.frames.find(frame=>frame.method==='account/read')).toEqual({id:'ouroboros-2',method:'account/read',params:{refreshToken:false}});
    expect(result).toHaveProperty('account',{mode:'managed-chatgpt',state:'authenticated',requiresOpenaiAuth:true});
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it('writes exactly five messages then fences and drains, returning only safe evidence',async()=>{
    const f=new Execution();const result=await inspect(f);
    expect(result.status).toBe('OBSERVED');expect(result.shutdown).toBe('DRAINED');
    expect(f.frames).toEqual([
      {id:'ouroboros-1',method:'initialize',params:{clientInfo:{name:'ouroboros-qualification-22222222-2222-4222-8222-222222222222',title:'Ouroboros',version:'0.1.0'},capabilities:{experimentalApi:false,requestAttestation:false,explicitGatewayOauth:true}}},
      {method:'initialized'}, {id:'ouroboros-2',method:'account/read',params:{refreshToken:false}}, {id:'ouroboros-3',method:'config/read',params:{includeLayers:false,cwd:'C:\\disposable\\case'}},
      {id:'ouroboros-4',method:'configRequirements/read'}]);
    expect(f.order[0]).toBe('describe');expect(f.fences).toBe(1);expect(f.drains).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);expect(result).not.toHaveProperty('request');expect(result).not.toHaveProperty('execution');
  });
  it('refuses forged, expired, reused or ownership-mismatched bindings before protocol bytes',async()=>{
    const f=new Execution();const forged=await inspectCodexStartupMetadata({kind:'metadata-inspection-plan'} as any,f);
    expect(forged.status).toBe('REFUSED');expect(f.frames).toHaveLength(0);
    const b=binding();const original=await inspectCodexStartupMetadata(b,new Execution(),{now:()=>61000});expect(original.status).toBe('REFUSED');
    const wrong=new Execution();wrong.input.owner.generation=2;const failed=await inspect(wrong);expect(failed.status).toBe('BLOCKED');expect(wrong.frames).toHaveLength(0);expect(wrong.drains).toBe(1);
    const shared=binding();await inspectCodexStartupMetadata(shared,new Execution(),{now:()=>1002});const replay=new Execution();expect((await inspectCodexStartupMetadata(shared,replay,{now:()=>1002})).status).toBe('REFUSED');expect(replay.frames).toHaveLength(0);
  });
  it.each(['notification','early-notification','utf8','error','oversize','output-limit','correlation','duplicate','truncated','drain-notification','stall','renew-fail','describe-error','describe-hang'])('%s fails closed, fences, drains once and never exposes payloads',async scenario=>{
    const f=new Execution();f.scenario=scenario;const result=await inspect(f);
    expect(result.status).toBe('BLOCKED');expect(f.fences).toBe(1);expect(f.drains).toBe(1);
    expect(f.frames.every(frame=>['initialize','initialized','account/read','config/read','configRequirements/read'].includes(frame.method))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it.each(['incomplete','fence-hang','drain-hang'])('%s cannot claim complete shutdown',async scenario=>{
    const f=new Execution();f.scenario=scenario;const result=await inspect(f);expect(result.shutdown).toBe('DRAINING');expect(result.status).toBe('BLOCKED');expect(f.drains).toBe(1);
  });
  it('keeps projection absence/null/false distinct and managed/reload completeness unknown',()=>{
    const p=projectStartupMetadata({config:{features:{plugins:false},notify:null},origins:{},layers:null},{requirements:null,supportsIndependentSpeedModes:null});
    expect(p.ok).toBe(true);if(!p.ok)return;expect(p.value.config.plugins).toBe(false);expect(p.value.config.hooks).toBe('MISSING');expect(p.value.config.notify).toBe('NULL');expect(p.value.requirements.state).toBe('NULL');expect(p.value.managedCompleteness).toBe('UNKNOWN');expect(p.value.reloadSafety).toBe('UNKNOWN');
  });
  it('projects hostile config without hashing secrets or returning arbitrary identifiers',()=>{
    const p=projectStartupMetadata(config(),requirements());expect(p.ok).toBe(true);expect(JSON.stringify(p)).not.toContain(SECRET);expect(JSON.stringify(p)).not.toContain('private');
    const changed=config();changed.config.instructions='different secret';expect(projectStartupMetadata(changed,requirements())).toEqual(p);
    expect(projectStartupMetadata({...config(),origins:{x:{name:{type:'unknown',secret:SECRET},version:SECRET}}},requirements()).ok).toBe(false);
    expect(projectStartupMetadata({config:{mcp_servers:{[SECRET]:{url:SECRET}}},origins:{},layers:null},requirements()).ok).toBe(false);
  });
  it('retains MCP table-merge additions and unsafe policy conflicts as blocked observations',async()=>{
    const f=new Execution();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method!=='config/read')return await write(bytes);f.frames.push(frame);f.push({id:frame.id,result:{...config(),config:{...config().config,mcp_servers:{added_after_preflight:{enabled:true,url:SECRET}}}}});return {ok:true,value:undefined};};
    const result=await inspect(f);expect(result.status).toBe('BLOCKED');expect(result.code).toBe('METADATA_CONFLICT');expect(result.observations?.config.mcpEnabled).toBe(1);expect(JSON.stringify(result)).not.toContain('added_after_preflight');
  });
  it('detects changed root/helper identities after drainage',async()=>{
    const f=new Execution();const drain=f.drain.bind(f);f.drain=async reason=>{const value=await drain(reason);f.input.expectedExecution.helperPid=99;return value;};
    const result=await inspect(f);expect(result.shutdown).toBe('DRAINING');expect(result.drainComplete).toBe(false);
  });
  it('subscription failure before dispatch still fences and drains without exposing exceptions',async()=>{
    const f=new Execution();f.onOutput=()=>{throw Error(SECRET);};const result=await inspect(f);
    expect(result.status).toBe('BLOCKED');expect(result.shutdown).toBe('DRAINING');expect(f.frames).toHaveLength(0);expect(f.fences).toBe(1);expect(f.drains).toBe(1);expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it('review_fix1 settles in-flight renewals before delayed drainage stops accepting controls',async()=>{
    const f=new Execution();const write=f.writeInput.bind(f),drain=f.drain.bind(f);let markStarted!:()=>void;const started=new Promise<void>(resolve=>{markStarted=resolve;});let draining=false,pending=0,controlsAfterDrain=0,pendingAtDrain=-1;
    f.renewLease=async()=>{if(draining){controlsAfterDrain++;throw Error('Terminal helper rejects controls');}pending++;f.order.push('renew-start');markStarted();await new Promise(resolve=>setTimeout(resolve,5));pending--;if(draining)throw Error('Terminal receipt rejects pending non-drain controls');f.order.push('renew-ack');};
    f.writeInput=async bytes=>{if(JSON.parse(Buffer.from(bytes).toString()).method==='configRequirements/read')await started;return await write(bytes);};
    f.drain=async reason=>{pendingAtDrain=pending;draining=true;await new Promise(resolve=>setTimeout(resolve,45));return await drain(reason);};
    const result=await inspectCodexStartupMetadata(binding(),f,{now:()=>1002,responseMs:100,activeMs:1000,graceMs:100,drainMs:200,renewalMs:20});
    expect(result.status).toBe('OBSERVED');expect(result.shutdown).toBe('DRAINED');expect(pendingAtDrain).toBe(0);expect(controlsAfterDrain).toBe(0);expect(f.order.indexOf('renew-ack')).toBeLessThan(f.order.indexOf('drain'));expect(f.drains).toBe(1);
  });
  it('review_fix1 preserves genuine renewal failure while settling before drainage',async()=>{
    const f=new Execution();const write=f.writeInput.bind(f);let markStarted!:()=>void;const started=new Promise<void>(resolve=>{markStarted=resolve;});
    f.renewLease=async()=>{markStarted();await new Promise(resolve=>setTimeout(resolve,5));throw Error(SECRET);};
    f.writeInput=async bytes=>{if(JSON.parse(Buffer.from(bytes).toString()).method==='configRequirements/read')await started;return await write(bytes);};
    const result=await inspectCodexStartupMetadata(binding(),f,{now:()=>1002,responseMs:100,activeMs:1000,graceMs:100,drainMs:200,renewalMs:20});
    expect(result.status).toBe('BLOCKED');expect(result.code).toBe('METADATA_EXCHANGE_FAILED');expect(result.shutdown).toBe('DRAINED');expect(f.drains).toBe(1);expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it('review_fix1 preserves login method enums, missing/null states and distinct safe projection hashes',async()=>{
    async function policy(methods:unknown,omit=false){const f=new Execution();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method!=='configRequirements/read')return await write(bytes);f.frames.push(frame);f.push({id:frame.id,result:{...requirements(),requirements:{...requirements().requirements,...(omit?{}:{allowedLoginMethods:methods})}}});return {ok:true,value:undefined};};return await inspect(f);}
    const chatgpt=await policy(['chatgpt']),api=await policy(['api']),both=await policy(['chatgpt','api']),missing=await policy(undefined,true),nil=await policy(null);
    expect(chatgpt.observations?.requirements.loginMethods).toEqual(['chatgpt']);expect(api.observations?.requirements.loginMethods).toEqual(['api']);expect(both.observations?.requirements.loginMethods).toEqual(['chatgpt','api']);
    expect(missing.observations?.requirements.loginMethods).toBe('MISSING');expect(nil.observations?.requirements.loginMethods).toBe('NULL');
    expect(chatgpt.status).toBe('OBSERVED');expect(both.status).toBe('OBSERVED');expect(api.status).toBe('BLOCKED');expect(api.code).toBe('METADATA_CONFLICT');expect(api.shutdown).toBe('DRAINED');expect(api.projectionHash).not.toBe(chatgpt.projectionHash);expect(JSON.stringify(api)).not.toContain(SECRET);
  });
});

describe('runtime metadata writer boundary',()=>{
  it('binds client identity to each selected action while resetting only RPC sequence',async()=>{
    const names=['ouroboros-qualification-22222222-2222-4222-8222-222222222222','ouroboros-qualification-44444444-4444-4444-8444-444444444444'];
    const observed:string[]=[];for(const clientName of names){const f=new Execution();const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName} as any,timeoutMs:20});try{await t.initialize();observed.push(f.frames[0].params.clientInfo.name);expect(f.frames[0].id).toBe('ouroboros-1');}finally{t.stop();}}
    expect(observed).toEqual(names);expect(new Set(observed).size).toBe(2);
  });
  it.each([undefined,'','ouroboros','ouroboros-qualification-22222222-2222-1222-8222-222222222222','ouroboros-qualification-22222222-2222-4222-2222-222222222222','ouroboros-qualification-22222222-2222-4222-8222-222222222222\n'])('rejects invalid metadata client name %j before subscribing or writing',clientName=>{
    const f=new Execution();let t:CodexTransport|undefined;try{expect(()=>{t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName} as any,timeoutMs:20});}).toThrow();expect(f.listeners.size).toBe(0);expect(f.frames).toHaveLength(0);}finally{t?.stop();}
  });
  it('rejects a validly shaped initialize frame with another action name at the sole writer',async()=>{
    const f=new Execution(),clientName='ouroboros-qualification-22222222-2222-4222-8222-222222222222';const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName} as any,timeoutMs:20});
    try{await expect(t.request('initialize',{clientInfo:{name:'ouroboros-qualification-44444444-4444-4444-8444-444444444444',title:'Ouroboros',version:'0.1.0'},capabilities:{experimentalApi:false,requestAttestation:false,explicitGatewayOauth:true}})).rejects.toThrow();expect(f.frames).toHaveLength(0);}finally{t.stop();}
  });
  it('expiry while awaiting initialize prevents the initialized notification at the sole writer',async()=>{
    const f=new Execution();let now=1002;const push=f.push.bind(f);f.push=value=>{now=1003;push(value);};
    const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222',admissionDeadline:1003,now:()=>now},timeoutMs:20});
    try{await expect(t.initialize()).rejects.toThrow();expect(f.frames.map(frame=>frame.method)).toEqual(['initialize']);}finally{t.stop();}
  });
  it.each(['thread/start','thread/resume','turn/start','turn/interrupt','account/read','model/list','config/write','mcpServerStatus/list','unknown'])('rejects %s at sole writer before bytes',async method=>{
    const f=new Execution();const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222'},timeoutMs:20});
    await expect(t.send({id:'x',method,params:{}})).rejects.toThrow();expect(f.frames).toHaveLength(0);t.stop();
  });
  it('rejects reorder, duplicate initialization, wrong params and response-shaped writes',async()=>{
    for(const frame of [{method:'initialized'},{id:'ouroboros-1',method:'initialize',params:{}},{id:1,result:{}},
      {id:'ouroboros-1',method:'initialize',params:{clientInfo:{name:'other'}}}]){
      const f=new Execution();const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222'},timeoutMs:20});await expect(t.send(frame)).rejects.toThrow();expect(f.frames).toHaveLength(0);t.stop();
    }
    const f=new Execution();const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222'},timeoutMs:20});await t.initialize();
    await expect(t.initialize()).rejects.toThrow();expect(f.frames.map(v=>v.method)).toEqual(['initialize','initialized']);t.stop();
  });
  it.each([{includeLayers:true,cwd:startupInput().workspace},{includeLayers:false,cwd:'C:\\other'},{includeLayers:false,cwd:startupInput().workspace,extra:true}])('rejects unbound config/read params %j',async params=>{
    const f=new Execution();const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222'},timeoutMs:20});await t.initialize();await expect(t.request('config/read',params as any)).rejects.toThrow();expect(f.frames.map(v=>v.method)).toEqual(['initialize','initialized']);t.stop();
  });
  it('rechecks queued writes after fencing and terminates stalled dispatch',async()=>{
    const f=new Execution();let release!:()=>void;f.writeInput=async bytes=>{f.frames.push(JSON.parse(Buffer.from(bytes).toString()));await new Promise<void>(r=>{release=r;});return {ok:true,value:undefined};};
    const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222'},timeoutMs:10});const first=t.initialize().catch(()=>undefined);
    await vi.waitFor(()=>expect(f.frames).toHaveLength(1),{interval:1,timeout:100});
    const queued=t.send({method:'initialized'}).catch(()=>undefined);t.fence();release();await Promise.all([first,queued]);expect(f.frames).toHaveLength(1);t.stop();
  });
  it('stalled notification writes permanently close the metadata writer',async()=>{
    const f=new Execution();const write=f.writeInput.bind(f);f.writeInput=async bytes=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='initialized'){f.frames.push(frame);return await new Promise<never>(()=>{});}return await write(bytes);};
    const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222'},timeoutMs:10});await expect(t.initialize()).rejects.toThrow();
    await expect(t.request('config/read',{includeLayers:false,cwd:startupInput().workspace})).rejects.toThrow();expect(f.frames.map(v=>v.method)).toEqual(['initialize','initialized']);expect(t.metadataEvidence().framesAdmitted).toBe(2);t.stop();
  });
  it('labels rejected input as admitted frames without claiming accepted bytes',async()=>{
    const f=new Execution();(f as OwnedExecution).writeInput=async()=>({ok:false,error:{code:'INPUT_CLOSED',message:SECRET,evidenceIds:[]}});
    const t=new CodexTransport(f,{metadata:{cwd:startupInput().workspace,clientName:'ouroboros-qualification-22222222-2222-4222-8222-222222222222'},timeoutMs:10});await expect(t.initialize()).rejects.toThrow('Codex');expect(f.frames).toHaveLength(0);expect(t.metadataEvidence().framesAdmitted).toBe(1);expect(t.metadataEvidence()).not.toHaveProperty('messagesWritten');t.stop();
  });
});

it('metadata accepts unfamiliar initialization version and additive response fields without extending its five outbound frames',async()=>{
  const f=new Execution();const push=f.push.bind(f);f.push=raw=>{const frame=raw as any;if(frame.result?.userAgent){frame.result.userAgent='codex/0.163.0';frame.result.future='PRIVATE_ADDITION';}if(frame.result?.config)frame.result.futureMetadata={informational:true};if(frame.result)frame.futureEnvelope='PRIVATE_ADDITION';push(frame);};
  const result=await inspect(f);expect(result.status).toBe('OBSERVED');expect(f.frames).toHaveLength(5);expect(JSON.stringify(result)).not.toContain('PRIVATE_ADDITION');
});
