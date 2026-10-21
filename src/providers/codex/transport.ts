import type { OwnedExecution } from '../../contracts/execution.ts';
import type { ClientRequest } from './protocol/0.162.1/typescript/ClientRequest.js';
import type { InitializeResponse } from './protocol/0.162.1/typescript/InitializeResponse.js';
import type { GetAccountResponse } from './protocol/0.162.1/typescript/v2/GetAccountResponse.js';
import type { ConfigReadResponse } from './protocol/0.162.1/typescript/v2/ConfigReadResponse.js';
import type { ConfigRequirementsReadResponse } from './protocol/0.162.1/typescript/v2/ConfigRequirementsReadResponse.js';
import type { ModelListResponse } from './protocol/0.162.1/typescript/v2/ModelListResponse.js';
import type { ThreadStartResponse } from './protocol/0.162.1/typescript/v2/ThreadStartResponse.js';
import type { ThreadResumeResponse } from './protocol/0.162.1/typescript/v2/ThreadResumeResponse.js';
import type { TurnStartResponse } from './protocol/0.162.1/typescript/v2/TurnStartResponse.js';
import type { TurnInterruptResponse } from './protocol/0.162.1/typescript/v2/TurnInterruptResponse.js';
import { codexRemoteControlState, isInformationalCodexNotification, record } from './policy.ts';

const MAX_FRAME=1024*1024;
/** Fixed storage bounds apply before copying a fragment; invalid UTF-8 is fatal. */
export class JsonlDecoder {
  private bytes=Buffer.alloc(MAX_FRAME); private used=0; private failed=false;
  push(chunk:Uint8Array): unknown[] {
    if(this.failed)throw Error('JSONL decoder failed');const messages:unknown[]=[];
    try {
      let offset=0;
      while(offset<chunk.length){
        let end=offset;while(end<chunk.length && chunk[end]!==10)end++;
        const size=end-offset;if(this.used+size>MAX_FRAME)throw Error('JSONL frame exceeds 1 MiB');
        this.bytes.set(chunk.subarray(offset,end),this.used);this.used+=size;
        if(end===chunk.length)break;
        const text=new TextDecoder('utf-8',{fatal:true}).decode(this.bytes.subarray(0,this.used));
        if(!text.trim())throw Error('Empty JSONL frame');messages.push(JSON.parse(text));this.used=0;offset=end+1;
      }
      return messages;
    } catch {this.failed=true;throw Error('Invalid, oversized or non-UTF8 JSONL frame');}
  }
  finish():void{if(this.failed || this.used)throw Error('Truncated or failed JSONL stream');}
}
type Responses={initialize:InitializeResponse;'account/read':GetAccountResponse;'config/read':ConfigReadResponse;
  'configRequirements/read':ConfigRequirementsReadResponse;'model/list':ModelListResponse;
  'thread/start':ThreadStartResponse;'thread/resume':ThreadResumeResponse;'turn/start':TurnStartResponse;'turn/interrupt':TurnInterruptResponse};
type Method=keyof Responses;
type Params<M extends Method>=Extract<ClientRequest,{method:M}>['params'];
type Pending={resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout};
export type SafeCodexRpcFailure={code:number|null;reason:'ALREADY_INITIALIZED'|'NOT_INITIALIZED'|'EXPERIMENTAL_API_REQUIRED'|'INVALID_REQUEST'|'INVALID_PARAMS'|'UNRECOGNIZED'};
export type SafeCodexTransportFailure={reason:'REQUEST_TIMEOUT'|'WRITE_TIMEOUT'|'SEND_FAILED'|'INPUT_REJECTED'|'FRAMING_OR_CORRELATION'|'WRITES_FENCED'|'UNEXPECTED_INITIALIZATION'|'CLOSED';timeoutMs?:number};
export class CodexTransportError extends Error{
  readonly fact:SafeCodexTransportFailure;
  constructor(reason:SafeCodexTransportFailure['reason'],timeoutMs?:number){super(reason==='REQUEST_TIMEOUT'||reason==='WRITE_TIMEOUT'?'Codex transport timeout':'Codex transport failed');this.fact=Object.freeze({reason,...(timeoutMs===undefined?{}:{timeoutMs})});}
}
/** Error payloads can contain credentials, prompts and host paths. Preserve only
 * the numeric JSON-RPC code and a finite structural classification. */
