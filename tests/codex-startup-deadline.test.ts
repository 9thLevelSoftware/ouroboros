import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { createCodexAdapter } from '../src/providers/codex/adapter.ts';
const CODEX_BINARY_HASH='dd13bdb162a184fa04039488b234a8258ef9b76f84e926c505d5742b19249a6a';
import { createSupervisor } from '../src/runtime/supervisor.ts';
import { admittedPreThread, admittedTurn, approval, startupContext } from './helpers/codex-admission.ts';

vi.mock('node:child_process',()=>({spawn:vi.fn(()=>{throw Error('Simulated creation seam must remain unused');})}));

it('expired bootstrap admission cannot create a helper after deferred durable supervisor authorization',async()=>{
  let clock=100000;const now=vi.spyOn(Date,'now').mockImplementation(()=>clock);
  let release!:()=>void,entered!:()=>void;const authorizationStarted=new Promise<void>(resolve=>{entered=resolve;});const deferred=new Promise<void>(resolve=>{release=resolve;});
  const supervisor=createSupervisor({helperPath:'C:\\trusted\\helper.exe',authorize:async()=>{entered();await deferred;return true;}});
  const owner={runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'22222222-2222-4222-8222-222222222222',role:'implementation'};
  const policy={platform:'windows' as const,readRoots:['C:\\work'],writeRoots:['C:\\work'],deniedSensitiveRoots:['C:\\controller'],network:{allowedDomains:[],deniedDomains:['*']},verifier:{executable:'C:\\trusted\\codex.exe',runtimePath:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:CODEX_BINARY_HASH,settingsPath:'C:\\controller\\policy.toml',settingsHash:'c'.repeat(64)},registry:[{id:'check',executable:'C:\\Windows\\System32\\whoami.exe',argv:[],cwd:'C:\\work',environment:{},approvedEnvironmentKeys:[],timeoutMs:1000,inputScope:['C:\\work'],permittedOutputs:['C:\\work'],expectedExit:0}]};
  const input={owner,actionId:owner.actionId,workspaceRoot:'C:\\work',promptRef:{id:owner.runId,sha256:createHash('sha256').update('prompt').digest('hex')},contextRefs:[],model:'fixture-model',effort:'high',mode:'IMPLEMENT' as const,
    authorization:{kind:'qualified' as const,qualificationRef:'fixture-boundary'},boundary:{...policy,...owner,leaseTtlMs:10000,deadline:clock+10000,qualification:{environment:'windows' as const,qualificationRef:'fixture-boundary',runtimeVersion:'0.162.1',runtimeHash:CODEX_BINARY_HASH,policyHash:createHash('sha256').update(JSON.stringify(policy)).digest('hex'),seccompUnixSockets:false,inheritedDescriptorsRestricted:true}}};
  const adapter=createCodexAdapter({startupContext,supervisor,executable:'C:\\trusted\\codex.exe',binaryHash:CODEX_BINARY_HASH,env:{},loadArtifact:async()=> 'prompt',
    authorizeStartup:async request=>{const admission=approval(request,'BOOTSTRAP');admission.expiresAt=clock+20;return {authorized:true,authorizationRef:'short-bootstrap',admission};},authorizePreThread:admittedPreThread,authorizeObserved:admittedTurn});
  try{
    const pending=adapter.start(input).catch(()=>({ok:false as const}));await authorizationStarted;clock+=21;release();
    const result=await pending;expect(result.ok).toBe(false);expect(spawn).not.toHaveBeenCalled();
  }finally{release();now.mockRestore();}
});
