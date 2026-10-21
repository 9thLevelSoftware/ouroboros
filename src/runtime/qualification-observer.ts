import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { win32 } from 'node:path';
import { z } from 'zod';
import { ExecutionOwnerSchema, LaunchSpecSchema, type ExecutionOwner, type LaunchSpec } from '../contracts/execution.ts';
import { CapturedOutputSchema, ObservedExecutionSchema, ObservationDeathTargetSchema, ObservationTriggerSchema, ObservationStartSchema, QualificationTerminalSchema,
 type CapturedOutput, type ObservedExecution, type ObservationStart, type QualificationTerminal, type QualificationObservationClient } from '../contracts/qualification-observation.ts';
import { encodeFrame } from './supervisor.ts';

export type QualificationObserverOptions={helperPath:string;guardian:LaunchSpec;controller:LaunchSpec;executionOwner:ExecutionOwner;boundaryHash:string;rawOutputLimitBytes:number;
 unrelated?:{pid:number;creationIdentity:string;name:string};
 /** Mandatory current controller approval and pinned binary/resource recheck.
  * Receives the complete immutable launch binding immediately before spawn. */
 authorizeStart?:(binding:Readonly<QualificationObservationLaunchBinding>)=>boolean|Promise<boolean>;
 onRawBytes?:(source:'guardian'|'controller'|'helper',stream:'stdout'|'stderr',bytes:Uint8Array)=>void};
