import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { z } from 'zod';
import { LaunchSpecSchema, WindowsOwnershipReceiptSchema, type ChildOutput, type LaunchSpec, type OwnedExecution } from '../contracts/execution.ts';
import { connectOwnedHelper } from '../runtime/supervisor.ts';
import { qualificationHandoffCommand } from '../runtime/qualification-observer.ts';

const MAX_FRAME = 1024 * 1024;
const Pin = z.strictObject({path:z.string().refine(path=>win32.isAbsolute(path)&&!path.includes('\0')),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const DisposableControllerConfigSchema = z.strictObject({controllerVersion:z.literal(1),module:Pin,dependencies:z.array(Pin).max(64),helper:Pin,specHash:Pin.shape.sha256,deadline:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)});
export type DisposableControllerConfig = z.infer<typeof DisposableControllerConfigSchema>;
export function disposableSpecHash(spec:LaunchSpec):string{return createHash('sha256').update(JSON.stringify(LaunchSpecSchema.parse(spec))).digest('hex');}
export type ControllerDuplex = {write(bytes:Uint8Array):Promise<void>;onData(listener:(bytes:Buffer)=>void):()=>void;end():Promise<void>};
export type ControllerServerIO = {write(bytes:Uint8Array):void;onData(listener:(bytes:Buffer)=>void):()=>void;onEnd(listener:()=>void):()=>void};
function encode(value:unknown):Buffer{const body=Buffer.from(JSON.stringify(value));if(!body.length||body.length>MAX_FRAME)throw Error('CONTROLLER_FRAME_LIMIT');const prefix=Buffer.alloc(4);prefix.writeUInt32LE(body.length);return Buffer.concat([prefix,body]);}
/** Length is validated before allocation. The controller channel is not provider output. */
class Decoder {
 private header=Buffer.alloc(4);private used=0;private body:Buffer|undefined;private count=0;
 push(chunk:Uint8Array):unknown[]{const result:unknown[]=[];let at=0;while(at<chunk.length){if(!this.body){const n=Math.min(4-this.used,chunk.length-at);this.header.set(chunk.subarray(at,at+n),this.used);this.used+=n;at+=n;if(this.used<4)break;const size=this.header.readUInt32LE();if(!size||size>MAX_FRAME)throw Error('CONTROLLER_FRAME_LIMIT');this.body=Buffer.alloc(size);this.count=0;}const n=Math.min(this.body.length-this.count,chunk.length-at);this.body.set(chunk.subarray(at,at+n),this.count);this.count+=n;at+=n;if(this.count===this.body.length){result.push(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.body)));this.body=undefined;this.used=0;}}return result;}
}
const Base64=z.string().max(90000).refine(s=>Buffer.from(s,'base64').toString('base64')===s);
const Request=z.discriminatedUnion('method',[
 z.strictObject({controllerVersion:z.literal(1),id:z.number().int().positive(),method:z.literal('launch'),params:z.strictObject({spec:LaunchSpecSchema})}),
 z.strictObject({controllerVersion:z.literal(1),id:z.number().int().positive(),method:z.enum(['describe','fence','drain','endInput']),params:z.strictObject({reason:z.string().min(1).max(256).optional()})}),
 z.strictObject({controllerVersion:z.literal(1),id:z.number().int().positive(),method:z.literal('renewLease'),params:z.strictObject({sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)})}),
 z.strictObject({controllerVersion:z.literal(1),id:z.number().int().positive(),method:z.literal('writeInput'),params:z.strictObject({data:Base64})}),
]);

/** Runs only in the protected disposable controller. The implementation uses the
 * existing supervisor client; the observer supplies root output independently. */
