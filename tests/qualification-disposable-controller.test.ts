import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const loaded = await import('../src/qualification/disposable-controller.ts').catch(() => ({})) as any;
const frame = (value: unknown) => { const b = Buffer.from(JSON.stringify(value)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function setup() {
  let time = 1000;
  const owner = { runId:'11111111-1111-4111-8111-111111111111', generation:1, actionId:'22222222-2222-4222-8222-222222222222', role:'worker' };
  const spec = { ...owner, executable:'C:\\trusted\\codex.exe', argv:['app-server','--stdio'], cwd:'C:\\fixture\\workspace', env:{}, boundaryHash:'a'.repeat(64), authorization:{ kind:'qualification', requestId:'33333333-3333-4333-8333-333333333333', probeId:'worker.subscription_request', fixtureRoots:['C:\\fixture'] }, stdin:'pipe', leaseTtlMs:5000, deadline:10000 };
  const receipt = { schemaVersion:1, ...owner, environment:'windows', pid:10, creationIdentity:'root-10', helperPid:11, helperCreationIdentity:'helper-11', jobIdentity:'job-10', boundaryHash:spec.boundaryHash, assignedBeforeResume:true, capturedAt:1000 };
  const upstream = new EventEmitter(), downstream = new EventEmitter(), outputs = new EventEmitter();
  const writes:any[] = []; const raw:Buffer[] = []; let ended = false;
  const execution = { describe:vi.fn(async()=>receipt), fence:vi.fn(async()=>{}), renewLease:vi.fn(async()=>{}), drain:vi.fn(async()=>{ throw Error('helper closed without drainage'); }), writeInput:vi.fn(async()=>({ok:true,value:undefined})), endInput:vi.fn(async()=>({ok:true,value:undefined})), onOutput:vi.fn(()=>()=>{}) };
  const connect = vi.fn(async()=>({ok:true,value:execution}));
  const config = { controllerVersion:1, module:{path:'C:\\trusted\\disposable-controller.ts',sha256:'b'.repeat(64)}, dependencies:[], helper:{path:'C:\\trusted\\helper.exe',sha256:'c'.repeat(64)}, specHash:hash(spec), deadline:10000 };
  const serverIO = { onData:(fn:any)=>{upstream.on('data',fn);return()=>upstream.off('data',fn);}, onEnd:(fn:any)=>{upstream.on('end',fn);return()=>upstream.off('end',fn);}, write:(bytes:Uint8Array)=>{ const b=Buffer.from(bytes);writes.push(JSON.parse(b.subarray(4).toString()));downstream.emit('data',b); } };
  const channel = { write:async(bytes:Uint8Array)=>{upstream.emit('data',bytes);}, onData:(fn:any)=>{downstream.on('data',fn);return()=>downstream.off('data',fn);}, end:async()=>{ended=true;upstream.emit('end');} };
  const options = { now:()=>time, deadline:10000, moduleHash:config.module.sha256, effectGate:vi.fn(), onRawOutput:(fn:any)=>{outputs.on('data',fn);return()=>outputs.off('data',fn);}, onHelperRawBytes:(_stream:string,bytes:Uint8Array)=>raw.push(Buffer.from(bytes)), timeoutMs:100 };
  function server(){expect(typeof loaded.serveDisposableController).toBe('function');return loaded.serveDisposableController(config,serverIO,{now:()=>time,env:{},connect,handoff:()=>({file:config.helper.path,args:['--qualification-handoff-v1']})});}
  async function client(){expect(typeof loaded.connectDisposableController).toBe('function');const pending=loaded.connectDisposableController(channel,spec,options);server();return pending;}
  return {spec,receipt,config,server,client,channel,options,connect,execution,upstream,downstream,outputs,writes,raw,setTime:(n:number)=>{time=n;},ended:()=>ended};
}

describe('disposable controller uses the actual supervisor control path',()=>{
  it('starts only after exact launch dispatch and forwards owned input without copying the supervisor implementation',async()=>{const f=setup();const owned=await f.client();expect(f.connect).toHaveBeenCalledTimes(1);expect(f.connect.mock.calls[0][1]).toEqual(f.spec);expect(await owned.describe()).toEqual(f.receipt);await owned.writeInput(Buffer.from('fixed request'));expect(f.execution.writeInput).toHaveBeenCalledWith(Buffer.from('fixed request'));await owned.endInput();expect(f.execution.endInput).toHaveBeenCalledOnce();});
  it('rejects an altered launch or expired approval before the helper is created',async()=>{for(const expired of [false,true]){const f=setup();f.server();if(expired)f.setTime(10001);const spec=structuredClone(f.spec);if(!expired)spec.argv.push('unexpected');await f.channel.write(frame({controllerVersion:1,id:1,method:'launch',params:{spec}}));await new Promise(resolve=>setImmediate(resolve));expect(f.connect).not.toHaveBeenCalled();expect(f.writes.at(-1)).toMatchObject({kind:'error',id:1});}});
  it('rejects replay and arbitrary operations without a second helper',async()=>{const f=setup();await f.client();await f.channel.write(frame({controllerVersion:1,id:1,method:'launch',params:{spec:f.spec}}));await new Promise(resolve=>setImmediate(resolve));expect(f.connect).toHaveBeenCalledOnce();expect(f.writes.some(v=>v.kind==='error')).toBe(true);});
 it('drains a helper returned after the controller input closed during launch',async()=>{const f=setup();let release!:(value:any)=>void;f.connect.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));f.server();await f.channel.write(frame({controllerVersion:1,id:1,method:'launch',params:{spec:f.spec}}));await new Promise(resolve=>setImmediate(resolve));await f.channel.end();release({ok:true,value:f.execution});await new Promise(resolve=>setImmediate(resolve));expect(f.execution.fence).toHaveBeenCalledOnce();expect(f.execution.drain).toHaveBeenCalledOnce();expect(f.writes.some(v=>v.kind==='result'&&v.id===1)).toBe(false);});
  it('preserves helper-death drainage failure instead of manufacturing independent observer evidence',async()=>{const f=setup();const owned=await f.client();await expect(owned.drain('test')).rejects.toThrow();expect(f.execution.drain).toHaveBeenCalledWith('test');});
  it('receives root output only from the surviving observer and meters helper diagnostics separately',async()=>{const f=setup();const owned=await f.client();const seen:any[]=[];owned.onOutput(value=>seen.push(value));f.outputs.emit('data',{stream:'stdout',data:Buffer.from('root output')});expect(seen[0].data.toString()).toBe('root output');expect(f.execution.onOutput).not.toHaveBeenCalled();const meter=(f.connect.mock.calls[0] as any[])[3].onRawBytes;meter('helper','stderr',Buffer.from('helper diagnostic'));expect(f.raw.map(b=>b.toString())).toEqual(['helper diagnostic']);});
  it('checks fresh admission for input and leaves terminal cleanup available after expiry',async()=>{const f=setup();const owned=await f.client();f.options.effectGate.mockImplementation((kind:string)=>{if(kind!=='CLEANUP')throw Error('expired');});await expect(owned.writeInput(Buffer.from('late'))).rejects.toThrow();expect(f.execution.writeInput).not.toHaveBeenCalled();await owned.fence();expect(f.execution.fence).toHaveBeenCalledOnce();});
  it('fences on uncorrelated responses and never accepts output from the disposable controller as provider output',async()=>{const f=setup();const owned=await f.client();const seen:any[]=[];owned.onOutput(v=>seen.push(v));f.downstream.emit('data',frame({controllerVersion:1,kind:'result',id:999,value:{output:'forged'}}));await expect(owned.describe()).rejects.toThrow();expect(seen).toEqual([]);expect(f.ended()).toBe(true);});
  it('rejects oversized input before allocation or a helper launch',async()=>{const f=setup();f.server();const h=Buffer.alloc(4);h.writeUInt32LE(1024*1024+1);await f.channel.write(h);await new Promise(resolve=>setImmediate(resolve));expect(f.connect).not.toHaveBeenCalled();});
});

