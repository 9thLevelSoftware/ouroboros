import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { fingerprint } from '../src/qualification/probes.ts';
import { encodeFrame } from '../src/runtime/supervisor.ts';
import { disposableSpecHash, serveDisposableController } from '../src/qualification/disposable-controller.ts';
const mocks=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:mocks.spawn}));
const modulePath='../src/qualification/observed-supervisor.ts';
const loaded=await import(modulePath).catch(()=>({})) as any;
const bytes=Buffer.from('fixture pinned bytes'),sha=createHash('sha256').update(bytes).digest('hex');
const pin=(path:string)=>({path,sha256:sha});
function fixture(){
 const now=Date.now(),runId='11111111-1111-4111-8111-111111111111';
 const spec=(digit:string,role:string)=>({runId,generation:1,actionId:`${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,role,executable:'C:\\trusted\\node.exe',argv:[],cwd:'C:\\fixture',env:{PATH:'C:\\trusted'},boundaryHash:'a'.repeat(64),authorization:{kind:'qualification' as const,requestId:'99999999-9999-4999-8999-999999999999',probeId:'auxiliary.preparation',fixtureRoots:['C:\\fixture']},stdin:'pipe' as const,leaseTtlMs:10000,deadline:now+60000});
 const root=spec('2','worker');root.executable='C:\\trusted\\codex.exe';root.argv=['app-server','--stdio'];root.env={};
 const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const intent:any={schemaVersion:2,phase:'PRE_PROCESS',requestId:root.authorization.requestId,owner:{runId,generation:1,actionId:root.actionId,role:root.role},workspace:root.cwd,configAncestry:['C:\\',root.cwd],runtime:{...pin(root.executable),version:'0.162.1'},node:{...pin('C:\\trusted\\node.exe'),version:'24.19.0'},helper:pin('C:\\trusted\\helper.exe'),controllerHash:sha,protocolHash:sha,environmentHash:digest(root.env),configHash:sha,boundaryHash:root.boundaryHash,argumentsHash:digest(root.argv),profile:'ouroboros_worker',sandbox:'mxc',environmentKeys:[],issuedAt:now,expiresAt:root.deadline,authMode:'managed-chatgpt',action:'worker-start',dispatchAuthorization:root.authorization,adapterHash:sha,verifierHash:sha,osCapabilitiesHash:sha,controlHash:sha,dispatchHash:sha,model:'fixture-model',effort:'high',budget:{activeMs:30000,outputBytes:262144,cleanupMs:15000}};
 const guardian=spec('3','guardian');guardian.executable='C:\\trusted\\helper.exe';guardian.argv=['--qualification-observer-v1'];
 const controller=spec('4','controller');
 const dependencies=['src/runtime/supervisor.ts','src/runtime/qualification-observer.ts','src/contracts/execution.ts','src/contracts/qualification-observation.ts','src/contracts/common.ts','package.json','package-lock.json'].map(path=>pin('C:\\trusted\\'+path.replaceAll('/','\\')));
 const config={controllerVersion:1,module:pin('C:\\trusted\\src\\qualification\\disposable-controller.ts'),dependencies,helper:pin(guardian.executable),specHash:disposableSpecHash(root),deadline:root.deadline};
 const loader=pin('C:\\fixture\\driver\\disposable-controller.mjs');controller.argv=['--experimental-strip-types',loader.path,JSON.stringify(config)];
 const binding={helperPath:guardian.executable,guardian,controller,executionOwner:{runId,generation:1,actionId:root.actionId,role:root.role},boundaryHash:root.boundaryHash,rawOutputLimitBytes:65536,primaryIntentHash:fingerprint(intent)};
 const recipes={guardian:{kind:'auxiliary',actionId:guardian.actionId,role:'guardian',launch:guardian,executableHash:sha,resources:[pin(guardian.executable),pin(root.executable)],bindingHash:fingerprint(binding)},controller:{kind:'auxiliary',actionId:controller.actionId,role:'controller',launch:controller,executableHash:sha,resources:[loader,config.module,config.helper,...dependencies],bindingHash:fingerprint(binding)}};
 const capture=()=>({write:vi.fn(),processCompleted:vi.fn()});const captures={guardian:capture(),controller:capture()},gates={guardian:vi.fn(),controller:vi.fn()};
 const primitive={readFile:vi.fn(async()=>bytes),realpath:vi.fn(async(path:string)=>path),now:()=>now};
 const controls:any[]=[];let peer:any;let missingMeter=false;
 const helperReceipt={schemaVersion:1,...binding.executionOwner,environment:'windows',pid:13,creationIdentity:'root-13',helperPid:12,helperCreationIdentity:'helper-12',jobIdentity:'inner',boundaryHash:root.boundaryHash,assignedBeforeResume:true,capturedAt:now};
 const helper={describe:vi.fn(async()=>helperReceipt),fence:vi.fn(async()=>{}),drain:vi.fn(async()=>{throw Error('no synthetic drain');}),renewLease:vi.fn(async()=>{}),writeInput:vi.fn(async()=>({ok:true,value:undefined})),endInput:vi.fn(async()=>({ok:true,value:undefined})),onOutput:vi.fn(()=>()=>{})};
 const serverEvents=new EventEmitter();
 const identity=(pid:number)=>({pid,creationIdentity:['','','','','','','','','','','observer-10','controller-11','helper-12','root-13'][pid]});
 const terminal=()=>({schemaVersion:1,...binding.executionOwner,description:{schemaVersion:1,...binding.executionOwner,boundaryHash:root.boundaryHash,observer:identity(10),controller:identity(11),helper:identity(12),root:identity(13),outerJobIdentity:'outer',innerJobIdentity:'inner',proofMethod:'windows-outer-superset-v1',nestedSubsetEstablished:true,assignedBeforeResume:true,handoffBeforeResume:true,helperOwnsOnlyInnerJobHandle:true,capturedAt:now,descendants:[]},rootLifetimeMs:0,helperLifetimeMs:0,processMeters:['root','helper','controller','guardian'].filter(kind=>!missingMeter||kind!=='controller').map((kind,index)=>({kind,identity:identity({root:13,helper:12,controller:11,guardian:10}[kind]!),createdAt:now,exitedAt:kind==='guardian'?null:now,activeMs:0,outputBytes:0})),processMeterError:missingMeter,rootExited:true,rootExitCode:0,controllerExitCode:0,rootExitCause:'natural',helperExited:true,controllerExited:true,outerActiveProcesses:0,outerMembershipEmpty:true,outerQueryError:null,proofMethod:'windows-outer-superset-v1',outputComplete:true,streams:['root','controller'].flatMap(source=>['stdout','stderr'].map(stream=>({source,stream,bytes:0,eofCount:1}))),totalRawBytes:0,overflow:false,readerFailure:false,emergencyTerminated:false,controllerRetiredAfterHelperExit:false,trigger:null,unrelated:null,observedAt:now});
 const native=(type:string,value:unknown,sequence?:number)=>peer.stdout.write(encodeFrame({observationVersion:1,...binding.executionOwner,type,...(sequence?{sequence}:{}),value}));
 mocks.spawn.mockReset();mocks.spawn.mockImplementation(()=>{
  peer=Object.assign(new EventEmitter(),{pid:10,stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(),stdin:undefined});
  peer.stdin=new Writable({write(chunk,_encoding,done){const frame=JSON.parse(chunk.subarray(4).toString());controls.push(frame);
   if(frame.type==='start'){queueMicrotask(()=>{
    native('started',{schemaVersion:1,...binding.executionOwner,observer:{pid:10,creationIdentity:'observer-10'},controller:{pid:11,creationIdentity:'controller-11'},outerJobIdentity:'outer',capturedAt:now});
    serveDisposableController(config as any,{write:data=>peer.stdout.write(encodeFrame({observationVersion:1,...binding.executionOwner,type:'controllerOutput',stream:'stdout',data:Buffer.from(data).toString('base64')})),onData:listener=>{serverEvents.on('data',listener);return()=>serverEvents.off('data',listener);},onEnd:listener=>{serverEvents.on('end',listener);return()=>serverEvents.off('end',listener);}},{connect:async()=>({ok:true,value:helper}),handoff:()=>({file:guardian.executable,args:[]})});
   });}
   if(frame.type==='controllerInput'){serverEvents.emit('data',Buffer.from(frame.data,'base64'));queueMicrotask(()=>native('ack',null,frame.sequence));}
   if(frame.type==='controllerEnd'){serverEvents.emit('end');queueMicrotask(()=>native('ack',null,frame.sequence));}
   if(frame.type==='observeTerminal')queueMicrotask(()=>native('terminal',terminal(),frame.sequence));
   if(frame.type==='readCapturedOutput')queueMicrotask(()=>native('captured',{streams:terminal().streams.map(stream=>({...stream,data:''})),totalBytes:0,overflow:false,readerFailure:false},frame.sequence));
   if(frame.type==='emergencyCleanup')queueMicrotask(()=>native('cleaned',{emergencyTerminated:true,observedAt:now},frame.sequence));
   if(frame.type==='close')queueMicrotask(()=>native('closed',null,frame.sequence));
   done();}});peer.stdin.on('finish',()=>queueMicrotask(()=>peer.emit('close',0)));return peer;
 });
 function create(extra={}){expect(typeof loaded.createObservedSupervisor).toBe('function');return loaded.createObservedSupervisor({recipes,root,intent,rawOutputLimitBytes:65536,...extra},primitive);}
 return {now,root,intent,guardian,controller,binding,recipes,captures,gates,primitive,create,controls,helper,missingMeter:()=>{missingMeter=true;},get peer(){return peer;}};
}
describe('observed supervisor concrete integration',()=>{
 it('refuses a controller watchdog later than the guardian declared deadline',async()=>{const f=fixture();f.controller.deadline+=1000;for(const recipe of Object.values(f.recipes))recipe.bindingHash=fingerprint(f.binding);await expect(f.create().start(f.captures,f.gates)).rejects.toThrow();expect(mocks.spawn).not.toHaveBeenCalled();});
 it('binds the approved primary intent before auxiliary spawn and refuses substituted target pins',async()=>{
  const f=fixture(),adapter=f.create();expect(adapter.primaryIntentHash).toBe(fingerprint(f.intent));await adapter.start(f.captures,f.gates);f.peer.emit('close',1);
  for(const kind of ['runtime','node','helper','argv','env','owner','deadline']){const g=fixture(),intent=structuredClone(g.intent);if(['runtime','node','helper'].includes(kind))intent[kind].sha256='0'.repeat(64);if(kind==='argv')intent.argumentsHash='0'.repeat(64);if(kind==='env')intent.environmentHash='0'.repeat(64);if(kind==='owner')intent.owner.actionId=g.guardian.actionId;if(kind==='deadline')intent.expiresAt-=1;for(const recipe of Object.values(g.recipes))recipe.bindingHash=fingerprint({...g.binding,primaryIntentHash:fingerprint(intent)});await expect(Promise.resolve().then(()=>g.create({intent}).start(g.captures,g.gates))).rejects.toThrow();expect(mocks.spawn).not.toHaveBeenCalled();}
 });
 it('rejects a different actual primary intent before root execution',async()=>{const f=fixture(),adapter=f.create();await adapter.start(f.captures,f.gates);expect(()=>adapter.supervisorFor({write:vi.fn(),processCompleted:vi.fn()},vi.fn(),{...f.intent,controlHash:'0'.repeat(64)})).toThrow();expect(f.helper.describe).not.toHaveBeenCalled();f.peer.emit('close',1);});
 it('checks all pinned inputs then starts the exact guardian environment, and uses the actual controller/helper bridge',async()=>{
  const f=fixture(),adapter=f.create();expect(mocks.spawn).not.toHaveBeenCalled();await adapter.start(f.captures,f.gates);
  expect(mocks.spawn).toHaveBeenCalledWith(f.guardian.executable,f.guardian.argv,expect.objectContaining({cwd:f.guardian.cwd,env:f.guardian.env,shell:false,windowsHide:true}));
  const capture={write:vi.fn(),processCompleted:vi.fn()},gate=vi.fn();const supervisor=adapter.supervisorFor(capture,gate,f.intent);
  const launched=await supervisor.launchOwned(f.root);expect(launched.ok).toBe(true);if(!launched.ok)throw Error('launch refused');
  await launched.value.writeInput(Buffer.from('approved input'));expect(f.helper.writeInput).toHaveBeenCalledWith(Buffer.from('approved input'));expect(gate).toHaveBeenCalledWith('BOOTSTRAP');
  const second=await supervisor.launchOwned(f.root);expect(second.ok).toBe(false);f.peer.emit('close',1);
 });
 it('refuses changed pinned source, absent pins, and a mismatched binding before creating anything',async()=>{
  for(const kind of ['bytes','pins','binding']){const f=fixture();if(kind==='bytes')f.primitive.readFile.mockResolvedValue(Buffer.from('changed'));if(kind==='pins')f.recipes.controller.resources=[];if(kind==='binding')f.recipes.guardian.bindingHash='0'.repeat(64);
   await expect(f.create().start(f.captures,f.gates)).rejects.toThrow();expect(mocks.spawn).not.toHaveBeenCalled();}
 });
 it('rechecks both admitted actions after asynchronous pin inspection',async()=>{
  const f=fixture();let stale=false;f.primitive.readFile.mockImplementation(async()=>{stale=true;return bytes;});f.gates.controller.mockImplementation(()=>{if(stale)throw Error('expired controller admission');});
  await expect(f.create().start(f.captures,f.gates)).rejects.toThrow();expect(mocks.spawn).not.toHaveBeenCalled();
 });
 it('rejects an altered root launch and ordinary input after admission expires',async()=>{
  const f=fixture(),adapter=f.create();await adapter.start(f.captures,f.gates);const capture={write:vi.fn(),processCompleted:vi.fn()},gate=vi.fn();const supervisor=adapter.supervisorFor(capture,gate,f.intent);
  expect((await supervisor.launchOwned({...f.root,argv:['changed']})).ok).toBe(false);expect(f.helper.describe).not.toHaveBeenCalled();f.peer.emit('close',1);
 });
 it('returns actual controller exit status and closes the guardian after complete terminal observation',async()=>{const f=fixture(),adapter=f.create();const resources=await adapter.start(f.captures,f.gates);const stopped=await adapter.stop(resources,f.captures,f.gates);expect(stopped.controller.exitCode).toBe(0);expect(stopped.guardian.exited).toBe(true);expect(f.controls.some(v=>v.type==='close')).toBe(true);});
 it('still closes the owned guardian when complete drainage lacks process-meter evidence',async()=>{const f=fixture(),adapter=f.create();const resources=await adapter.start(f.captures,f.gates);f.missingMeter();await expect(adapter.stop(resources,f.captures,f.gates)).rejects.toThrow();expect(f.controls.some(v=>v.type==='close')).toBe(true);});
 it('binds an approved unrelated action reference and resolves its actual identity only at launch',async()=>{const f=fixture(),actionId='55555555-5555-4555-8555-555555555555',identity={actionId,pid:99,creationIdentity:'actual-kernel-99',name:'codex.exe'};for(const recipe of Object.values(f.recipes))recipe.bindingHash=fingerprint({...f.binding,unrelatedActionId:actionId});const resolveUnrelated=vi.fn(()=>identity),adapter=f.create({unrelatedActionId:actionId,resolveUnrelated});expect(resolveUnrelated).not.toHaveBeenCalled();await adapter.start(f.captures,f.gates);expect(f.controls[0].unrelated).toEqual({pid:99,creationIdentity:identity.creationIdentity,name:'codex.exe'});f.peer.emit('close',1);});
 it('refuses an unrelated action whose current owned identity changes during pin checks',async()=>{const f=fixture(),actionId='55555555-5555-4555-8555-555555555555';for(const recipe of Object.values(f.recipes))recipe.bindingHash=fingerprint({...f.binding,unrelatedActionId:actionId});let changed=false;f.primitive.readFile.mockImplementation(async()=>{changed=true;return bytes;});const adapter=f.create({unrelatedActionId:actionId,resolveUnrelated:()=>({actionId,pid:99,creationIdentity:changed?'replaced':'original',name:'codex.exe'})});await expect(adapter.start(f.captures,f.gates)).rejects.toThrow();expect(mocks.spawn).not.toHaveBeenCalled();});
});

it('retains exact controller and guardian stream byte partitions through cleanup',async()=>{
 const f=fixture();for(const capture of Object.values(f.captures))(capture as any).streamBytes=vi.fn();const adapter=f.create(),resources=await adapter.start(f.captures,f.gates);f.peer.stderr.write(Buffer.from('guardian diagnostic'));
 const stopped=await adapter.stop(resources,f.captures,f.gates);expect(stopped.guardian.outputComplete).toBe(true);expect(stopped.controller.outputComplete).toBe(true);
 for(const role of ['controller','guardian'] as const){const capture=f.captures[role] as any,bytes=capture.write.mock.calls.reduce((n:number,[b]:[Buffer])=>n+b.length,0),metered=capture.streamBytes.mock.calls.reduce((n:number,[source,stream,size]:[string,string,number])=>{expect(source).toBe(role);expect(['stdout','stderr']).toContain(stream);return n+size;},0);expect(bytes).toBeGreaterThan(0);expect(metered).toBe(bytes);}
});