export function serveDisposableController(raw:DisposableControllerConfig,io:ControllerServerIO,deps:{now?:()=>number;env?:NodeJS.ProcessEnv;connect?:typeof connectOwnedHelper;handoff?:typeof qualificationHandoffCommand}={}) {
 const config=DisposableControllerConfigSchema.parse(raw),now=deps.now??Date.now,decode=new Decoder();
 let execution:OwnedExecution|undefined,launched=false,sequence=0,closed=false,fenced=false,cleanupStarted=false;let tail=Promise.resolve();
 const send=(value:unknown)=>io.write(encode({controllerVersion:1,...value as Record<string,unknown>}));
 const cleanup=async()=>{closed=true;if(execution&&!cleanupStarted){cleanupStarted=true;try{await execution.fence();}catch{}try{await execution.drain('controller-channel-closed');}catch{}}};
 const processRequest=async(rawRequest:unknown)=>{
  let id=0;
  try {
   const request=Request.parse(rawRequest);id=request.id;if(id<=sequence||closed)throw Error('CONTROLLER_REPLAY');sequence=id;
   const terminal=['describe','fence','drain','endInput'].includes(request.method);
   if(!terminal&&(fenced||now()>=config.deadline))throw Error('CONTROLLER_AUTHORITY_EXPIRED');
   let value:unknown;
   if(request.method==='launch'){
    if(launched||disposableSpecHash(request.params.spec)!==config.specHash||request.params.spec.deadline>config.deadline||request.params.spec.deadline<=now())throw Error('CONTROLLER_LAUNCH_MISMATCH');
    launched=true;const spec=request.params.spec;
    const command=(deps.handoff??qualificationHandoffCommand)(config.helper.path,deps.env??process.env);
    const result=await (deps.connect??connectOwnedHelper)(command,spec,'windows',{onRawBytes:(_source,stream,bytes)=>{
     for(let at=0;at<bytes.length;at+=65536)send({kind:'helper-raw',stream,data:Buffer.from(bytes.subarray(at,at+65536)).toString('base64')});
    }});
    if(!result.ok)throw Error('CONTROLLER_LAUNCH_FAILED');execution=result.value;
    if(closed||fenced||now()>=config.deadline){await cleanup();throw Error('CONTROLLER_AUTHORITY_EXPIRED');}
    value=await execution.describe();
   }else{
    if(!execution)throw Error('CONTROLLER_NOT_LAUNCHED');
    switch(request.method){
     case 'describe':value=await execution.describe();break;
     case 'fence':fenced=true;await execution.fence();value=null;break;
     case 'drain':fenced=true;value=await execution.drain(request.params.reason??'qualification-cleanup');break;
     case 'renewLease':await execution.renewLease(request.params.sequence);value=null;break;
     case 'writeInput':{const bytes=Buffer.from(request.params.data,'base64');if(bytes.length>65536)throw Error('CONTROLLER_INPUT_LIMIT');value=await execution.writeInput(bytes);break;}
     case 'endInput':value=await execution.endInput();break;
    }
   }
   send({kind:'result',id,value});
  }catch{fenced=true;send({kind:'error',id,code:'CONTROLLER_OPERATION_FAILED'});void cleanup();}
 };
 const detach=io.onData(bytes=>{try{for(const value of decode.push(bytes))tail=tail.then(()=>processRequest(value)).catch(()=>cleanup());}catch{void cleanup();}});
 const detachEnd=io.onEnd(()=>{void cleanup();});
 send({kind:'ready',specHash:config.specHash,moduleHash:config.module.sha256});
 return {async close(){detach();detachEnd();await cleanup();}};
}

/** Call inside the campaign's admitted launch operation. Construction subscribes
 * before the guardian starts; no child is created until the exact launch RPC. */
