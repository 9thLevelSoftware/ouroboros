import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ChildOutput, OwnedExecution } from '../src/contracts/execution.ts';
import { createClaudeAdapter } from '../src/providers/claude/adapter.ts';
import { ClaudeFrameDecoder, encodeClaudeFrame, MAX_CLAUDE_OUTPUT, type BridgeBody } from '../src/providers/claude/frames.ts';
import { createClaudeOptions } from '../adapters/claude/src/options.ts';
import { createSdkSession } from '../adapters/claude/src/session.ts';

const owner={runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'22222222-2222-4222-8222-222222222222',role:'implementation'};
const account={subscriptionType:'max',tokenSource:'claude.ai',apiKeySource:'none',apiProvider:'firstParty'};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function input(){
  return {owner,actionId:owner.actionId,workspaceRoot:'/fixture/work',promptRef:{id:owner.runId,sha256:hash('bounded fixture prompt')},contextRefs:[],model:'fixture',effort:'high',mode:'IMPLEMENT' as const,
    authorization:{kind:'qualification' as const,requestId:owner.runId,probeId:'claude-stop-fixture',fixtureRoots:['/fixture']},
    boundary:{...owner,platform:'wsl2' as const,readRoots:['/fixture/work'],writeRoots:['/fixture/work'],deniedSensitiveRoots:['/fixture/controller','/run','/sys/fs/cgroup'],network:{allowedDomains:[],deniedDomains:['*']},
      verifier:{executable:'/trusted/node',runtimePath:'/trusted/srt',version:'0.0.79',sha256:'b'.repeat(64),settingsPath:'/trusted/settings',settingsHash:'c'.repeat(64)},
      registry:[{id:'check',executable:'/usr/bin/true',argv:[],cwd:'/fixture/work',environment:{},approvedEnvironmentKeys:[],timeoutMs:1000,inputScope:['/fixture/work'],permittedOutputs:[],expectedExit:0}],leaseTtlMs:10000,deadline:Date.now()+60000}};
}
function initMessage(){
  return {type:'system',subtype:'init',session_id:'session-1',claude_code_version:'2.1.299',cwd:'/fixture/work',model:'fixture',apiKeySource:'none',permissionMode:'dontAsk',tools:['Bash'],mcp_servers:[],skills:[],plugins:[]};
}
function hookRequest(turnId=owner.actionId){
  return {hook_event_name:'PreToolUse',session_id:'session-1',transcript_path:'/trusted/transcript',cwd:'/fixture/work',prompt_id:turnId,tool_use_id:'tool-1',tool_name:'Bash',tool_input:{command:'true'}};
}
/** No SDK code runs: retain the actual Options callbacks installed by createSdkSession. */
class SdkFixture {
  options!:Options;closeCalls=0;interruptEntered=deferred<void>();interruptRelease=deferred<void>();
  closed=false;messages:any[]=[];waiting=deferred<void>();
  async initializationResult(){return {account,hooks_applied:true};}
  async accountInfo(){return account;}
  async interrupt(){this.interruptEntered.resolve();await this.interruptRelease.promise;return undefined;}
  close(){this.closeCalls++;this.closed=true;this.waiting.resolve();}
  push(message:unknown){this.messages.push(message);this.waiting.resolve();}
  async *[Symbol.asyncIterator](){
    yield initMessage();
    while(!this.closed){
      if(!this.messages.length){await this.waiting.promise;this.waiting=deferred<void>();}
      if(this.closed)return;
      while(this.messages.length)yield this.messages.shift();
    }
  }
  installedHook(){return this.options.hooks!.PreToolUse![0]!.hooks[0]!;}
  invokeHook(request=hookRequest()){return this.installedHook()(request as any,'tool-1',{signal:new AbortController().signal});}
}
async function standalone(sendOverride?:(frame:BridgeBody)=>Promise<void>){
  const sdk=new SdkFixture(),frames:BridgeBody[]=[];const started=deferred<void>();const options=createClaudeOptions(input());
  if(!options.ok)throw Error('Invalid stop fixture options');
  const session=createSdkSession({options:options.value,env:{PATH:'/trusted',HOME:'/home/fixture'},cliPath:'/trusted/claude',prompt:'bounded fixture prompt',turnId:owner.actionId,resumeSessionId:null,
    queryFactory:args=>{sdk.options=args.options;return sdk as any;},
    send:async frame=>{frames.push(frame);if(frame.type==='started')started.resolve();await sendOverride?.(frame);}});
  await session.initialized;session.authorize('observed');await started.promise;
  return {sdk,frames,session};
}
const identity={unitName:'owned.service',invocationId:'1'.repeat(32),bootId:owner.runId,controlGroup:'/slice/owned',
  observationSlice:{unitName:'owned.slice',invocationId:'2'.repeat(32),controlGroup:'/slice',fileDevice:'1',fileInode:'2'},
  observer:{unitName:'observer.service',invocationId:'3'.repeat(32)}};
