import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {administrativeFixture} from './helpers/administrative-evidence.ts';
import {requireAdministrativeGate,loadAdministrativeEvidence,administrativeAdditionalCosts,type AdministrativeGateContext} from '../src/qualification/campaign-administration.ts';
import {validateCampaignTerminal,validateCampaignTerminalUsage,validateCampaignTerminalTopology} from '../src/qualification/campaign-terminal.ts';

const h='a'.repeat(64);
function context(priorOperationId?:string):AdministrativeGateContext{return {campaignId:randomUUID(),targetHash:h,grantHash:h,historyHash:h,nextUnitId:'metadata',...(priorOperationId?{priorOperationId}:{}),policy:{schemaVersion:1,authorityHash:h,preparationInvocationIds:[randomUUID()],registrationInvocationId:randomUUID(),registrationProcessCount:1,unitWrapperProcessCount:2,settlementProcessCount:2}};}
it('requires opaque externally accepted preparation/registration and exact current history before continuation',()=>{
 const c=context(),f=administrativeFixture(c),accepted=f.load();expect(requireAdministrativeGate(accepted,c).total).toEqual({actions:2,activeMs:4,outputBytes:0});
 expect(()=>requireAdministrativeGate({ledgerHash:accepted.ledgerHash,total:accepted.total},c)).toThrow('ADMINISTRATIVE_TERMINAL_GATE_REQUIRED');
 expect(()=>requireAdministrativeGate(accepted,{...c,historyHash:'b'.repeat(64)})).toThrow('ADMINISTRATIVE_TERMINAL_GATE_REQUIRED');
 expect(()=>loadAdministrativeEvidence({...f.input,authorizeControlPlane:()=>false})).toThrow('ADMINISTRATIVE_CONTROL_PLANE_UNPROVEN');
 expect(()=>loadAdministrativeEvidence({...f.input,authorizeLedger:()=>false})).toThrow('ADMINISTRATIVE_LEDGER_NOT_ACCEPTED');
});
it('requires both wrapper and settlement process chains and refuses missing or replayed administrative receipts',()=>{
 const c=context(randomUUID()),f=administrativeFixture(c);expect(requireAdministrativeGate(f.load(),c).total.actions).toBe(6);
 f.input.ledger.invocations.pop();f.input.ledger.receipts.pop();expect(()=>requireAdministrativeGate(f.load(),c)).toThrow('ADMINISTRATIVE_PREVIOUS_UNIT_INCOMPLETE');
 f.input.ledger.receipts.pop();expect(()=>f.load()).toThrow('ADMINISTRATIVE_REPLAY_OR_INCOMPLETE');
 const g=administrativeFixture(context());g.input.ledger.receipts.push(g.input.ledger.receipts[0]);expect(()=>g.load()).toThrow('ADMINISTRATIVE_REPLAY_OR_INCOMPLETE');
});
it('includes sidecar costs once and adds only an attributable larger conservative delta',()=>{
 const c=context(),f=administrativeFixture(c),accepted=f.load(),invocation=JSON.parse(f.data.get(f.input.ledger.invocations[0].id)!.toString());
 expect(administrativeAdditionalCosts(accepted,[{identity:invocation.identity,activeMs:1,outputBytes:0}]).additional).toEqual({actions:1,activeMs:3,outputBytes:0});
 expect(()=>administrativeAdditionalCosts(accepted,[{identity:invocation.identity,activeMs:1,outputBytes:0},{identity:invocation.identity,activeMs:1,outputBytes:0}])).toThrow('ADMINISTRATIVE_CHARGED_IDENTITY_REPLAY');
});
function terminalFixture(){
 const owner={runId:randomUUID(),generation:1,actionId:randomUUID(),role:'worker'},ownership={schemaVersion:1,...owner,environment:'windows',pid:10,creationIdentity:'root',helperPid:11,helperCreationIdentity:'helper',jobIdentity:'inner',boundaryHash:h,assignedBeforeResume:true,capturedAt:1000};
 const batch:any={schemaVersion:3,id:randomUUID(),targetHash:h,owner:{runId:owner.runId,generation:1},approvedAt:999},action:any={id:owner.actionId,kind:'probe',probeId:'worker.subscription_request',launchHash:h,cleanupId:randomUUID(),maxMs:10000,maxOutputBytes:10000};
 const description={schemaVersion:1,...owner,boundaryHash:h,observer:{pid:12,creationIdentity:'guardian'},controller:{pid:13,creationIdentity:'controller'},root:{pid:10,creationIdentity:'root'},helper:{pid:11,creationIdentity:'helper'},outerJobIdentity:'outer',innerJobIdentity:'inner',proofMethod:'windows-outer-superset-v1',nestedSubsetEstablished:true,assignedBeforeResume:true,handoffBeforeResume:true,helperOwnsOnlyInnerJobHandle:true,capturedAt:1000,descendants:[]};
 const drain:any={schemaVersion:1,...owner,description,processMeters:(['root','helper','controller','guardian'] as const).map(kind=>({kind,identity:description[kind==='guardian'?'observer':kind],createdAt:1000,exitedAt:kind==='guardian'?null:1010,activeMs:10,outputBytes:kind==='root'||kind==='controller'?5:null})),processMeterError:false,rootLifetimeMs:10,helperLifetimeMs:10,rootExited:true,rootExitCode:0,rootExitCause:'natural',helperExited:true,controllerExited:true,outerActiveProcesses:0,outerMembershipEmpty:true,outerQueryError:null,proofMethod:'windows-outer-superset-v1',outputComplete:true,streams:(['root','controller'] as const).flatMap(source=>(['stdout','stderr'] as const).map(stream=>({source,stream,bytes:5,eofCount:1}))),totalRawBytes:20,overflow:false,readerFailure:false,emergencyTerminated:false,controllerRetiredAfterHelperExit:false,trigger:null,unrelated:null,observedAt:1010};
 const observation:any={schemaVersion:1,kind:'campaign-terminal-observation',targetHash:h,batchId:batch.id,actionId:action.id,launchHash:h,resource:{kind:'owned-execution',ownership,drain,brokerInventory:{inventoryComplete:true,active:[],unresolved:[]}},processMeters:[{kind:'root',identity:description.root,activeMs:10},{kind:'helper',identity:description.helper,activeMs:10}],primaryOutputBytes:20,cleanupOutputBytes:0,rawOutputBytes:20,streamCounters:[{source:'root',stream:'stdout',bytes:5},{source:'root',stream:'stderr',bytes:5}],observedAt:1010};
 return {batch,action,observation};
}
it('rejects contradictory outer terminal lifetime meters and output counts',()=>{
 const f=terminalFixture();expect(validateCampaignTerminal(f.observation,f.batch,f.action).processMeters).toHaveLength(2);
 f.observation.processMeters[0].activeMs=9;expect(()=>validateCampaignTerminal(f.observation,f.batch,f.action)).toThrow('CAMPAIGN_TERMINAL_METER_CONTRADICTION');
 f.observation.processMeters[0].activeMs=10;f.observation.streamCounters[0].bytes=4;expect(()=>validateCampaignTerminal(f.observation,f.batch,f.action)).toThrow('CAMPAIGN_TERMINAL_OUTPUT_CONTRADICTION');
});
it('rejects result underreporting of validated process time and attributable terminal artifact output',()=>{
 const f=terminalFixture(),o=validateCampaignTerminal(f.observation,f.batch,f.action);
 expect(()=>validateCampaignTerminalUsage(o,{elapsedMs:19,outputBytes:30},10)).toThrow('CAMPAIGN_RESULT_USAGE_UNDERREPORTED');
 expect(()=>validateCampaignTerminalUsage(o,{elapsedMs:20,outputBytes:29},10)).toThrow('CAMPAIGN_RESULT_USAGE_UNDERREPORTED');
 expect(validateCampaignTerminalUsage(o,{elapsedMs:20,outputBytes:30},10)).toEqual({activeMs:20,outputBytes:30});
});

