import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { connectOwnedHelper, encodeFrame } from '../src/runtime/supervisor.ts';
const observerModulePath = '../src/runtime/qualification-observer.ts';
const observerModule = await import(observerModulePath).catch(() => ({}));
const { createQualificationObserver, qualificationHandoffCommand } = observerModule;

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
const owner = { runId:'11111111-1111-4111-8111-111111111111',actionId:'22222222-2222-4222-8222-222222222222',generation:1,role:'worker' };
const controller = { ...owner,executable:'C:\\trusted\\node.exe',argv:[],cwd:'C:\\trusted',env:{},boundaryHash:'a'.repeat(64),authorization:{kind:'qualified' as const,qualificationRef:'ref'},leaseTtlMs:10000,deadline:Date.now()+60000,stdin:'pipe' as const };
const identity = (pid:number) => ({pid,creationIdentity:`${pid}`});
const description = { schemaVersion:1,...owner,boundaryHash:'a'.repeat(64),observer:identity(10),controller:identity(11),helper:identity(12),root:identity(13),outerJobIdentity:'outer',innerJobIdentity:'inner',proofMethod:'windows-outer-superset-v1',nestedSubsetEstablished:true,assignedBeforeResume:true,handoffBeforeResume:true,helperOwnsOnlyInnerJobHandle:true,capturedAt:1,descendants:[] };
const terminal=()=>({schemaVersion:1,...owner,description,rootLifetimeMs:2,helperLifetimeMs:2,processMeters:['root','helper','controller','guardian'].map((kind,index)=>({kind,identity:identity([13,12,11,10][index]!),createdAt:1,exitedAt:kind==='guardian'?null:3,activeMs:2,outputBytes:kind==='root'||kind==='controller'?0:null})),processMeterError:false,rootExited:true,rootExitCode:1,rootExitCause:'natural',helperExited:true,controllerExited:true,outerActiveProcesses:0,outerMembershipEmpty:true,outerQueryError:null,proofMethod:'windows-outer-superset-v1',outputComplete:true,streams:['root','controller'].flatMap(source=>['stdout','stderr'].map(stream=>({source,stream,bytes:0,eofCount:1}))),totalRawBytes:0,overflow:false,readerFailure:false,emergencyTerminated:false,controllerRetiredAfterHelperExit:false,trigger:null,unrelated:null,observedAt:3});
function fixture(start=true,onRawBytes?:any) {
 expect(typeof createQualificationObserver,'Observer client factory is implemented').toBe('function');
 const controls:any[]=[];
 const peer=Object.assign(new EventEmitter(),{pid:10,stdout:new PassThrough(),stderr:new PassThrough(),stdin:undefined as unknown as Writable,kill:vi.fn()});
 peer.stdin=new Writable({write(bytes,_encoding,done){const frame=JSON.parse(bytes.subarray(4).toString());controls.push(frame);if(frame.type==='start')queueMicrotask(()=>peer.stdout.write(encodeFrame({observationVersion:1,...owner,type:'started',value:{schemaVersion:1,...owner,observer:identity(10),controller:identity(11),outerJobIdentity:'outer',capturedAt:1}})));done();}});
 mocks.spawn.mockReturnValue(peer);
 const client=createQualificationObserver({helperPath:'C:\\trusted\\supervisor.exe',guardian:{...controller,executable:'C:\\trusted\\supervisor.exe',argv:['--qualification-observer-v1']},controller,executionOwner:owner,boundaryHash:'a'.repeat(64),rawOutputLimitBytes:4096,authorizeStart:()=>true,onRawBytes});
 if(start)void client.start().catch(()=>{});
 const respond=(type:string,value:unknown,sequence=controls.at(-1).sequence)=>peer.stdout.write(encodeFrame({observationVersion:1,...owner,type,sequence,value}));
 return {client,peer,controls,respond};
}
describe('qualification observer client (mock native boundary only)',()=>{
 it('charges controller stderr before forwarding and never treats it as controller RPC input',async()=>{const raw=vi.fn(),f=fixture(true,raw),rpc=vi.fn();f.client.controller.onData(rpc);f.peer.stdout.write(encodeFrame({observationVersion:1,...owner,type:'controllerOutput',stream:'stderr',data:Buffer.from('controller diagnostic').toString('base64')}));expect(raw).toHaveBeenCalledWith('controller','stderr',Buffer.from('controller diagnostic'));expect(rpc).not.toHaveBeenCalled();f.peer.emit('close',1);});
 it('retains early root stderr until the actual execution listener attaches, exactly once',async()=>{const f=fixture();f.peer.stdout.write(encodeFrame({observationVersion:1,...owner,type:'rawOutput',stream:'stderr',data:Buffer.from('early strict diagnostic').toString('base64')}));const seen:any[]=[];const off=f.client.onRawOutput(value=>seen.push(value));expect(seen.map(v=>v.data.toString())).toEqual(['early strict diagnostic']);off();const later:any[]=[];f.client.onRawOutput(value=>later.push(value));expect(later).toEqual([]);f.peer.emit('close',1);});
 it('keeps construction passive and denies missing or stale current start approval before spawn',async()=>{
  mocks.spawn.mockClear();for(const authorizeStart of [undefined,()=>false,async()=>false]){const client=createQualificationObserver({helperPath:'C:\\trusted\\supervisor.exe',guardian:{...controller,executable:'C:\\trusted\\supervisor.exe',argv:['--qualification-observer-v1']},controller,executionOwner:owner,boundaryHash:'a'.repeat(64),rawOutputLimitBytes:4096,authorizeStart});expect(mocks.spawn).not.toHaveBeenCalled();await expect(client.start()).rejects.toThrow(/authorization/i);}expect(mocks.spawn).not.toHaveBeenCalled();
 });
 it('snapshots unrelated identity and complete controller inputs across asynchronous approval',async()=>{
  const f=fixture(false);const unrelated={pid:99,creationIdentity:'original',name:'node.exe'};const spec=structuredClone(controller);let release!:(value:boolean)=>void;const approval=new Promise<boolean>(resolve=>{release=resolve;});
  const client=createQualificationObserver({helperPath:'C:\\trusted\\supervisor.exe',guardian:{...controller,executable:'C:\\trusted\\supervisor.exe',argv:['--qualification-observer-v1']},controller:spec,executionOwner:owner,boundaryHash:'a'.repeat(64),rawOutputLimitBytes:4096,unrelated,authorizeStart:binding=>{expect(Object.isFrozen(binding.controller.env)).toBe(true);expect(Object.isFrozen(binding.unrelated)).toBe(true);return approval;}});
  const starting=client.start();unrelated.creationIdentity='changed';spec.env.POISON='changed';release(true);await starting;expect(f.controls[0].unrelated.creationIdentity).toBe('original');expect(f.controls[0].controller.env).toEqual({});f.peer.emit('close',1);
 });
 it('binds exact description, distinct death target and requested sequence',async()=>{
  const f=fixture();const pending=f.client.describeObservedExecution();f.respond('described',description);expect(await pending).toEqual(description);
  const trigger=f.client.triggerDeath({kind:'helper',identity:identity(12)});expect(f.controls.at(-1).target).toEqual({kind:'helper',identity:identity(12)});
  f.respond('triggered',{target:{kind:'helper',identity:identity(12)},triggeredAt:2,targetExited:true,targetExitedAt:3});expect((await trigger).target.kind).toBe('helper');
  await expect(f.client.triggerDeath({kind:'controller',identity:identity(12)})).rejects.toThrow(/identity/i);
  f.peer.emit('close',0);
 });
 it('rejects stale generation and never converts observer loss into terminal evidence',async()=>{
  const f=fixture();const pending=f.client.describeObservedExecution();f.peer.stdout.write(encodeFrame({observationVersion:1,...owner,generation:2,type:'described',sequence:1,value:description}));await expect(pending).rejects.toThrow(/identity/i);
  await expect(f.client.observeTerminal()).rejects.toThrow();expect(f.peer.kill).toHaveBeenCalled();
 });
 it('preserves captured bytes after helper death and exposes missing EOF/overflow as observations',async()=>{
  const f=fixture();const pending=f.client.readCapturedOutput();const value={streams:[{source:'root',stream:'stdout',data:Buffer.from('tail').toString('base64'),bytes:4,eofCount:1},{source:'root',stream:'stderr',data:'',bytes:0,eofCount:0}],totalBytes:4,overflow:true,readerFailure:false};f.respond('captured',value);expect(await pending).toEqual(value);f.peer.emit('close',0);
 });
 it('rejects malformed captured bytes and exact target mismatch',async()=>{
  const f=fixture();const pending=f.client.readCapturedOutput();f.respond('captured',{streams:[{source:'root',stream:'stdout',data:'*',bytes:1,eofCount:1}],totalBytes:1,overflow:false,readerFailure:false});await expect(pending).rejects.toThrow();
 });
 it('requires complete protected rendezvous metadata and strips it from provider launch inputs',()=>{
  expect(()=>qualificationHandoffCommand('C:\\trusted\\helper.exe',{})).toThrow(/rendezvous/i);
  const command=qualificationHandoffCommand('C:\\trusted\\helper.exe',{OUROBOROS_QUALIFICATION_RENDEZVOUS:'\\\\.\\pipe\\test',OUROBOROS_QUALIFICATION_NONCE:'a'.repeat(64),OUROBOROS_QUALIFICATION_GUARDIAN_PID:'10',OUROBOROS_QUALIFICATION_GUARDIAN_CREATION:'creation'});
  expect(command.args).toEqual(['--qualification-handoff-v1','\\\\.\\pipe\\test','a'.repeat(64),'10','creation']);
 });
 it('charges auxiliary helper stderr before it is discarded and fails on meter overflow',async()=>{
  const f=fixture(false);const chunks:Buffer[]=[];
  const pending=connectOwnedHelper({file:'C:\\trusted\\helper.exe',args:[]},controller,'windows',{onRawBytes(source,stream,bytes){expect(source).toBe('helper');expect(stream).toBe('stderr');chunks.push(Buffer.from(bytes));throw new Error('auxiliary raw output exhausted');}});
  f.peer.stderr.write(Buffer.from('secret diagnostic'));const result=await pending;expect(result.ok).toBe(false);expect(Buffer.concat(chunks).toString()).toBe('secret diagnostic');expect(f.peer.kill).toHaveBeenCalled();
  f.peer.emit('close',1);
 });
 it('reports kernel-identity lifetime bounds and waits for actual helper close only when requested',async()=>{
  const f=fixture(false),meters:any[]=[];const at=Date.now();const kernel=(116444736000000000n+BigInt(at-100)*10000n).toString(16).padStart(16,'0');
  const connecting=connectOwnedHelper({file:'C:\\trusted\\helper.exe',args:[]},controller,'windows',{onProcessCompleted:meter=>meters.push(meter),waitHelperExit:true});
  f.peer.stdout.write(encodeFrame({protocolVersion:1,...owner,type:'launched',receipt:{schemaVersion:1,...owner,environment:'windows',pid:13,creationIdentity:kernel,helperPid:10,helperCreationIdentity:kernel,jobIdentity:'inner',boundaryHash:'a'.repeat(64),assignedBeforeResume:true,capturedAt:at}}));
  const result=await connecting;expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);let settled=false;const draining=result.value.drain('done').then(v=>{settled=true;return v;});
  f.peer.stdout.write(encodeFrame({protocolVersion:1,...owner,type:'drained',evidence:{schemaVersion:1,...owner,reason:'root_exit',requestAcknowledged:false,requestedAt:at,acknowledgedAt:null,rootExited:true,rootExitedAt:at,membershipEmpty:true,membershipObservedAt:at,activeProcesses:0,unresolvedExecutions:[],outputComplete:true,unresolvedOutputStreams:[],outputCompletedAt:at,childRanBeforeAssignment:false,completedAt:at}}));
  await Promise.resolve();expect(settled).toBe(false);expect(meters).toEqual([{kind:'root',identity:{pid:13,creationIdentity:kernel},activeMs:100}]);f.peer.stdout.end();f.peer.stderr.end();f.peer.emit('close',0);await draining;expect(meters[1]).toMatchObject({kind:'helper',identity:{pid:10,creationIdentity:kernel}});expect(meters[1].activeMs).toBeGreaterThanOrEqual(100);
 });
 it('returns actual root code and outer query error without manufacturing an empty inner Job',async()=>{
  const f=fixture();const value={...terminal(),rootExitCode:73,rootExitCause:'helper-job-close',outerActiveProcesses:null,outerMembershipEmpty:null,outerQueryError:'access denied',emergencyTerminated:true,outputComplete:false,readerFailure:true};const pending=f.client.observeTerminal();f.respond('terminal',value);expect(await pending).toEqual(value);await expect(f.client.close()).rejects.toThrow(/reconciled/i);f.peer.emit('close',1);
 });
 it('forwards raw root output after helper loss independently of controller RPC bytes',async()=>{
  const f=fixture();const raw:Buffer[]=[],controllerBytes:Buffer[]=[];f.client.onRawOutput(({data})=>raw.push(data));f.client.controller.onData(bytes=>controllerBytes.push(bytes));
  f.peer.stdout.write(encodeFrame({observationVersion:1,...owner,type:'rawOutput',stream:'stderr',data:Buffer.from('late root tail').toString('base64')}));
  f.peer.stdout.write(encodeFrame({observationVersion:1,...owner,type:'controllerOutput',stream:'stdout',data:Buffer.from('rpc').toString('base64')}));expect(Buffer.concat(raw).toString()).toBe('late root tail');expect(Buffer.concat(controllerBytes).toString()).toBe('rpc');f.peer.emit('close',1);
 });
 it('requires real guardian exit after its close acknowledgment',async()=>{
  const f=fixture();let pending=f.client.observeTerminal();f.respond('terminal',terminal());await pending;
  const closing=f.client.close();f.respond('closed',null);f.peer.stdout.end();f.peer.stderr.end();f.peer.emit('close',0,null);expect(await closing).toMatchObject({guardianExited:true,outputEof:true,exitCode:0});
 });
 it('rejects complete-output claims with missing root EOF and forged terminal ancestry',async()=>{
  const f=fixture();const value=terminal();value.streams[0]!.eofCount=0;const pending=f.client.observeTerminal();f.respond('terminal',value);await expect(pending).rejects.toThrow(/Inconsistent terminal/);f.peer.emit('close',1);
 });
});