export class CodexRpcError extends Error {
  readonly fact:SafeCodexRpcFailure;
  constructor(raw:unknown){
    super('Codex RPC request failed');
    const error=record(raw);const code=typeof error.code==='number'&&Number.isInteger(error.code)&&error.code>=-2147483648&&error.code<=2147483647?error.code:null;
    const message=error.message;
    const reason:SafeCodexRpcFailure['reason']=message==='Already initialized'?'ALREADY_INITIALIZED':message==='Not initialized'?'NOT_INITIALIZED':typeof message==='string'&&/^[A-Za-z][A-Za-z0-9/]*(?:\.[A-Za-z0-9]+)? requires experimentalApi capability$/.test(message)?'EXPERIMENTAL_API_REQUIRED':typeof message==='string'&&message.startsWith('Invalid request: ')?'INVALID_REQUEST':code===-32602?'INVALID_PARAMS':'UNRECOGNIZED';
    this.fact=Object.freeze({code,reason});
  }
}
export type Incoming={method:string;params:unknown;id?:string|number};
const INITIALIZE_PARAMS={clientInfo:{name:'ouroboros',title:'Ouroboros',version:'0.1.0'},capabilities:{experimentalApi:false,requestAttestation:false,explicitGatewayOauth:true}};
const METADATA_CLIENT_PREFIX='ouroboros-qualification-';
/** The controller must allocate a cryptographically fresh, never-reused action.
 * This derivation binds its wire name; it does not establish durable freshness. */