/** Actual SDK-session output is framed into the real root adapter; no canned failed frame. */
class OwnedBridgeFixture implements OwnedExecution {
  listeners=new Set<(output:ChildOutput)=>void>();launch:any;decoder!:ClaudeFrameDecoder;turnId!:string;
  sdk=new SdkFixture();session!:ReturnType<typeof createSdkSession>;frames:BridgeBody[]=[];order:string[]=[];drains=0;
  drained=deferred<void>();
  async describe(){return {schemaVersion:1 as const,...owner,environment:'wsl2' as const,distro:'Ubuntu',...identity,
    helper:{pid:10,startTimeTicks:'1'},root:{pid:11,startTimeTicks:'2'},boundaryHash:this.launch.boundaryHash,
    identityCapturedBeforeExec:true as const,observationArmedBeforeExec:true as const,capturedAt:1};}
  async fence(){this.order.push('fence');await this.session.close();}
  async renewLease(_sequence:number){this.order.push('lease');}
  async drain(reason:string){
    this.order.push('drain');this.drains++;const t=Date.now();this.drained.resolve();
    return {schemaVersion:1 as const,...owner,environment:'wsl2' as const,...identity,reason,requestAcknowledged:true,requestedAt:t,acknowledgedAt:t,
      rootExited:true,rootExitedAt:t,membershipEmpty:true,membershipObservedAt:t,cgroupPopulated:0 as const,observationError:null,unresolvedUnits:[],
      outputComplete:true,unresolvedOutputStreams:[],outputCompletedAt:t,completedAt:t};
  }
  onOutput(listener:(output:ChildOutput)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  async endInput(){await this.session.close();return {ok:true as const,value:undefined};}
  async writeInput(bytes:Uint8Array){
    for(const frame of this.decoder.push(bytes)){
      if(frame.type==='start'){
        this.session=createSdkSession({options:frame.options,env:frame.env,cliPath:frame.cliPath,prompt:frame.prompt,turnId:this.turnId,resumeSessionId:frame.resumeSessionId,
          queryFactory:args=>{this.sdk.options=args.options;return this.sdk as any;},
          send:async body=>{
            this.frames.push(body);if(body.type==='failed')this.order.push('terminal');
            const data=encodeClaudeFrame({protocolVersion:1,...owner,turnId:this.turnId,...body});
            for(const listener of this.listeners)listener({stream:'stdout',data});
          }});
        await this.session.initialized;
      }else if(frame.type==='authorize')this.session.authorize(frame.authorizationRef);
      else if(frame.type==='interrupt')await this.session.interrupt(frame.sessionId);
    }
    return {ok:true as const,value:undefined};
  }
}
async function owned(){
  const bridge=new OwnedBridgeFixture(),start=input();
  const adapter=createClaudeAdapter({distro:'Ubuntu',nodePath:'/trusted/node',bridgePath:'/trusted/main.js',bridgeHash:'d'.repeat(64),cliPath:'/trusted/claude',cliHash:'e'.repeat(64),sdkVersion:'0.3.299',env:{PATH:'/trusted',HOME:'/home/fixture'},
    loadArtifact:async()=> 'bounded fixture prompt',authorizeStartup:async()=>({authorized:true,authorizationRef:'startup'}),
    authorizeObserved:async()=>({authorized:true,authorizationRef:'observed'}),authorizeResume:async()=>({authorized:true,authorizationRef:'resume'}),
    launchOwned:async spec=>{bridge.launch=spec;bridge.turnId=JSON.parse(spec.argv[1]).turnId;bridge.decoder=new ClaudeFrameDecoder(owner,bridge.turnId);return {ok:true,value:bridge};},requestTimeoutMs:100});
  const result=await adapter.start(start);if(!result.ok)throw Error(result.error.code);
  return {bridge,controller:result.value,deadline:start.boundary.deadline};
}

describe('Claude SDK stop regressions',()=>{
  it('stop_installed_hook_is_fenced_during_interrupt_and_after_close',async()=>{
    const {sdk,session}=await standalone();
    try{
      expect(await sdk.invokeHook()).toMatchObject({hookSpecificOutput:{permissionDecision:'allow'}});
      const pending=session.interrupt('session-1');await sdk.interruptEntered.promise;
      const during=await sdk.invokeHook();await session.close();const after=await sdk.invokeHook();
      sdk.interruptRelease.resolve();await pending;
      expect(during).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
      expect(after).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
    }finally{sdk.interruptRelease.resolve();await session.close();}
  });
  it('stop_inflight_hook_cannot_return_allow_after_interrupt',async()=>{
    const {sdk,session}=await standalone();
    try{
      // preToolGate is genuinely async. Stop synchronously during its await, before its return.
      const admitted=sdk.invokeHook();const pending=session.interrupt('session-1');
      const decision=await admitted;sdk.interruptRelease.resolve();await pending;
      expect(decision).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
    }finally{sdk.interruptRelease.resolve();await session.close();}
  });
  for(const source of ['stderr','hook','message'] as const)it(`stop_${source}_budget_terminal_drains_immediately`,async()=>{
    const {bridge,controller,deadline}=await owned();
    const secret=`${source.toUpperCase()}_SECRET`;const raw=secret+'x'.repeat(MAX_CLAUDE_OUTPUT+1);
    let hookPromise:Promise<unknown>|undefined;
    try{
      if(source==='stderr')bridge.sdk.options.stderr!(raw);
      else if(source==='hook')hookPromise=bridge.sdk.invokeHook({...hookRequest(bridge.turnId),tool_input:{command:raw}});
      else bridge.sdk.push({type:'assistant',session_id:'session-1',parent_tool_use_id:null,message:{content:[{type:'text',text:raw}]}});
      await vi.waitFor(()=>expect(bridge.frames.filter(frame=>frame.type==='failed')).toEqual([{type:'failed',code:'OUTPUT_LIMIT_EXCEEDED'}]),{interval:1,timeout:100});
      await bridge.drained.promise;await hookPromise;
      expect(bridge.sdk.closeCalls).toBe(1);expect(bridge.drains).toBe(1);
      expect(bridge.order.slice(0,3)).toEqual(['terminal','fence','drain']);
      expect(bridge.order).not.toContain('lease');expect(Date.now()).toBeLessThan(deadline-50000);
      expect(JSON.stringify(bridge.frames)).not.toContain(secret);
      if(hookPromise)expect(await hookPromise).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
    }finally{await hookPromise;await controller.close();}
  });
  it('stop_terminal_send_rejection_is_idempotent_and_still_closes',async()=>{
    const terminalEntered=deferred<void>(),rejectSend=deferred<void>();
    const {sdk,session,frames}=await standalone(async frame=>{if(frame.type==='failed'){terminalEntered.resolve();await rejectSend.promise;}});
    try{
      const raw='STDERR_SECRET'+'x'.repeat(MAX_CLAUDE_OUTPUT+1);
      sdk.options.stderr!(raw);sdk.options.stderr!(raw);
      await vi.waitFor(()=>expect(frames.filter(frame=>frame.type==='failed')).toEqual([{type:'failed',code:'OUTPUT_LIMIT_EXCEEDED'}]),{interval:1,timeout:100});
      await terminalEntered.promise;const during=await sdk.invokeHook();
      rejectSend.reject(Error('SEND_SECRET'));
      await vi.waitFor(()=>expect(sdk.closeCalls).toBe(1),{interval:1,timeout:100});
      expect(during).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
      expect(await sdk.invokeHook()).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
      expect(frames.filter(frame=>frame.type==='failed')).toHaveLength(1);
      expect(JSON.stringify(frames)).not.toMatch(/STDERR_SECRET|SEND_SECRET/);
    }finally{rejectSend.resolve();await session.close();}
  });
});