export type QualificationObservationLaunchBinding=Omit<QualificationObserverOptions,'authorizeStart'|'onRawBytes'>;
/** Only the disposable trusted controller receives this rendezvous. Never merge its env into the provider spec. */
export function qualificationHandoffCommand(helperPath:string,env:NodeJS.ProcessEnv):{file:string;args:string[]}{
 const pipe=env.OUROBOROS_QUALIFICATION_RENDEZVOUS,nonce=env.OUROBOROS_QUALIFICATION_NONCE,pid=env.OUROBOROS_QUALIFICATION_GUARDIAN_PID,creation=env.OUROBOROS_QUALIFICATION_GUARDIAN_CREATION;
 if(!win32.isAbsolute(helperPath)||!pipe?.startsWith('\\\\.\\pipe\\')||!nonce?.match(/^[a-f0-9]{64}$/)||!pid?.match(/^[1-9][0-9]*$/)||!creation||creation.includes('\0'))throw new Error('Invalid qualification rendezvous metadata');
 return {file:helperPath,args:['--qualification-handoff-v1',pipe,nonce,pid,creation]};
}
type Pending={resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;kind:string};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const ownerOf=(value:ExecutionOwner)=>ExecutionOwnerSchema.parse({runId:value.runId,generation:value.generation,actionId:value.actionId,role:value.role});
const frozen=<T>(value:T):Readonly<T>=>{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;};
/** Passive until start(): callers must perform current campaign authorization at that effect boundary. */
export function createQualificationObserver(input:QualificationObserverOptions):QualificationObservationClient{
 const options=frozen({...input,guardian:LaunchSpecSchema.parse(input.guardian),controller:LaunchSpecSchema.parse(input.controller),executionOwner:ExecutionOwnerSchema.parse(input.executionOwner),unrelated:input.unrelated?z.strictObject({pid:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),creationIdentity:z.string().min(1),name:z.string().min(1)}).parse(input.unrelated):undefined});
 if(options.guardian.executable!==options.helperPath||!same(options.guardian.argv,['--qualification-observer-v1'])||!win32.isAbsolute(options.helperPath)||!/^[a-f0-9]{64}$/.test(options.boundaryHash)||!Number.isSafeInteger(options.rawOutputLimitBytes)||options.rawOutputLimitBytes<1||options.rawOutputLimitBytes>10*1024*1024)throw new Error('Invalid observation launch inputs');
 let peer:ChildProcessWithoutNullStreams|undefined,started=false,startSeen=false,startObservation:ObservationStart|undefined,failed:Error|undefined,sequence=0,buffer=Buffer.alloc(0),description:ObservedExecution|undefined,lastTerminal:QualificationTerminal|undefined,cleaned=false,closing=false,startAt=0,rawBytes=0;
 let resolveStart!:(value:ObservationStart)=>void,rejectStart!:(error:Error)=>void;
 const startReceipt=new Promise<ObservationStart>((resolve,reject)=>{resolveStart=resolve;rejectStart=reject;});void startReceipt.catch(()=>{});
 let resolveExit!:(value:{code:number|null;signal:NodeJS.Signals|null})=>void;
 const exitReceipt=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{resolveExit=resolve;});
 const pending=new Map<number,Pending>(),outputListeners=new Set<(value:{stream:'stdout'|'stderr';data:Buffer})=>void>(),controllerListeners=new Set<(bytes:Buffer)=>void>();
 const earlyController:Buffer[]=[];let earlyControllerBytes=0;
 const earlyOutput:Array<{stream:'stdout'|'stderr';data:Buffer}>=[];let earlyOutputBytes=0;
 const fail=(error:unknown)=>{if(failed)return;failed=error instanceof Error?error:new Error(String(error));rejectStart(failed);for(const value of pending.values()){clearTimeout(value.timer);value.reject(failed);}pending.clear();peer?.stdin.destroy();peer?.kill();};
 const write=async(value:unknown)=>{if(failed)throw failed;if(!peer)throw new Error('Observer not started');await new Promise<void>((resolve,reject)=>peer!.stdin.write(encodeFrame(value),error=>error?reject(error):resolve()));};
 const request=(type:string,extra:Record<string,unknown>={},timeout=20000):Promise<unknown>=>{
  if(failed)return Promise.reject(failed);if(!started)return Promise.reject(new Error('Observer not started'));
  const next=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>fail(new Error('Observer request timed out; terminal outcome unknown')),timeout);pending.set(next,{resolve,reject,timer,kind:type});void write({observationVersion:1,...options.executionOwner,type,sequence:next,...extra}).catch(fail);});
 };
 const client:QualificationObservationClient={
  async start(){if(started)throw new Error('Observer already started');started=true;startAt=Date.now();if(options.controller.deadline<=Date.now()){fail(new Error('Observation deadline expired'));throw failed;}
   try{const {authorizeStart,onRawBytes,...binding}=options;const approval=authorizeStart?.(frozen(structuredClone(binding)));const allowed=approval instanceof Promise?await approval:approval;if(allowed!==true)throw new Error('Observation start authorization or pinned resource check denied');if(options.controller.deadline<=Date.now())throw new Error('Observation deadline expired during authorization');}catch(error){fail(error);throw failed;}
   peer=spawn(options.guardian.executable,options.guardian.argv,{cwd:options.guardian.cwd,env:options.guardian.env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
   peer.on('error',fail);peer.stdin.on('error',fail);peer.stdout.on('error',fail);peer.stderr.on('error',fail);
   peer.stderr.on('data',(bytes:Buffer)=>{try{rawBytes+=bytes.length;options.onRawBytes?.('guardian','stderr',bytes);}catch(error){fail(error);}});
   peer.stdout.on('data',(bytes:Buffer)=>{try{
    rawBytes+=bytes.length;options.onRawBytes?.('guardian','stdout',bytes);if(buffer.length+bytes.length>2*1024*1024)throw new Error('Observer input buffer exceeded');buffer=Buffer.concat([buffer,bytes]);
    while(buffer.length>=4){const length=buffer.readUInt32LE();if(!length||length>1024*1024)throw new Error('Invalid observer frame size');if(buffer.length<length+4)break;
     const frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(4,length+4)));buffer=buffer.subarray(length+4);
     const header=['observationVersion','runId','generation','actionId','role','type'];const fields=frame.type==='rawOutput'||frame.type==='controllerOutput'?[...header,'stream','data']:[...header,'sequence','value',...(frame.type==='error'?['message']:[])];if(Object.keys(frame).some(key=>!fields.includes(key)))throw new Error('Unknown observer frame field');
     if(frame.observationVersion!==1||!same(ExecutionOwnerSchema.parse({runId:frame.runId,generation:frame.generation,actionId:frame.actionId,role:frame.role}),options.executionOwner))throw new Error('Observer frame identity mismatch');
     if(frame.type==='started'){const value=ObservationStartSchema.parse(frame.value);if(startSeen||!same(ownerOf(value),options.executionOwner)||value.observer.pid!==peer?.pid)throw new Error('Observer start identity mismatch');startSeen=true;startObservation=structuredClone(value);resolveStart(value);continue;}
     if(frame.type==='rawOutput'||frame.type==='controllerOutput'){
      if(typeof frame.data!=='string'||Buffer.from(frame.data,'base64').toString('base64')!==frame.data)throw new Error('Invalid observer output');const data=Buffer.from(frame.data,'base64');
      if(frame.type==='rawOutput'){if(!['stdout','stderr'].includes(frame.stream))throw new Error('Invalid root stream');if(outputListeners.size){for(const listener of outputListeners)listener({stream:frame.stream,data});}else{earlyOutputBytes+=data.length;if(earlyOutputBytes>options.rawOutputLimitBytes)throw new Error('Unconsumed root output overflow');earlyOutput.push({stream:frame.stream,data});}}
      else {if(!['stdout','stderr'].includes(frame.stream))throw new Error('Invalid controller stream');options.onRawBytes?.('controller',frame.stream,data);if(frame.stream==='stdout'){if(controllerListeners.size){for(const listener of controllerListeners)listener(data);}else{earlyControllerBytes+=data.length;if(earlyControllerBytes>options.rawOutputLimitBytes)throw new Error('Unconsumed controller channel overflow');earlyController.push(data);}}}continue;
     }
     const waiter=pending.get(frame.sequence);if(!waiter)throw new Error('Unrequested observer response');pending.delete(frame.sequence);clearTimeout(waiter.timer);
     if(frame.type==='error'){waiter.reject(new Error(String(frame.message)));continue;}
     const expected:Record<string,string>={describeObservedExecution:'described',triggerDeath:'triggered',observeTerminal:'terminal',readCapturedOutput:'captured',emergencyCleanup:'cleaned',controllerInput:'ack',controllerEnd:'ack',close:'closed'};
     if(frame.type!==expected[waiter.kind]){waiter.reject(new Error('Observer response operation mismatch'));throw new Error('Observer response operation mismatch');}waiter.resolve(frame.value);
    }
    if(buffer.length>1024*1024+4)throw new Error('Observer input buffer exceeded');
   }catch(error){fail(error);}});
   peer.on('close',(code,signal)=>{resolveExit({code,signal});if(!closing||buffer.length||code!==0||signal)fail(new Error(buffer.length?'Observer exited with truncated frame':'Observer lost; terminal outcome unknown'));});
   await write({observationVersion:1,...options.executionOwner,type:'start',controller:options.controller,boundaryHash:options.boundaryHash,rawOutputLimitBytes:options.rawOutputLimitBytes,unrelated:options.unrelated??null});
   const timer=setTimeout(()=>fail(new Error('Observer start identity timeout')),15000);try{return await startReceipt;}finally{clearTimeout(timer);}
  },
  async describeObservedExecution(){const value=ObservedExecutionSchema.parse(await request('describeObservedExecution'));if(!same(ownerOf(value),options.executionOwner)||value.boundaryHash!==options.boundaryHash||value.observer.pid!==peer?.pid||startObservation&&(!same(value.observer,startObservation.observer)||!same(value.controller,startObservation.controller)||value.outerJobIdentity!==startObservation.outerJobIdentity))throw new Error('Observed execution identity mismatch');if(description&&!same({...description,descendants:[]},{...value,descendants:[]}))throw new Error('Observed execution changed');description=structuredClone(value);return value;},
  async triggerDeath(input){const target=ObservationDeathTargetSchema.parse(input);const observed=description??await client.describeObservedExecution();if(!same(target.identity,observed[target.kind]))throw new Error('Death target identity mismatch');const value=ObservationTriggerSchema.parse(await request('triggerDeath',{target}));if(!same(value.target,target))throw new Error('Death trigger identity mismatch');return value;},
  async observeTerminal(timeoutMs=20000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Invalid observation timeout');const value=QualificationTerminalSchema.parse(await request('observeTerminal',{timeoutMs},timeoutMs+1000));if(!same(ownerOf(value),options.executionOwner)||value.description.observer.pid!==peer?.pid||value.description.boundaryHash!==options.boundaryHash||startObservation&&(!same(value.description.observer,startObservation.observer)||!same(value.description.controller,startObservation.controller)||value.description.outerJobIdentity!==startObservation.outerJobIdentity))throw new Error('Terminal identity mismatch');if(description&&!same({...description,descendants:[]},{...value.description,descendants:[]}))throw new Error('Terminal execution changed');lastTerminal=structuredClone(value);return value;},
  async readCapturedOutput(){let offset=0,result:CapturedOutput|undefined;for(;;){const page=CapturedOutputSchema.parse(await request('readCapturedOutput',{offset}));if(page.offset!==undefined&&page.offset!==offset)throw new Error('Capture page offset mismatch');if(!result)result={...page,streams:page.streams.map(s=>({...s}))};else{for(const stream of page.streams){const previous=result.streams.find(s=>s.source===stream.source&&s.stream===stream.stream);if(!previous)throw new Error('Capture stream changed');previous.data=Buffer.concat([Buffer.from(previous.data,'base64'),Buffer.from(stream.data,'base64')]).toString('base64');previous.bytes=stream.bytes;previous.eofCount=stream.eofCount;}result.totalBytes=page.totalBytes;result.overflow=page.overflow;result.readerFailure=page.readerFailure;}
   const retained=result.streams.reduce((n,s)=>n+Buffer.from(s.data,'base64').length,0);if(retained>options.rawOutputLimitBytes)throw new Error('Capture exceeds bound');if(page.nextOffset==null){delete result.offset;delete result.nextOffset;return result;}if(page.nextOffset<=offset)throw new Error('Capture pagination did not advance');offset=page.nextOffset;}
  },
  async emergencyCleanup(reason){if(!reason.trim()||reason.length>4096)throw new Error('Invalid cleanup reason');const value=z.strictObject({emergencyTerminated:z.literal(true),observedAt:z.number().int().positive()}).parse(await request('emergencyCleanup',{reason}));cleaned=true;return value;},
  async close(){if(failed)throw failed;if(!cleaned&&!(lastTerminal?.outerMembershipEmpty&&lastTerminal.outputComplete))throw new Error('Guardian close requires reconciled terminal observation or emergency cleanup');closing=true;await request('close');peer!.stdin.end();let timer:NodeJS.Timeout|undefined;const result=await Promise.race([exitReceipt,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{fail(new Error('Guardian exit unobserved'));reject(failed);},5000);})]);clearTimeout(timer);if(result.code!==0||result.signal||failed)throw failed??new Error('Guardian exit was not clean');return {guardianExited:true,outputEof:true,exitCode:0,rawBytes,activeMs:Date.now()-startAt};},
  onRawOutput(listener){outputListeners.add(listener);for(const value of earlyOutput.splice(0))listener(value);earlyOutputBytes=0;return()=>outputListeners.delete(listener);},
  controller:{async write(bytes){if(bytes.length>65536)throw new Error('Controller input exceeds 64KiB');await request('controllerInput',{data:Buffer.from(bytes).toString('base64')});},onData(listener){controllerListeners.add(listener);for(const bytes of earlyController.splice(0))listener(bytes);earlyControllerBytes=0;return()=>controllerListeners.delete(listener);},async end(){await request('controllerEnd');}},
 };
 return client;
}