export function qualificationMetadataClientName(actionId:string):string {
  if(typeof actionId!=='string'||actionId.length!==36||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(actionId))throw Error('Invalid metadata action identity');
  return METADATA_CLIENT_PREFIX+actionId;
}
type MetadataOptions={cwd:string;clientName:string;admissionDeadline?:number;now?:()=>number};
function sameShape(a:unknown,b:unknown):boolean {
  if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)||Array.isArray(b))return false;
  const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
  return Object.keys(left).length===Object.keys(right).length&&Object.keys(right).every(key=>Object.hasOwn(left,key)&&sameShape(left[key],right[key]));
}
/** Narrow method allowlist, bounded pending work, no raw diagnostics or RPC errors escape. */
export class CodexTransport {
  private decoder=new JsonlDecoder();private sequence=0;private pending=new Map<string,Pending>();
  private listeners=new Set<(message:Incoming)=>void>();private failureListeners=new Set<(error:Error)=>void>();
  private failed:Error|undefined;private unsubscribe:()=>void=()=>{};private outputBytes=0;
  private sendTail:Promise<void>=Promise.resolve();private queuedBytes=0;
  private startupMessages:Array<{message:Incoming;bytes:number}>=[];private startupBytes=0;
  private readonly execution:OwnedExecution;private readonly timeoutMs:number;
  private readonly initializationTimeoutMs:number;
  private readonly metadata:Readonly<MetadataOptions>|undefined;private metadataStep=0;private initializationValidated=false;private remoteStatusReports=0;private informationalReports=0;
  private readonly initializeParams:typeof INITIALIZE_PARAMS;
  private writesFenced=false;private framingFailed=false;
  constructor(execution:OwnedExecution,options:{timeoutMs?:number;initializationTimeoutMs?:number;maxOutputBytes?:number;metadata?:MetadataOptions;observeThreadSettings?:boolean}={}) {
    this.execution=execution;this.timeoutMs=options.timeoutMs??5000;
    this.initializationTimeoutMs=options.initializationTimeoutMs??this.timeoutMs;
    this.metadata=options.metadata?Object.freeze({...options.metadata}):undefined;
    if(this.metadata&&(typeof this.metadata.clientName!=='string'||!this.metadata.clientName.startsWith(METADATA_CLIENT_PREFIX)||this.metadata.clientName!==qualificationMetadataClientName(this.metadata.clientName.slice(METADATA_CLIENT_PREFIX.length))))throw Error('Invalid metadata client name');
    // thread/settings/updated is experimental in the pinned protocol. Workers
    // need that observation; qualification metadata retains its stable wire image.
    this.initializeParams=this.metadata?{...INITIALIZE_PARAMS,clientInfo:{...INITIALIZE_PARAMS.clientInfo,name:this.metadata.clientName}}:options.observeThreadSettings?{...INITIALIZE_PARAMS,capabilities:{...INITIALIZE_PARAMS.capabilities,experimentalApi:true}}:INITIALIZE_PARAMS;
    if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>15000)throw Error('Invalid request timeout');
    if(!Number.isSafeInteger(this.initializationTimeoutMs)||this.initializationTimeoutMs<1||this.initializationTimeoutMs>60000)throw Error('Invalid initialization timeout');
    this.unsubscribe=execution.onOutput(output=>{
      if(this.failed&&!this.metadata)return;
      try {this.outputBytes+=output.data.length;if(this.outputBytes>(options.maxOutputBytes??10*1024*1024))throw Error('Output budget exhausted');
        if(output.stream==='stdout')for(const value of this.decoder.push(output.data))this.receive(value);
      }catch {this.framingFailed=true;this.fail(new CodexTransportError('FRAMING_OR_CORRELATION'));}
    });
  }
  onMessage(listener:(message:Incoming)=>void):()=>void {
    this.listeners.add(listener);
    const startup=this.startupMessages.splice(0);this.startupBytes=0;
    try {for(const {message} of startup){if(this.failed)break;listener(message);}}
    catch {this.fail(Error('Codex notification handler failed'));}
    return()=>this.listeners.delete(listener);
  }
  onFailure(listener:(error:Error)=>void):()=>void {this.failureListeners.add(listener);if(this.failed)listener(this.failed);return()=>this.failureListeners.delete(listener);}
  private fail(error:Error):void {if(this.failed)return;this.failed=error;this.startupMessages=[];this.startupBytes=0;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();for(const fn of this.failureListeners)fn(error);}
  private receive(value:unknown):void {
    const frame=record(value);const id=frame.id;
    if(typeof frame.method==='string'){
      if(this.metadata){
        if(id===undefined&&isInformationalCodexNotification(frame.method,frame.params)){if(++this.informationalReports>32)throw Error('Metadata informational notification limit');return;}
        if(frame.method!=='remoteControl/status/changed'||Object.hasOwn(frame,'result')||Object.hasOwn(frame,'error')||id!==undefined||!Object.hasOwn(frame,'params')||++this.remoteStatusReports>32||codexRemoteControlState(frame.params)!=='disabled')throw Error('Unexpected metadata server message');
        // The pinned server emits this state after initialize. Consume the safe
        // classification only; never retain or forward remote identity strings.
        return;
      }
      if(id!==undefined && typeof id!=='string' && (typeof id!=='number'||!Number.isSafeInteger(id)))throw Error('Invalid server request id');
      if(!Object.hasOwn(frame,'params') || Object.hasOwn(frame,'result') || Object.hasOwn(frame,'error'))throw Error('Invalid method envelope');
      const message={method:frame.method,params:frame.params,...(id===undefined?{}:{id:id as string|number})};
      if(!this.listeners.size){
        const bytes=Buffer.byteLength(JSON.stringify(frame));
        if(this.startupMessages.length>=32||this.startupBytes+bytes>MAX_FRAME){this.fail(Error('Codex startup notification retention budget exhausted'));return;}
        this.startupMessages.push({message,bytes});this.startupBytes+=bytes;
      }else for(const listener of this.listeners)listener(message);
      return;
    }
    if(typeof id!=='string')throw Error('Unknown response identity');const pending=this.pending.get(id);
    if(!pending || Object.hasOwn(frame,'result')===Object.hasOwn(frame,'error'))throw Error('Uncorrelated or ambiguous response');
    if(this.metadata&&this.writesFenced)throw Error('Invalid metadata response envelope');
    this.pending.delete(id);clearTimeout(pending.timer);
    if(Object.hasOwn(frame,'error'))pending.reject(new CodexRpcError(frame.error));else pending.resolve(frame.result);
  }
  async send(value:unknown):Promise<void>{
    if(this.failed)throw this.failed;if(this.writesFenced)throw Error('Codex writes fenced');
    const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length-1>MAX_FRAME)throw Error('Outgoing frame exceeds 1 MiB');
    if(this.queuedBytes+bytes.length>MAX_FRAME){this.fail(Error('Codex outgoing queue budget exhausted'));throw this.failed;}
    this.queuedBytes+=bytes.length;
    const write=this.sendTail.then(async()=>{
      if(this.failed)throw this.failed;if(this.writesFenced)throw Error('Codex writes fenced');
      // Validate the immutable full wire image at the sole writer, before chunking.
      if(this.metadata){
        const expected=[{id:'ouroboros-1',method:'initialize',params:this.initializeParams},
          {method:'initialized'}, {id:'ouroboros-2',method:'account/read',params:{refreshToken:false}},
          {id:'ouroboros-3',method:'config/read',params:{includeLayers:false,cwd:this.metadata.cwd}},
          {id:'ouroboros-4',method:'configRequirements/read'}][this.metadataStep];
        const frame=JSON.parse(bytes.toString('utf8'));const isRequest=this.metadataStep!==1;
        if(!expected||!sameShape(frame,expected)||(isRequest&&!this.pending.has(frame.id))||
          (this.metadataStep>0&&!this.initializationValidated)||(!isRequest&&this.pending.size!==0)){
          this.fail(Error('Codex metadata outbound boundary refused'));throw this.failed;
        }
        this.metadataStep++;
      }
      for(let offset=0;offset<bytes.length;offset+=65536){
        if(this.failed)throw this.failed;if(this.writesFenced)throw Error('Codex writes fenced');
        // This sole writer rechecks after every await, including initialized
        // after initialize and queued/chunked sends. Expiry cannot release bytes.
        if(this.metadata?.admissionDeadline!==undefined){const now=(this.metadata.now??Date.now)();if(!Number.isSafeInteger(now)||now>=this.metadata.admissionDeadline)throw Error('Codex metadata dispatch permission expired');}
        const input=this.execution.writeInput(bytes.subarray(offset,offset+65536));
        // Worker dispatch retains its existing response timer behavior. Metadata
        // writes themselves also have a finite wait, including notifications.
        let timer:NodeJS.Timeout|undefined;
        const result=await (this.metadata?Promise.race([input,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new CodexTransportError('WRITE_TIMEOUT',this.timeoutMs)),this.timeoutMs);})]).finally(()=>clearTimeout(timer)):input);
        if(!result.ok){this.fail(new CodexTransportError('INPUT_REJECTED'));throw this.failed;}
      }
    });
    this.sendTail=write.catch(()=>{});
    try {await write;}catch(error){if(this.metadata){this.fail(error instanceof CodexTransportError?error:new CodexTransportError('SEND_FAILED'));throw this.failed;}throw error;}finally{this.queuedBytes-=bytes.length;}
  }
  async request<M extends Method>(method:M,params:Params<M>):Promise<Responses[M]> {
    if(this.failed)throw this.failed;if(this.writesFenced)throw Error('Codex writes fenced');if(this.pending.size>=(this.metadata?1:64))throw Error('Codex pending request budget exhausted');
    const id=`ouroboros-${++this.sequence}`;
    const response=new Promise<unknown>((resolve,reject)=>{
      const timeoutMs=method==='initialize'?this.initializationTimeoutMs:this.timeoutMs;
      const timer=setTimeout(()=>this.fail(new CodexTransportError('REQUEST_TIMEOUT',timeoutMs)),timeoutMs);this.pending.set(id,{resolve,reject,timer});
    });
    void response.catch(()=>{});
    // Params<M> is extracted from this exact generated discriminant. TS cannot
    // distribute the generic pair back over the entire generated request union.
    const request={id,method,params} as Extract<ClientRequest,{method:M}>;
    // Await the correlated response directly: a stalled input must not hide the
    // finite response timeout. The send tail itself remains bounded and observed.
    void this.send(request).catch(error=>{this.fail(error instanceof CodexTransportError?error:new CodexTransportError('SEND_FAILED'));});
    return await response as Responses[M];
  }
  async initialize():Promise<InitializeResponse>{
    const result=await this.request('initialize',this.initializeParams);
    if(typeof result.userAgent!=='string'||result.platformOs!=='windows')throw new CodexTransportError('UNEXPECTED_INITIALIZATION');
    if(this.metadata&&(result.platformFamily!=='windows'||result.userAgent.length>128||typeof result.codexHome!=='string'||result.codexHome.length>1024))throw Error('Unexpected metadata initialization identity');
    this.initializationValidated=true;
    await this.send({method:'initialized'});return result;
  }
  /** Fences protocol writes while retaining output observation until drainage. */
  fence():void{this.writesFenced=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new CodexTransportError('WRITES_FENCED'));}this.pending.clear();}
  metadataEvidence():{framesAdmitted:number;outputBytes:number;boundaryFailed:boolean}{return {framesAdmitted:this.metadataStep,outputBytes:this.outputBytes,boundaryFailed:!!this.failed||this.framingFailed};}
  finish():void{try{this.decoder.finish();if(this.metadata&&this.framingFailed)throw Error('Metadata stream failed');}catch{this.fail(Error('Incomplete Codex output'));throw this.failed;}}
  stop():void{this.fail(new CodexTransportError('CLOSED'));this.unsubscribe();this.listeners.clear();this.failureListeners.clear();}
}
