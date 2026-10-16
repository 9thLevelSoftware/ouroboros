import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { Result } from '../../contracts/common.ts';
import { DrainEvidenceSchema, OwnershipReceiptSchema, LaunchSpecSchema, type LaunchSpec, type OwnedExecution,
  type ExecutionOwner, type OwnershipReceipt, type DrainEvidence } from '../../contracts/execution.ts';
import type { ArtifactRef, ProviderAdapter, ProviderStart, ProviderResume, ProviderSession, ProviderEvent, ExecutionInventory } from '../provider.ts';
import { ClaudeStartSchema, contains, createClaudeOptions, projectEnvironment, sameOwner } from './options.ts';
import { ClaudeFrameDecoder, encodeClaudeFrame, MAX_CLAUDE_OUTPUT, type BridgeBody, type ClaudeFrame, type SafeAccount } from './frames.ts';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const fixedHash=z.string().regex(/^[a-f0-9]{64}$/);
const absolute=(value:string)=>posix.isAbsolute(value)&&!/[\0\r\n\\]/.test(value)&&!value.split('/').some(p=>p==='.'||p==='..');
type Decision={authorized:boolean;authorizationRef:string};
export type ClaudeRuntime={distro:string;nodePath:string;bridgePath:string;bridgeHash:string;cliPath:string;cliHash:string;sdkVersion:'0.3.299'};
type Authority={input:Readonly<ProviderStart>;runtime:Readonly<ClaudeRuntime>;launch:Readonly<LaunchSpec>};
/** Startup and resume authorities must bind persisted controller evidence to the exact WSL
 * environment/runtime/workspace and current subscription/config source. A probe cannot waive
 * observed unsafe state. launchOwned must be the Task4 WSL launcher with its own authority. */
export type ClaudeAdapterDependencies=ClaudeRuntime & {
  env:Record<string,string>;loadArtifact:(ref:Readonly<ArtifactRef>)=>Promise<string>;
  launchOwned:(spec:LaunchSpec,distro:string)=>Promise<Result<OwnedExecution>>;
  authorizeStartup:(request:Authority)=>Promise<Decision>;
  authorizeObserved:(request:Authority & {startupAuthorizationRef:string;account:SafeAccount;hooksApplied:true})=>Promise<Decision>;
  authorizeResume:(request:Authority & {resume:Readonly<ProviderResume>})=>Promise<Decision>;
  requestTimeoutMs?:number;
};
function failure<T>(code:string):Result<T>{return {ok:false,error:{code,message:'Claude owned dispatch failed; inspect sanitized evidence',evidenceIds:[]}};}
function freeze<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const allowedAccount=(a:SafeAccount)=>a.apiKeySource==='none'&&a.apiProvider==='firstParty'&&a.tokenSource!=='unknown'&&a.subscriptionType!=='unknown';
function decision(value:Decision){return value.authorized===true&&/^[A-Za-z0-9_-]{1,256}$/.test(value.authorizationRef);}
async function bounded<T>(operation:()=>Promise<T>,timeout:number):Promise<T>{let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Claude control timeout')),Math.max(1,timeout));})]);}finally{clearTimeout(timer);}}
const resumeSchema=ClaudeStartSchema.extend({sessionId:z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),reconciliation:z.strictObject({
  priorOwner:ClaudeStartSchema.shape.owner,sessionId:z.string().min(1).max(256),evidenceIds:z.array(z.uuid()).min(1).max(64),
  priorExecutionDrained:z.literal(true),outcome:z.literal('safe_to_resume')})});