it('rechecks immutable administrative bytes when consuming an accepted opaque receipt',()=>{
 const c=context(),f=administrativeFixture(c),evidence=f.load();f.data.set(f.input.ledger.invocations[0].id,Buffer.from('changed prepublished identity'));
 expect(()=>requireAdministrativeGate(evidence,c)).toThrow('ADMINISTRATIVE_BYTES_CHANGED');
});

it('partitions nonzero root/controller cleanup output while retaining exact stream and auxiliary topology totals',()=>{
 const f=terminalFixture();f.observation.primaryOutputBytes=14;f.observation.cleanupOutputBytes=6;
 const auxiliary=(role:'controller'|'guardian')=>{const id=randomUUID(),action:any={id,kind:'preparation',auxiliaryFor:f.action.id,auxiliaryRole:role,cleanupId:randomUUID(),launchHash:h,maxMs:1000,maxOutputBytes:100},expected=f.observation.resource.drain.description[role==='guardian'?'observer':role],bytes=role==='controller'?10:2;
  const terminal:any={schemaVersion:1,kind:'campaign-terminal-observation',targetHash:h,batchId:f.batch.id,actionId:id,launchHash:h,resource:{kind:'auxiliary-exit',owner:{runId:f.batch.owner.runId,generation:1,actionId:id,role:'qualification-'+role},identity:expected,createdAt:1000,completedAt:1010,activeMs:10,exitCode:0,outputComplete:true},processMeters:[],primaryOutputBytes:role==='controller'?4:1,cleanupOutputBytes:role==='controller'?6:1,rawOutputBytes:bytes,streamCounters:[{source:role,stream:'stdout',bytes:bytes/2},{source:role,stream:'stderr',bytes:bytes/2}],observedAt:1010};return {action,terminal:validateCampaignTerminal(terminal,f.batch,action)};};
 const controller=auxiliary('controller'),guardian=auxiliary('guardian'),primary={action:f.action,terminal:validateCampaignTerminal(f.observation,f.batch,f.action)},entries=[primary,controller,guardian];
 const cleanup=new Map(entries.map(e=>[e.action.cleanupId!,{outputBytes:e.terminal.cleanupOutputBytes}]));
 expect(()=>validateCampaignTerminalTopology(entries,cleanup)).not.toThrow();
 expect(validateCampaignTerminalUsage(primary.terminal,{elapsedMs:20,outputBytes:24},10)).toEqual({activeMs:20,outputBytes:24});
 expect(()=>validateCampaignTerminalTopology([primary,guardian],cleanup)).toThrow('CAMPAIGN_TERMINAL_AUXILIARY_LINK_MISSING');
 controller.terminal.streamCounters[0].bytes=4;expect(()=>validateCampaignTerminalTopology(entries,cleanup)).toThrow('CAMPAIGN_TERMINAL_CONTROLLER_OUTPUT_CONTRADICTION');controller.terminal.streamCounters[0].bytes=5;
 cleanup.set(controller.action.cleanupId,{outputBytes:5});expect(()=>validateCampaignTerminalTopology(entries,cleanup)).toThrow('CAMPAIGN_CLEANUP_USAGE_UNDERREPORTED');cleanup.set(controller.action.cleanupId,{outputBytes:6});
 controller.terminal.resource.identity.pid=999;expect(()=>validateCampaignTerminalTopology(entries,cleanup)).toThrow('CAMPAIGN_TERMINAL_AUXILIARY_LINK_MISSING');
});