export async function connectDisposableController(channel:ControllerDuplex,input:LaunchSpec,options:{deadline:number;moduleHash:string;now?:()=>number;effectGate(kind:'ACTIVE'|'CLEANUP'):void;onRawOutput(listener:(output:ChildOutput)=>void):()=>void;onHelperRawBytes?:(stream:'stdout'|'stderr',bytes:Uint8Array)=>void;timeoutMs?:number}):Promise<OwnedExecution>{
 const spec=LaunchSpecSchema.parse(input),specHash=disposableSpecHash(spec),decode=new Decoder(),now=options.now??Date.now;
 const {deadline,moduleHash,effectGate,onRawOutput,onHelperRawBytes}=options;
 const timeout=options.timeoutMs??15000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>15000||spec.deadline>deadline)throw Error('CONTROLLER_LIMITS_INVALID');
 let sequence=0,failure:Error|undefined,ready=false;const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
 let readyResolve!:()=>void,readyReject!:(error:Error)=>void;
 const readiness=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void readiness.catch(()=>{});
 const fail=()=>{if(failure)return;failure=Error('DISPOSABLE_CONTROLLER_UNKNOWN');clearTimeout(readyTimer);readyReject(failure);for(const item of pending.values()){clearTimeout(item.timer);item.reject(failure);}pending.clear();void channel.end().catch(()=>{});};
 const readyTimer=setTimeout(fail,timeout);
 channel.onData(bytes=>{try{for(const raw of decode.push(bytes)){
  const value=raw as Record<string,unknown>;if(!value||value.controllerVersion!==1)throw Error('INVALID_CONTROLLER_FRAME');
  if(value.kind==='ready'){if(ready||value.specHash!==specHash||value.moduleHash!==moduleHash)throw Error('CONTROLLER_IDENTITY_MISMATCH');ready=true;clearTimeout(readyTimer);readyResolve();continue;}
  if(value.kind==='helper-raw'){if(!ready||!['stdout','stderr'].includes(value.stream as string)||typeof value.data!=='string')throw Error('INVALID_AUXILIARY_OUTPUT');const data=Base64.parse(value.data);onHelperRawBytes?.(value.stream as 'stdout'|'stderr',Buffer.from(data,'base64'));continue;}
  const item=pending.get(value.id as number);if(!item||!['result','error'].includes(value.kind as string))throw Error('UNCORRELATED_CONTROLLER_FRAME');pending.delete(value.id as number);clearTimeout(item.timer);if(value.kind==='error')item.reject(Error('CONTROLLER_OPERATION_FAILED'));else item.resolve(value.value);
 }}catch{fail();}});
 const request=async(method:string,params:Record<string,unknown>={},cleanup=false):Promise<unknown>=>{
  if(failure)throw failure;effectGate(cleanup?'CLEANUP':'ACTIVE');if(!cleanup&&now()>=deadline)throw Error('CONTROLLER_AUTHORITY_EXPIRED');if(pending.size>=8)throw Error('CONTROLLER_PENDING_LIMIT');
  const id=++sequence;const response=new Promise<unknown>((resolve,reject)=>{const timer=setTimeout(fail,timeout);pending.set(id,{resolve,reject,timer});});void response.catch(()=>{});
  const bytes=encode({controllerVersion:1,id,method,params});
  try{for(let at=0;at<bytes.length;at+=65536){effectGate(cleanup?'CLEANUP':'ACTIVE');if(!cleanup&&now()>=deadline)throw Error('CONTROLLER_AUTHORITY_EXPIRED');await channel.write(bytes.subarray(at,at+65536));}}catch{fail();}
  return response;
 };
 await readiness;const receipt=WindowsOwnershipReceiptSchema.parse(await request('launch',{spec}));
 if(Object.entries({runId:spec.runId,generation:spec.generation,actionId:spec.actionId,role:spec.role,boundaryHash:spec.boundaryHash}).some(([key,value])=>receipt[key as keyof typeof receipt]!==value)){fail();throw Error('CONTROLLER_OWNERSHIP_MISMATCH');}
 return {
  async describe(){const actual=WindowsOwnershipReceiptSchema.parse(await request('describe',{},true));if(JSON.stringify(actual)!==JSON.stringify(receipt)){fail();throw Error('CONTROLLER_OWNERSHIP_CHANGED');}return actual;},
  async fence(){await request('fence',{},true);},async drain(reason){return await request('drain',{reason},true) as Awaited<ReturnType<OwnedExecution['drain']>>;},
  async renewLease(value){await request('renewLease',{sequence:value});},
  async writeInput(bytes){if(bytes.length>65536)throw Error('CONTROLLER_INPUT_LIMIT');return await request('writeInput',{data:Buffer.from(bytes).toString('base64')}) as Awaited<ReturnType<OwnedExecution['writeInput']>>;},
  async endInput(){return await request('endInput',{},true) as Awaited<ReturnType<OwnedExecution['endInput']>>;},
  onOutput(listener){return onRawOutput(listener);},
 };
}