export function createClaudeAdapter(dependencies:ClaudeAdapterDependencies):ProviderAdapter{
  // Snapshot explicit non-secret dependency configuration before asynchronous authority checks.
  const {env,...rest}=dependencies;const deps={...rest,env:{...env}};
  const timeout=deps.requestTimeoutMs??15000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>15000)throw Error('Bounded Claude timeout required');
  const runtime=freeze({distro:deps.distro,nodePath:deps.nodePath,bridgePath:deps.bridgePath,bridgeHash:deps.bridgeHash,
    cliPath:deps.cliPath,cliHash:deps.cliHash,sdkVersion:deps.sdkVersion});
  async function dispatch(raw:ProviderStart|ProviderResume,resuming:boolean):Promise<Result<ProviderSession>>{
    const parsed=resuming?resumeSchema.safeParse(raw):ClaudeStartSchema.safeParse(raw);
    if(!parsed.success)return failure('INVALID_PROVIDER_START');
    const resume=resuming?resumeSchema.parse(parsed.data):undefined;
    const {sessionId:_id,reconciliation:_reconciliation,...base}=resume??{...ClaudeStartSchema.parse(parsed.data),sessionId:undefined,reconciliation:undefined};
    const input:Readonly<ProviderStart>=freeze(base);const projection=createClaudeOptions(input);const environment=projectEnvironment(deps.env);
    if(!projection.ok)return projection;if(!environment.ok)return environment;
    if(![runtime.nodePath,runtime.bridgePath,runtime.cliPath].every(absolute)||!fixedHash.safeParse(runtime.bridgeHash).success||
        !fixedHash.safeParse(runtime.cliHash).success||runtime.sdkVersion!=='0.3.299'||!runtime.distro||/[\0\r\n]/.test(runtime.distro))return failure('CAPABILITY_UNAVAILABLE');
    const b=input.boundary;
    if([runtime.nodePath,runtime.bridgePath,runtime.cliPath].some(path=>b.deniedSensitiveRoots.some(root=>contains(path,root))))return failure('CAPABILITY_UNAVAILABLE');
    const {qualification:_q,runId:_run,generation:_generation,actionId:_action,role:_role,deadline:_deadline,leaseTtlMs:_lease,...policy}=b;
    const policyHash=hash(JSON.stringify(policy));
    if(input.authorization.kind==='qualified'&&b.qualification?.policyHash!==policyHash)return failure('EXECUTION_NOT_AUTHORIZED');
    if(resume&&(!sameOwner(resume.reconciliation.priorOwner,{...input.owner,generation:resume.reconciliation.priorOwner.generation})||
        resume.reconciliation.priorOwner.generation>input.owner.generation||resume.reconciliation.sessionId!==resume.sessionId))return failure('RESUME_NOT_RECONCILED');
    const turnId=randomUUID();
    const launch=freeze(LaunchSpecSchema.parse({...input.owner,executable:runtime.nodePath,argv:[runtime.bridgePath,JSON.stringify({owner:input.owner,turnId,deadline:b.deadline})],
      cwd:input.workspaceRoot,env:environment.value,boundaryHash:policyHash,authorization:input.authorization,stdin:'pipe',leaseTtlMs:10000,deadline:b.deadline}));
    const authority=freeze({input,runtime,launch});
    const remaining=()=>Math.min(timeout,b.deadline-Date.now());
    let startup:Decision,prompt:string;
    try{
      startup=await bounded(()=>deps.authorizeStartup(authority),remaining());if(!decision(startup))return failure('EXECUTION_NOT_AUTHORIZED');
      if(resume&&!decision(await bounded(()=>deps.authorizeResume({...authority,resume:freeze(resume)}),remaining())))return failure('RESUME_NOT_AUTHORIZED');
      const resolve=async(ref:ArtifactRef,limit:number)=>{
        const text=await bounded(()=>deps.loadArtifact(freeze({...ref})),remaining());
        if(typeof text!=='string'||!text||Buffer.byteLength(text)>limit||hash(text)!==ref.sha256||text.includes('\0'))throw Error('Artifact integrity failed');return text;
      };
      prompt=await resolve(input.promptRef,98304);let contextBytes=0;
      for(const ref of input.contextRefs){const context=await resolve(ref,32768);contextBytes+=Buffer.byteLength(context);if(contextBytes>32768)throw Error('Context exhausted');prompt+=`\n\nValidated repository context:\n${context}`;}
      if(Buffer.byteLength(prompt)>131072||b.deadline<=Date.now())return failure('PROVIDER_INPUT_LIMIT');
    }catch{return failure('PROVIDER_PREFLIGHT_FAILED');}
    let execution:OwnedExecution;
    try{const launched=await deps.launchOwned(launch,runtime.distro);if(!launched.ok)return launched;execution=launched.value;}catch{return failure('PROVIDER_LAUNCH_FAILED');}
    let ownership:OwnershipReceipt|undefined,sessionId:string|undefined,stopped:string|undefined,localFenced=false;
    let draining:Promise<DrainEvidence>|undefined,dispose:(()=>void)|undefined,lease:NodeJS.Timeout|undefined,deadlineTimer:NodeJS.Timeout|undefined;
    let leaseSequence=0,bytes=0,writeChain=Promise.resolve(),expected:'initialized'|'started'|'interrupted'|undefined;
    let waiter:{resolve:(frame:ClaudeFrame)=>void;reject:(error:Error)=>void}|undefined;
    const events:ProviderEvent[]=[];let eventWaiter:((value:IteratorResult<ProviderEvent>)=>void)|undefined;let eventsEnded=false;
    const finishEvents=()=>{eventsEnded=true;eventWaiter?.({done:true,value:undefined});eventWaiter=undefined;};
    const drain=():Promise<DrainEvidence>=>{
      if(draining)return draining;localFenced=true;clearInterval(lease);clearTimeout(deadlineTimer);
      draining=(async()=>{try{await bounded(()=>execution.fence(),Math.min(timeout,20000));}catch{/* Drain remains mandatory even when fencing fails. */}
        try{const evidence=DrainEvidenceSchema.parse(await bounded(()=>execution.drain('Claude provider stop'),20000));
          if(!sameOwner(evidence,input.owner)||!('environment' in evidence)||evidence.environment!=='wsl2'||!ownership||ownership.environment!=='wsl2'||
              evidence.unitName!==ownership.unitName||evidence.invocationId!==ownership.invocationId||evidence.bootId!==ownership.bootId||
              evidence.controlGroup!==ownership.controlGroup||JSON.stringify(evidence.observationSlice)!==JSON.stringify(ownership.observationSlice)||
              JSON.stringify(evidence.observer)!==JSON.stringify(ownership.observer))throw Error('Claude drainage identity mismatch');return evidence;
        }finally{dispose?.();finishEvents();}})();void draining.catch(()=>{});return draining;
    };
    const fail=(code:string)=>{if(stopped)return;stopped=code;localFenced=true;waiter?.reject(Error('Claude protocol stopped'));waiter=undefined;expected=undefined;void drain().catch(()=>{});};
    const emit=(event:ProviderEvent)=>{if(eventsEnded)return;if(eventWaiter){const resolve=eventWaiter;eventWaiter=undefined;resolve({done:false,value:event});}
      else if(events.length<128)events.push(event);else fail('OUTPUT_LIMIT_EXCEEDED');};
    const decoder=new ClaudeFrameDecoder(input.owner,turnId);
    const receive=(frame:ClaudeFrame)=>{
      if(stopped)return;
      if(frame.type==='failed'){fail(frame.code);return;}
      if(frame.type==='event'){
        if(!sessionId||frame.sessionId!==sessionId){fail('PROTOCOL_INVALID');return;}
        emit({...input.owner,sessionId,turnId,...frame.event});
        if(frame.event.type==='auth_error'||frame.event.type==='quota_error')fail(frame.event.code);return;
      }
      if(frame.type!==expected||!waiter){fail('PROTOCOL_INVALID');return;}
      if(frame.type==='started'&&(sessionId||resume&&frame.sessionId!==resume.sessionId)){fail('PROTOCOL_INVALID');return;}
      if(frame.type==='interrupted'&&frame.sessionId!==sessionId){fail('PROTOCOL_INVALID');return;}
      if(frame.type==='started')sessionId=frame.sessionId;
      const current=waiter;waiter=undefined;expected=undefined;current.resolve(frame);
    };
    const send=(body:BridgeBody,control=false)=>{
      const next=writeChain.then(async()=>{
        if(stopped||localFenced&&!control)throw Error('Claude input fenced');const frame=encodeClaudeFrame({protocolVersion:1,...input.owner,turnId,...body});
        for(let offset=0;offset<frame.length;offset+=65536){if(stopped)throw Error('Claude input stopped');const result=await bounded(()=>execution.writeInput(frame.subarray(offset,offset+65536)),remaining());if(!result.ok)throw Error('Claude input failed');}
      });writeChain=next.catch(()=>{});return next;
    };
    const request=async(type:'initialized'|'started'|'interrupted',body:BridgeBody,control=false)=>{
      if(stopped||waiter)throw Error('Claude control unavailable');
      let resolve!:(frame:ClaudeFrame)=>void,reject!:(error:Error)=>void;const response=new Promise<ClaudeFrame>((yes,no)=>{resolve=yes;reject=no;});void response.catch(()=>{});
      waiter={resolve,reject};expected=type;
      try{await send(body,control);return await bounded(()=>response,remaining());}catch{waiter=undefined;expected=undefined;
        if(control){stopped??='PROTOCOL_INVALID';}else fail('PROTOCOL_INVALID');throw Error('Claude control failed');}
    };
    try{
      ownership=OwnershipReceiptSchema.parse(await bounded(()=>execution.describe(),remaining()));
      if(!sameOwner(ownership,input.owner)||ownership.environment!=='wsl2'||ownership.distro!==runtime.distro||ownership.boundaryHash!==launch.boundaryHash)throw Error('Claude launch identity mismatch');
      dispose=execution.onOutput(out=>{try{bytes+=out.data.length;if(bytes>MAX_CLAUDE_OUTPUT)throw Error('Claude output exhausted');
        if(out.stream==='stdout')for(const frame of decoder.push(out.data))receive(frame);
      }catch{fail('PROTOCOL_INVALID');}});
      if(stopped)throw Error('Claude startup invalidated');
      lease=setInterval(()=>{void bounded(()=>execution.renewLease(++leaseSequence),remaining()).catch(()=>fail('LEASE_EXPIRED'));},2000);
      deadlineTimer=setTimeout(()=>fail('LEASE_EXPIRED'),Math.max(1,b.deadline-Date.now()));
      const initialized=await request('initialized',{type:'start',options:projection.value,env:environment.value,cliPath:runtime.cliPath,prompt,resumeSessionId:resume?.sessionId??null});
      if(initialized.type!=='initialized'||!initialized.hooksApplied||!allowedAccount(initialized.account))throw Error('Claude subscription rejected');
      const observed=await bounded(()=>deps.authorizeObserved({...authority,startupAuthorizationRef:startup.authorizationRef,account:freeze(initialized.account),hooksApplied:true}),remaining());
      if(stopped||!decision(observed))throw Error('Claude observed authorization rejected');
      await request('started',{type:'authorize',authorizationRef:observed.authorizationRef});if(stopped||!sessionId)throw Error('Claude start invalidated');
    }catch{try{await drain();}catch{return failure('PROVIDER_DRAIN_UNKNOWN');}return failure(stopped??'PROVIDER_START_FAILED');}
    const inventory=async():Promise<ExecutionInventory>=>{
      let reason='Pinned SDK has no complete runtime execution inventory';
      try{const current=await bounded(()=>execution.describe(),Math.min(timeout,15000));if(JSON.stringify(current)!==JSON.stringify(ownership))reason='Owned runtime inventory identity changed';}
      catch{reason='Owned runtime inventory observation unavailable';}
      return {owner:input.owner,sessionId:sessionId!,turnId,complete:false,reason,capturedAt:Date.now(),ownership:ownership!,observed:[]};
    };
    let interrupting:Promise<Awaited<ReturnType<ProviderSession['interrupt']>>>|undefined;
    const session:ProviderSession={sessionId:sessionId!,turnId,
      events:{[Symbol.asyncIterator](){return {next:async()=>{
        const event=events.shift();if(event)return {done:false,value:event};if(eventsEnded)return {done:true,value:undefined};
        if(eventWaiter)throw Error('One Claude event consumer required');return await new Promise<IteratorResult<ProviderEvent>>(resolve=>{eventWaiter=resolve;});},
        return:async()=>({done:true,value:undefined})};}},
      inspectExecution:inventory,
      interrupt(){if(interrupting)return interrupting;localFenced=true;
        interrupting=(async()=>{let acknowledged=false;
          // Supervisor fence closes stdin; exact provider control must go first while starts are locally fenced.
          if(!stopped&&!draining)try{const ack=await request('interrupted',{type:'interrupt',sessionId:sessionId!},true);acknowledged=ack.type==='interrupted'&&ack.acknowledged;}catch{/* ACK failure never skips OS drainage. */}
          const observed=await inventory();const evidence=await drain();return {owner:input.owner,sessionId:sessionId!,turnId,acknowledged,inventory:observed,drain:evidence};})();return interrupting;},
      close:drain};
    return {ok:true,value:session};
  }
  return {inspect:async()=>({provider:'claude',runtimeVersion:'0.3.299 / Claude Code 2.1.299',extraUsage:'unknown',capabilities:{
    bash_sandbox:{status:'UNQUALIFIED',reason:'Task8 behavioral WSL qualification required'},subscription:{status:'UNQUALIFIED',reason:'Task8 startup/source/first-yield proof required'},
    complete_inventory:{status:'UNSUPPORTED',reason:'SDK control receipt is not runtime inventory'},reflect:{status:'UNSUPPORTED',reason:'Separate no-tools qualification required'}}}),
    start:input=>dispatch(input,false),resume:input=>dispatch(input,true)};
}
