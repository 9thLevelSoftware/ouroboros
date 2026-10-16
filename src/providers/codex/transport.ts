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
import { record } from './policy.ts';

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
export type Incoming={method:string;params:unknown;id?:string|number};
/** Narrow method allowlist, bounded pending work, no raw diagnostics or RPC errors escape. */
export class CodexTransport {
  private decoder=new JsonlDecoder();private sequence=0;private pending=new Map<string,Pending>();
  private listeners=new Set<(message:Incoming)=>void>();private failureListeners=new Set<(error:Error)=>void>();
  private failed:Error|undefined;private unsubscribe:()=>void=()=>{};private outputBytes=0;
  private sendTail:Promise<void>=Promise.resolve();private queuedBytes=0;
  private startupMessages:Array<{message:Incoming;bytes:number}>=[];private startupBytes=0;
  private readonly execution:OwnedExecution;private readonly timeoutMs:number;
  constructor(execution:OwnedExecution,options:{timeoutMs?:number}={}) {
    this.execution=execution;this.timeoutMs=options.timeoutMs??5000;
    if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>15000)throw Error('Invalid request timeout');
    this.unsubscribe=execution.onOutput(output=>{
      if(this.failed)return;
      try {this.outputBytes+=output.data.length;if(this.outputBytes>10*1024*1024)throw Error('Output budget exhausted');
        if(output.stream==='stdout')for(const value of this.decoder.push(output.data))this.receive(value);
      }catch {this.fail(Error('Codex transport framing, correlation or output failure'));}
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
    this.pending.delete(id);clearTimeout(pending.timer);
    if(Object.hasOwn(frame,'error'))pending.reject(Error('Codex RPC request failed'));else pending.resolve(frame.result);
  }
  async send(value:unknown):Promise<void>{
    if(this.failed)throw this.failed;const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length-1>MAX_FRAME)throw Error('Outgoing frame exceeds 1 MiB');
    if(this.queuedBytes+bytes.length>MAX_FRAME){this.fail(Error('Codex outgoing queue budget exhausted'));throw this.failed;}
    this.queuedBytes+=bytes.length;
    const write=this.sendTail.then(async()=>{
      for(let offset=0;offset<bytes.length;offset+=65536){
        if(this.failed)throw this.failed;
        const result=await this.execution.writeInput(bytes.subarray(offset,offset+65536));
        if(!result.ok){this.fail(Error('Owned Codex input rejected'));throw this.failed;}
      }
    });
    this.sendTail=write.catch(()=>{});
    try {await write;}finally{this.queuedBytes-=bytes.length;}
  }
  async request<M extends Method>(method:M,params:Params<M>):Promise<Responses[M]> {
    if(this.failed)throw this.failed;if(this.pending.size>=64)throw Error('Codex pending request budget exhausted');
    const id=`ouroboros-${++this.sequence}`;
    const response=new Promise<unknown>((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(Error('Codex request timeout')),this.timeoutMs);this.pending.set(id,{resolve,reject,timer});
    });
    void response.catch(()=>{});
    // Params<M> is extracted from this exact generated discriminant. TS cannot
    // distribute the generic pair back over the entire generated request union.
    const request={id,method,params} as Extract<ClientRequest,{method:M}>;
    // Await the correlated response directly: a stalled input must not hide the
    // finite response timeout. The send tail itself remains bounded and observed.
    void this.send(request).catch(()=>{this.fail(Error('Codex request send failure'));});
    return await response as Responses[M];
  }
  async initialize():Promise<InitializeResponse>{
    const result=await this.request('initialize',{clientInfo:{name:'ouroboros',title:'Ouroboros',version:'0.1.0'},capabilities:{experimentalApi:false,requestAttestation:false,explicitGatewayOauth:true}});
    if(typeof result.userAgent!=='string'||result.platformOs!=='windows')throw Error('Unexpected initialization metadata');
    await this.send({method:'initialized'});return result;
  }
  finish():void{try{this.decoder.finish();}catch{this.fail(Error('Incomplete Codex output'));throw this.failed;}}
  stop():void{this.fail(Error('Codex transport closed'));this.unsubscribe();this.listeners.clear();this.failureListeners.clear();}
}