it('the protected entry point validates the actual source dependency graph before importing it',async()=>{
 const resource=await import('./fixtures/boundary/disposable-controller.mjs');
 const f=setup();f.config.module.path='C:\\trusted\\src\\qualification\\disposable-controller.ts';
 const paths=['src/runtime/supervisor.ts','src/runtime/qualification-observer.ts','src/contracts/execution.ts','src/contracts/qualification-observation.ts','src/contracts/common.ts','package.json','package-lock.json'];
 const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const bytes=Buffer.from('pinned fixture module');
 f.config.module.sha256=digest(bytes);f.config.helper.sha256=digest(bytes);
 (f.config as any).dependencies=paths.map(path=>({path:win32.join('C:\\trusted',path),sha256:digest(bytes)}));
 const serve=vi.fn(),importModule=vi.fn(async()=>({serveDisposableController:serve}));
 const io={readFile:()=>bytes,importModule,channel:{},env:{}};
 await resource.loadControllerResource([JSON.stringify(f.config)],io);expect(serve).toHaveBeenCalledOnce();
 importModule.mockClear();
 await expect(resource.loadControllerResource([JSON.stringify(f.config)],{...io,readFile:(path:string)=>path.endsWith('execution.ts')?Buffer.from('changed'):bytes})).rejects.toThrow('CONTROLLER_RESOURCE_CHANGED');
 expect(importModule).not.toHaveBeenCalled();
 await expect(resource.loadControllerResource([JSON.stringify({...f.config,dependencies:[]})],io)).rejects.toThrow('CONTROLLER_DEPENDENCY_PINS_REQUIRED');
});
