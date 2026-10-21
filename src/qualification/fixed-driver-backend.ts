import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { LaunchInput, OwnedExecution, OwnershipReceipt, Supervisor, ExecutionOwner } from '../contracts/execution.ts';
import { LaunchSpecSchema } from '../contracts/execution.ts';
import type { FixedDriverIO, FixedDriverRequest, FixedOperationInput, FixedOperationOutcome, EndpointAvailabilityInput, EndpointAvailability } from './fixed-driver.ts';
import { validateFixedNetworkPlan, type FixedNetworkPlan } from './fixed-driver.ts';
import { fingerprint } from './probes.ts';

export type RawBoundaryCapture = { write(bytes: Uint8Array): void;processCompleted(meter:{kind:'root'|'helper';identity:{pid:number;creationIdentity:string};activeMs:number}):void };
export type FixedEffectGate = (phase:'BOOTSTRAP'|'VERIFIER'|'TURN')=>void;
export type PinnedBoundaryResource = { path: string; sha256: string };
export type FixedDriverManifestV2Input = { fixtureRoot: string; targetHash: string; node: PinnedBoundaryResource; driver: PinnedBoundaryResource; endpoint: PinnedBoundaryResource; wrapperHash: string;networkPlan:FixedNetworkPlan };
const operations = ['allowed_edit','denied_source_write','denied_controller_write','denied_sibling_write','denied_sensitive_read','allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback','link_escape','broker_escape'] as const;
function absolute(path: string) { return typeof path === 'string' && /^[A-Za-z]:\\[^\\]/.test(path) && !path.includes('/') && !path.slice(2).includes(':') && !path.split('\\').slice(1).some(p => !p || p === '.' || p === '..' || /[. ]$|[<>"|?*\x00-\x1f]/.test(p)); }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function deriveBrokerEndpoint(fixtureRoot:string,targetHash:string){if(!absolute(fixtureRoot)||!/^[a-f0-9]{64}$/.test(targetHash))throw Error('Invalid broker fixture');return `\\\\.\\pipe\\ouroboros-boundary-${createHash('sha256').update(`${fixtureRoot}\n${targetHash}`).digest('hex').slice(0,24)}`;}
export function createFixedDriverManifestV2(input: FixedDriverManifestV2Input) {
 validateFixedNetworkPlan(input.networkPlan);
 if (!absolute(input.fixtureRoot) || !/^[a-f0-9]{64}$/.test(input.targetHash) || !/^[a-f0-9]{64}$/.test(input.wrapperHash) ||
  [input.node,input.driver,input.endpoint].some(resource => !absolute(resource.path) || !/^[a-f0-9]{64}$/.test(resource.sha256)) ||
  win32.basename(input.driver.path) !== 'campaign-boundary-driver.mjs' || win32.basename(input.endpoint.path) !== 'controlled-endpoint.mjs' ||
  win32.dirname(input.driver.path) !== win32.dirname(input.endpoint.path)) throw Error('Invalid pinned fixed driver manifest');
 const value = { schemaVersion: 2 as const, ...structuredClone(input), endpoints: ['http://localhost:18471/allowed','http://127.0.0.1:18472/denied',`tcp://${input.networkPlan.directTcp.host}:${input.networkPlan.directTcp.port}`],
  proxy:structuredClone(input.networkPlan.proxy),brokerEndpoint:deriveBrokerEndpoint(input.fixtureRoot,input.targetHash), brokerTransport: 'disposable-named-pipe-only' as const,
  unsupportedBrokerSurfaces: ['privileged-host-brokers'], commands: (['worker','verifier'] as const).flatMap(role => operations.map(operation => ({
   role, operation, probeId: `${role}.${operation === 'allowed_edit' && role === 'verifier' ? 'allowed_command' : operation}`,
   executable: input.node.path, argvPrefix: ['--preserve-symlinks-main',input.driver.path], resourceSha256: input.driver.sha256,
  }))) };
 return Object.freeze({ ...value, identityHash: fingerprint(value) });
}
export type FixedDriverManifestV2 = ReturnType<typeof createFixedDriverManifestV2>;
export type FixedLaunchBase = Omit<LaunchInput, 'argv'|'stdin'> & { argvPrefix: string[] };
export function buildFixedDriverLaunch(manifest: FixedDriverManifestV2, request: FixedDriverRequest, launch: FixedLaunchBase): LaunchInput {
 const { identityHash, ...body } = manifest;
 if (fingerprint(body) !== identityHash || request.fixtureRoot !== manifest.fixtureRoot || request.targetHash !== manifest.targetHash ||(request.networkPlan&&fingerprint(request.networkPlan)!==fingerprint(manifest.networkPlan))||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.executionId) || launch.role !== request.role || launch.authorization.kind !== 'qualification') throw Error('Fixed launch binding mismatch');
 const command = manifest.commands.find(c => c.role === request.role && c.operation === request.operation);
 if (!command || launch.authorization.probeId !== command.probeId || !launch.authorization.fixtureRoots.includes(manifest.fixtureRoot)) throw Error('Fixed probe authority mismatch');
 const { argvPrefix, ...base } = structuredClone(launch);
 return { ...base, stdin: 'closed', argv: [...argvPrefix,command.executable,...command.argvPrefix,request.role,request.executionId,command.probeId,request.operation,manifest.fixtureRoot,manifest.targetHash,JSON.stringify(manifest.networkPlan)] };
}
type ControllerIO = NonNullable<FixedDriverIO['controller']>;
export type FixedBackendOptions = {
 supervisorFor(capture:RawBoundaryCapture):Supervisor; manifest: FixedDriverManifestV2; launch: FixedLaunchBase; readResource(path: string): Promise<Uint8Array>;
 controller?: ControllerIO; now?: () => number;
};
function sameOwner(a: ExecutionOwner, b: ExecutionOwner) { return a.runId === b.runId && a.actionId === b.actionId && a.generation === b.generation && a.role === b.role; }
function denied(input: FixedOperationInput, code: string): FixedOperationOutcome { return { role: input.role, executionId: input.executionId, operationId: input.operationId, attempted: false, effect: 'error', origin: 'tool', code }; }
function renewOwnedLease(execution:OwnedExecution,deadline:number,gate:()=>void,now:()=>number,failed:()=>void){
 let sequence=0,timer:ReturnType<typeof setInterval>|undefined;
 const stop=()=>{clearInterval(timer);timer=undefined;};
 timer=setInterval(()=>{try{if(now()>=deadline)throw Error('Owned deadline expired');gate();void execution.renewLease(++sequence).catch(()=>{stop();failed();});}catch{stop();failed();}},2000);timer.unref();return stop;
}
function operationIO(request: FixedDriverRequest, controller: ControllerIO|undefined, dispatch: (input: Readonly<FixedOperationInput>)=>Promise<Record<string,unknown>>):FixedDriverIO {
 let dispatched = false;
 let readback: FixedOperationOutcome | undefined;
 const execute = async (input: Readonly<FixedOperationInput>): Promise<FixedOperationOutcome> => {
  if (input.operationId.endsWith('.readback')) {
   const cached = readback; readback = undefined;
   return cached && cached.role === input.role && cached.executionId === input.executionId && cached.operationId === input.operationId ? structuredClone(cached) : denied(input,'READBACK_UNAVAILABLE');
  }
  if (dispatched) return denied(input,'FIXED_DISPATCH_ALREADY_CONSUMED'); dispatched = true;
  const probeId=`${request.role}.${request.operation==='allowed_edit'&&request.role==='verifier'?'allowed_command':request.operation}`;
  if(input.role!==request.role||input.executionId!==request.executionId||input.operationId!==probeId)return denied(input,'FIXED_COMMAND_UNKNOWN');
  try {
   const value=await dispatch(input);
   if(value.kind!=='boundary-operation'||value.schemaVersion!==1)throw Error('Invalid fixed record');
   if (value.role!==input.role||value.executionId!==input.executionId||value.operationId!==input.operationId||typeof value.attempted!=='boolean'||!['allowed','blocked','refused','error'].includes(String(value.effect))) throw Error('Resource operation mismatch');
   if(value.readback && typeof value.readback==='object') readback=structuredClone(value.readback as FixedOperationOutcome);
   const {kind: _kind,schemaVersion: _version,readback: _readback,...outcome}=value;
   return outcome as FixedOperationOutcome;
  } catch { return denied(input,'FIXED_EXECUTION_UNPROVEN'); }
 };
 return { filesystem:{read:execute,write:execute,linkAndWrite:execute},network:{proxyHttp:execute,directTcp:execute,loopback:execute},broker:{writeThroughBroker:execute},controller };
}
async function pinned(options:Pick<FixedBackendOptions,'manifest'|'readResource'>){const{identityHash,...body}=options.manifest;if(fingerprint(body)!==identityHash)throw Error('Pinned manifest changed');for(const resource of [options.manifest.node,options.manifest.driver,options.manifest.endpoint])if(hash(await options.readResource(resource.path))!==resource.sha256)throw Error('Pinned resource changed');}
export type FixedWorkerCommandChannel = { executeFixedCommand(command:{executable:string;argv:string[];expectedResource:PinnedBoundaryResource;beforeExecute():void}):Promise<{exitCode:number;stdout:string;stderr:string;attempted:true;threadId:string;turnId:string;itemId:string;provenance:'codex-commandExecution'}> };
/** Worker evidence must come from actual runtime commandExecution output; there is no supervisor fallback. */
export function createFixedDriverBackend(options:Pick<FixedBackendOptions,'manifest'|'readResource'|'controller'> & {request:FixedDriverRequest;workerChannel:FixedWorkerCommandChannel;effectGate:FixedEffectGate}):FixedDriverIO {
 const request=structuredClone(options.request),manifest=structuredClone(options.manifest);
 return operationIO(request,options.controller,async()=>{
  if(request.role!=='worker'||request.fixtureRoot!==manifest.fixtureRoot||request.targetHash!==manifest.targetHash||(request.networkPlan&&fingerprint(request.networkPlan)!==fingerprint(manifest.networkPlan)))throw Error('Worker target mismatch');
  const {identityHash,...body}=manifest;if(fingerprint(body)!==identityHash)throw Error('Worker manifest changed');
  await pinned({...options,manifest});const command=manifest.commands.find(c=>c.role==='worker'&&c.operation===request.operation);if(!command)throw Error('Worker command unavailable');
  options.effectGate('TURN');let gateInvoked=false;
  const result=await options.workerChannel.executeFixedCommand({executable:manifest.node.path,argv:[...command.argvPrefix,request.role,request.executionId,command.probeId,request.operation,manifest.fixtureRoot,manifest.targetHash,JSON.stringify(manifest.networkPlan)],expectedResource:manifest.driver,beforeExecute:()=>{options.effectGate('TURN');gateInvoked=true;}});
  if(!gateInvoked||result.provenance!=='codex-commandExecution'||result.attempted!==true||result.exitCode!==0||!result.threadId||!result.turnId||!result.itemId||Buffer.byteLength(result.stdout)>8192||result.stdout.trim().split('\n').length!==1)throw Error('Worker command evidence unavailable');
  return JSON.parse(result.stdout.trim());
 });
}
function outputChannel(execution:OwnedExecution,capture:RawBoundaryCapture){
 const queue:Record<string,unknown>[]=[];const listeners=new Set<()=>void>();let text='',failed=false,total=0;
 const detach=execution.onOutput(output=>{try{capture.write(output.data);total+=output.data.length;if(total>262144)throw Error('Output exceeded');if(output.stream==='stdout'){text+=output.data.toString('utf8');let end;while((end=text.indexOf('\n'))>=0){const value=JSON.parse(text.slice(0,end));text=text.slice(end+1);if(value.schemaVersion!==1)throw Error('Invalid resource record');queue.push(value);if(queue.length>64)throw Error('Too many records');}}for(const check of listeners)check();}catch{failed=true;for(const check of listeners)check();}});
 const wait=(kind:string)=>new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>{listeners.delete(check);reject(Error('Resource response timeout'));},2000);const check=()=>{const index=queue.findIndex(r=>r.kind===kind);if(failed||index>=0){clearTimeout(timer);listeners.delete(check);failed?reject(Error('Resource output invalid')):resolve(queue.splice(index,1)[0]!);}};listeners.add(check);check();});
 return {wait,detach};
}
/** Neutral owned verifier root. Only its admitted IO call sends literal execute; no IO call launches a child. */
export function createFixedVerifierBackend(options:FixedBackendOptions & {request:FixedDriverRequest;brokerInventory?:()=>Promise<ControlledEndpointInventory>}) {
 const o={...options,request:structuredClone(options.request),manifest:structuredClone(options.manifest),launch:structuredClone(options.launch)};
 const normal=buildFixedDriverLaunch(o.manifest,o.request,o.launch);if(o.request.role!=='verifier'||o.request.executionId!==normal.actionId)throw Error('Verifier owned request required');
 const spec={...normal,stdin:'pipe' as const,argv:[...normal.argv,'--channel',o.manifest.driver.sha256]};
 let execution:OwnedExecution|undefined,channel:ReturnType<typeof outputChannel>|undefined,receipt:OwnershipReceipt|undefined,ready=false,processTaken=false,leaseFailed=false;let stopLease=()=>{};
 const describe=async()=>{if(!execution)throw Error('Resource not launched');const actual=await execution.describe();if(!sameOwner(actual,spec)||actual.boundaryHash!==spec.boundaryHash)throw Error('Resource owner mismatch');return actual;};
 const process=(capture:RawBoundaryCapture,effectGate:FixedEffectGate)=>{
  if(processTaken)throw Error('Resource process already consumed');processTaken=true;
  return {
   launch:async(input:{intent:{owner:ExecutionOwner};argv:string[];strictNegative:boolean})=>{if(execution||input.strictNegative||!sameOwner(input.intent.owner,spec)||JSON.stringify(input.argv)!==JSON.stringify(spec.argv))throw Error('Neutral launch mismatch');await pinned(o);const supervisor=o.supervisorFor(capture);effectGate('BOOTSTRAP');const result=await supervisor.launchOwned(spec);if(!result.ok)throw Error('Resource launch refused');execution=result.value;channel=outputChannel(execution,capture);receipt=await describe();stopLease=renewOwnedLease(execution,spec.deadline,()=>effectGate(ready?'VERIFIER':'BOOTSTRAP'),o.now??Date.now,()=>{leaseFailed=true;ready=false;});return structuredClone(receipt);},
   initialize:async()=>{const value=await channel!.wait('fixed-resource-ready');if(leaseFailed||value.resourceHash!==o.manifest.driver.sha256||value.executionId!==spec.actionId)throw Error('Resource readiness mismatch');ready=true;return {kind:'fixed-resource-ready' as const,resourceHash:o.manifest.driver.sha256,executionId:spec.actionId,observationHash:fingerprint({value,receipt})};},
   fence:async()=>{stopLease();ready=false;await execution!.fence();return {ownership:await describe(),fenced:true};},
   drain:async()=>{try{const ownership=await describe();const drained=await execution!.drain('fixed-verifier-complete');return {ownership,drain:drained};}finally{stopLease();channel?.detach();}},
   reconcileBrokers:async()=>{if(!receipt)throw Error('Resource not owned');const ownership=structuredClone(receipt);if(o.request.operation!=='broker_escape')return {ownership,inventoryComplete:true,active:[],unresolved:[]};const inventory=await o.brokerInventory?.();return {ownership,inventoryComplete:!!inventory&&!inventory.failed,active:inventory?.pending??['unknown-broker'],unresolved:inventory?.failed?['failed-broker']:inventory?[]:['unknown-broker']};},
  };
 };
 const io=(_capture:RawBoundaryCapture,owned:Readonly<OwnershipReceipt>,effectGate:FixedEffectGate)=>operationIO(o.request,o.controller,async()=>{if(!ready||!receipt||fingerprint(owned)!==fingerprint(receipt))throw Error('Resource admission identity mismatch');effectGate('VERIFIER');const sent=await execution!.writeInput(Buffer.from('execute\n'));if(!sent.ok)throw Error('Fixed execute refused');return channel!.wait('boundary-operation');});
 return {process,io,argv:structuredClone(spec.argv),launchSpec:structuredClone(spec)};
}
export type ControlledEndpointInventory = { executionId:string; generation:string; children:string[]; pending:string[]; stopped:boolean; failed:boolean };
/** Shared service client owns one output listener and raw capture; consumers never install competing listeners. */
export function createControlledEndpointClient(execution: OwnedExecution, identity: {executionId:string;generation:string;owner:ExecutionOwner;fixtureRoot:string;targetHash:string;networkPlanHash:string}, capture: RawBoundaryCapture) {
 let buffer=''; let failed=false;let lastOwnership:OwnershipReceipt|undefined; const records: Record<string,unknown>[]=[]; const waiters=new Set<()=>void>();
 const detach=execution.onOutput(output=>{try{capture.write(output.data);if(output.stream!=='stdout')return;buffer+=output.data.toString('utf8');if(Buffer.byteLength(buffer)>16384)throw Error('Service output too large');let end;while((end=buffer.indexOf('\n'))>=0){const record=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(record.schemaVersion!==1||record.executionId!==identity.executionId||record.generation!==identity.generation)throw Error('Service identity mismatch');records.push(record);if(records.length>64)throw Error('Service message limit');}for(const notify of waiters)notify();}catch{failed=true;for(const notify of waiters)notify();}});
 const wait=async(kind:string):Promise<Record<string,unknown>>=>{const take=()=>{const index=records.findIndex(r=>r.kind===kind);return index<0?undefined:records.splice(index,1)[0];};const ready=take();if(ready)return ready;if(failed)throw Error('Service output failed');return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(check);reject(Error('Service response timeout'));},2000);const check=()=>{const result=take();if(result||failed){clearTimeout(timer);waiters.delete(check);result?resolve(result):reject(Error('Service output failed'));}};waiters.add(check);});};
 const describe=async()=>{const receipt=await execution.describe();if(!sameOwner(receipt,identity.owner)||(lastOwnership&&fingerprint(receipt)!==fingerprint(lastOwnership)))throw Error('Service owner mismatch');lastOwnership=structuredClone(receipt);return receipt;};
 const inventory=async(command:'inventory'|'reconcile'='inventory',beforeControl?:()=>void):Promise<ControlledEndpointInventory>=>{await describe();beforeControl?.();const sent=await execution.writeInput(Buffer.from(`${command}\n`));if(!sent.ok)throw Error('Service control refused');const value=await wait('inventory');if(!Array.isArray(value.children)||!Array.isArray(value.pending)||typeof value.stopped!=='boolean'||typeof value.failed!=='boolean')throw Error('Invalid service inventory');return value as unknown as ControlledEndpointInventory;};
 return { executionId:identity.executionId,generation:identity.generation,describe,inventory,
  observe:async(input:Readonly<EndpointAvailabilityInput>,beforeControl?:()=>void):Promise<EndpointAvailability>=>{await describe();if(input.fixtureRoot!==identity.fixtureRoot||input.targetHash!==identity.targetHash||(input.networkPlanHash&&input.networkPlanHash!==identity.networkPlanHash))throw Error('Service observation target mismatch');const name=input.endpoint==='http://localhost:18471/allowed'?'allowed':input.endpoint==='http://127.0.0.1:18472/denied'?'denied':/^tcp:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(input.endpoint)?'direct':input.endpoint===deriveBrokerEndpoint(input.fixtureRoot,input.targetHash)?'broker':undefined;if(!name)throw Error('Unapproved service endpoint');beforeControl?.();const sent=await execution.writeInput(Buffer.from(`observe-${name}\n`));if(!sent.ok)throw Error('Service observation refused');const value=await wait('availability');if(value.endpoint!==input.endpoint||value.fixtureRoot!==input.fixtureRoot||value.targetHash!==input.targetHash||value.serviceGeneration!==identity.generation||value.networkPlanHash!==identity.networkPlanHash||typeof value.actualAttempt!=='boolean'||typeof value.available!=='boolean'||typeof value.observedFromMs!=='number'||typeof value.availableThroughMs!=='number')throw Error('Service availability mismatch');return {role:'controller',executionId:identity.executionId,endpoint:input.endpoint,fixtureRoot:input.fixtureRoot,targetHash:input.targetHash,boundaryRole:input.boundaryRole,boundaryExecutionId:input.boundaryExecutionId,serviceGeneration:identity.generation,networkPlanHash:identity.networkPlanHash,actualAttempt:value.actualAttempt,available:value.available,observedFromMs:value.observedFromMs,availableThroughMs:value.availableThroughMs};},
  ready:async()=>{const names=new Set();for(let i=0;i<4;i++){const record=await wait('ready');if(!['allowed','denied','direct','broker'].includes(String(record.resource))||names.has(record.resource)||record.fixtureRoot!==identity.fixtureRoot||record.targetHash!==identity.targetHash||record.networkPlanHash!==identity.networkPlanHash)throw Error('Endpoint readiness incomplete');names.add(record.resource);}return {executionId:identity.executionId,generation:identity.generation,ownership:await describe()};},
  stop:async(beforeControl?:()=>void)=>{let ownership=lastOwnership,value:Record<string,unknown>|undefined;try{ownership=await describe();beforeControl?.();const sent=await execution.writeInput(Buffer.from('stop\n'));if(sent.ok)value=await wait('stopped');}catch{/* Protocol uncertainty must not skip native containment. */}try{await execution.fence();}catch{}const drain=await execution.drain('controlled-endpoint-stop');detach();if(!ownership)throw Error('Service ownership unavailable after drainage');const complete=sameOwner(drain,identity.owner)&&sameOwner(ownership,identity.owner)&&drain.rootExited&&drain.membershipEmpty&&drain.outputComplete&&value?.stopped===true&&value.failed===false&&Array.isArray(value.pending)&&value.pending.length===0;return {executionId:identity.executionId,generation:identity.generation,ownership,terminated:complete,outputComplete:drain.outputComplete,drain};},
 };
}
/** Controller-only fixture observations; caller provides real fs primitive and the separately charged service client. */
export function createFixedControllerIO(options:{manifest:FixedDriverManifestV2;controllerExecutionId:string;readFile(path:string):Promise<Uint8Array>;realpath?:(path:string)=>Promise<string>;service():ReturnType<typeof createControlledEndpointClient>;now():number;effectGate:FixedEffectGate}):ControllerIO {
 const m=structuredClone(options.manifest);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.controllerExecutionId))throw Error('Controller observer identity required');
 const observe=(input:Readonly<EndpointAvailabilityInput>)=>{if(input.fixtureRoot!==m.fixtureRoot||input.targetHash!==m.targetHash||(input.networkPlanHash&&input.networkPlanHash!==fingerprint(m.networkPlan)))throw Error('Observation target mismatch');return options.service().observe(input,()=>options.effectGate(input.boundaryRole==='worker'?'TURN':'VERIFIER'));};
 return {now:options.now,observeEndpoint:observe,observeBroker:observe,snapshotSentinel:async input=>{
  if(input.fixtureRoot!==m.fixtureRoot||input.targetHash!==m.targetHash||input.boundaryExecutionId===options.controllerExecutionId||
   !['source','controller-sentinel','sibling','fake-credential'].some(root=>input.path===win32.join(m.fixtureRoot,root,'sentinel.txt')))throw Error('Protected snapshot mismatch');
  const phase=input.boundaryRole==='worker'?'TURN':'VERIFIER';options.effectGate(phase);
  const link=input.probeId===`${input.boundaryRole}.link_escape`,source=win32.join(m.fixtureRoot,'source');
  const checkLink=async()=>{if(!options.realpath||(await options.realpath(win32.join(m.fixtureRoot,'workspace',`escape-link-${input.boundaryRole}`))).toLowerCase()!==source.toLowerCase())throw Error('Prepared escape junction identity changed');options.effectGate(phase);};
  if(link)await checkLink();const contents=await options.readFile(input.path);if(link)await checkLink();return {...input,role:'controller',executionId:options.controllerExecutionId,actualRead:true,sha256:hash(contents),...(link?{linkTargetMatched:true}:{})};
 }};
}
export function createControlledEndpointBackend(options:FixedBackendOptions) {
 const o={...options,manifest:structuredClone(options.manifest),launch:structuredClone(options.launch)};
 if(o.launch.role!=='controller')throw Error('Controller owned endpoint required');
 let client:ReturnType<typeof createControlledEndpointClient>|undefined,resource:Awaited<ReturnType<ReturnType<typeof createControlledEndpointClient>['ready']>>|undefined,known:typeof resource;let stopLease=()=>{};let leaseFailed=false;
 const {argvPrefix,...base}=o.launch;
 // A separately owned controlled service may run the pinned Node directly;
 // wrapper launches retain the literal Node command after their separator.
 const directNode=base.executable===o.manifest.node.path;
 if(directNode&&argvPrefix.length)throw Error('Direct endpoint Node requires empty wrapper prefix');
 const spec=LaunchSpecSchema.parse({...base,stdin:'pipe' as const,argv:[...argvPrefix,...(directNode?[]:[o.manifest.node.path]),'--preserve-symlinks-main',o.manifest.endpoint.path,o.manifest.fixtureRoot,o.manifest.targetHash,o.launch.actionId,JSON.stringify(o.manifest.networkPlan)]});
 const freeze=(value:object):void=>{for(const child of Object.values(value))if(child!==null&&typeof child==='object')freeze(child);Object.freeze(value);};
 freeze(spec);
 return {
  launch:spec,
  argv:structuredClone(spec.argv),
  start:async(capture:RawBoundaryCapture,effectGate:()=>void)=>{if(client)throw Error('Endpoint already dispatched');await pinned(o);const supervisor=o.supervisorFor(capture);effectGate();const launched=await supervisor.launchOwned(spec);if(!launched.ok)throw Error('Endpoint launch refused');client=createControlledEndpointClient(launched.value,{executionId:spec.actionId,generation:spec.actionId,owner:spec,fixtureRoot:o.manifest.fixtureRoot,targetHash:o.manifest.targetHash,networkPlanHash:fingerprint(o.manifest.networkPlan)},capture);known={executionId:spec.actionId,generation:spec.actionId,ownership:await client.describe()};stopLease=renewOwnedLease(launched.value,spec.deadline,effectGate,o.now??Date.now,()=>{leaseFailed=true;});try{resource=await client.ready();if(leaseFailed||resource.ownership.boundaryHash!==spec.boundaryHash)throw Error('Endpoint boundary mismatch');return structuredClone(resource);}catch(error){stopLease();throw error;}},
  recoverOwned:()=>known?structuredClone(known):undefined,
  stop:async(exact:Readonly<NonNullable<typeof resource>>,_capture:RawBoundaryCapture,beforeControl?:()=>void)=>{if(!client||!known||fingerprint(exact)!==fingerprint(known))throw Error('Exact endpoint identity required');stopLease();return client.stop(beforeControl);},
  client:()=>{if(!client||!resource||leaseFailed)throw Error('Endpoint not ready');return client;},
 };
}