function streamTopologyFixture(root:[number,number],controller:[number,number]){
 const f=terminalFixture(),drain=f.observation.resource.drain,rootBytes=root[0]+root[1],controllerBytes=controller[0]+controller[1];
 drain.streams=drain.streams.map((s:any)=>({...s,bytes:(s.source==='root'?root:controller)[s.stream==='stdout'?0:1]}));drain.totalRawBytes=rootBytes+controllerBytes;
 for(const meter of drain.processMeters)if(meter.kind==='root'||meter.kind==='controller')meter.outputBytes=meter.kind==='root'?rootBytes:controllerBytes;
 // Helper output can arrive during cleanup even when both owned root streams are silent.
 f.observation.primaryOutputBytes=rootBytes+2;f.observation.cleanupOutputBytes=1;f.observation.rawOutputBytes=rootBytes+3;
 f.observation.streamCounters=[...root.flatMap((bytes,index)=>bytes?[{source:'root',stream:index===0?'stdout':'stderr',bytes}]:[]),{source:'helper',stream:'stdout',bytes:3}];
 const auxiliary=(role:'controller'|'guardian')=>{const id=randomUUID(),action:any={id,kind:'preparation',auxiliaryFor:f.action.id,auxiliaryRole:role,cleanupId:randomUUID(),launchHash:h,maxMs:1000,maxOutputBytes:100},bytes=role==='controller'?controllerBytes:2,cleanupBytes=Math.min(1,bytes);
  const terminal:any={schemaVersion:1,kind:'campaign-terminal-observation',targetHash:h,batchId:f.batch.id,actionId:id,launchHash:h,resource:{kind:'auxiliary-exit',owner:{runId:f.batch.owner.runId,generation:1,actionId:id,role:'qualification-'+role},identity:drain.description[role==='guardian'?'observer':role],createdAt:1000,completedAt:1010,activeMs:10,exitCode:0,outputComplete:true},processMeters:[],primaryOutputBytes:bytes-cleanupBytes,cleanupOutputBytes:cleanupBytes,rawOutputBytes:bytes,streamCounters:role==='controller'?controller.flatMap((n,index)=>n?[{source:role,stream:index===0?'stdout':'stderr',bytes:n}]:[]):[{source:role,stream:'stdout',bytes}],observedAt:1010};return {action,terminal};};
 const primary={action:f.action,terminal:f.observation},controllerEntry=auxiliary('controller'),guardian=auxiliary('guardian'),entries=[primary,controllerEntry,guardian];
 const cleanup=new Map(entries.map(e=>[e.action.cleanupId!,{outputBytes:e.terminal.cleanupOutputBytes}]));
 return {...f,primary,controller:controllerEntry,guardian,entries,cleanup};
}
function validateStreamTopology(f:ReturnType<typeof streamTopologyFixture>){
 const entries=f.entries.map(e=>({action:e.action,terminal:validateCampaignTerminal(e.terminal,f.batch,e.action)}));
 validateCampaignTerminalTopology(entries,f.cleanup);
}
it('accepts an omitted silent root stderr counter only with complete owned zero-byte EOF evidence',()=>{
 const f=streamTopologyFixture([5,0],[5,5]);expect(f.primary.terminal.streamCounters.some((s:any)=>s.source==='root'&&s.stream==='stderr')).toBe(false);
 expect(()=>validateStreamTopology(f)).not.toThrow();
});
it('accepts an omitted silent controller stderr counter only with complete owned zero-byte EOF evidence',()=>{
 const f=streamTopologyFixture([5,5],[5,0]);expect(f.controller.terminal.streamCounters.some((s:any)=>s.stream==='stderr')).toBe(false);
 expect(()=>validateStreamTopology(f)).not.toThrow();
});
it('accepts both silent root and controller streams while retaining positive helper and guardian cleanup accounting',()=>{
 const f=streamTopologyFixture([0,0],[0,0]);expect(f.primary.terminal.streamCounters).toEqual([{source:'helper',stream:'stdout',bytes:3}]);expect(f.controller.terminal.streamCounters).toEqual([]);
 expect(()=>validateStreamTopology(f)).not.toThrow();
 f.cleanup.set(f.action.cleanupId,{outputBytes:0});expect(()=>validateStreamTopology(f)).toThrow('CAMPAIGN_CLEANUP_USAGE_UNDERREPORTED');
});
it.each(['root','controller'] as const)('rejects an omitted positive %s stream counter',source=>{
 const f=streamTopologyFixture([5,0],[5,0]),entry=source==='root'?f.primary:f.controller;
 entry.terminal.streamCounters=entry.terminal.streamCounters.filter((s:any)=>s.source!==source||s.stream!=='stdout');
 expect(()=>validateStreamTopology(f)).toThrow(source==='root'?'CAMPAIGN_TERMINAL_OUTPUT_CONTRADICTION':'CAMPAIGN_TERMINAL_CONTROLLER_OUTPUT_CONTRADICTION');
});
it.each(['root','controller'] as const)('refuses absent zero %s counters when expected EOF is incomplete',source=>{
 const f=streamTopologyFixture([0,0],[0,0]),drain=f.observation.resource.drain;drain.streams.find((s:any)=>s.source===source&&s.stream==='stderr').eofCount=0;drain.outputComplete=false;
 if(source==='root')expect(()=>validateStreamTopology(f)).toThrow('CAMPAIGN_OWNED_DRAIN_INCOMPLETE');
 else expect(()=>validateCampaignTerminalTopology(f.entries,f.cleanup)).toThrow('CAMPAIGN_TERMINAL_CONTROLLER_OUTPUT_CONTRADICTION');
});
it.each(['overflow','readerFailure','outputIncomplete'] as const)('refuses absent zero counters with %s terminal output',failure=>{
 const f=streamTopologyFixture([0,0],[0,0]),drain=f.observation.resource.drain;drain.outputComplete=false;if(failure==='outputIncomplete')drain.streams[0].eofCount=0;else drain[failure]=true;
 expect(()=>validateStreamTopology(f)).toThrow('CAMPAIGN_OWNED_DRAIN_INCOMPLETE');
 expect(()=>validateCampaignTerminalTopology(f.entries,f.cleanup)).toThrow('CAMPAIGN_TERMINAL_CONTROLLER_OUTPUT_CONTRADICTION');
});
