import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { LaunchSpecSchema, type LaunchSpec, type Supervisor } from '../contracts/execution.ts';
import { QualificationTerminalSchema, type QualificationObservationClient } from '../contracts/qualification-observation.ts';
import { createQualificationObserver, type QualificationObservationLaunchBinding } from '../runtime/qualification-observer.ts';
import { campaignRecipeHash, type AuxiliaryRecipe, type ObservationAdapters, type ObservationResources, type RawCapture } from './campaign-runner.ts';
import { connectDisposableController, DisposableControllerConfigSchema, disposableSpecHash } from './disposable-controller.ts';
import { fingerprint } from './probes.ts';
import { StartupIntentSchema, type StartupIntent } from './codex-startup-authority.ts';

type Pin={path:string;sha256:string};
type Gate=(phase:'BOOTSTRAP'|'CLEANUP')=>void;
type Unrelated={actionId:string;pid:number;creationIdentity:string;name:string};
type Options={recipes:{guardian:AuxiliaryRecipe;controller:AuxiliaryRecipe};intent:StartupIntent;root:LaunchSpec;rawOutputLimitBytes:number;unrelatedActionId?:string;resolveUnrelated?:(actionId:string)=>Unrelated|undefined};
type Primitives={readFile(path:string):Promise<Uint8Array>;realpath(path:string):Promise<string>;now():number};
const freeze=<T>(value:T):Readonly<T>=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const owner=(spec:LaunchSpec)=>({runId:spec.runId,generation:spec.generation,actionId:spec.actionId,role:spec.role});
const same=(a:unknown,b:unknown)=>a===undefined||b===undefined?a===b:fingerprint(a)===fingerprint(b);
function fail(reason:string):never{throw Error(reason);}

/** Passive concrete adapter. The campaign dispatches BOTH auxiliary intents
 * before start; the root remains a separately admitted exact launch. */
export function createObservedSupervisor(input:Options,primitives:Primitives={readFile,realpath,now:Date.now}):ObservationAdapters&{
 preflight():void;
 observation():QualificationObservationClient;
 supervisorFor(capture:RawCapture,effectGate:Gate,intent:StartupIntent):Supervisor;
}{
 const {resolveUnrelated,...fixed}=input;const options=freeze(structuredClone(fixed));
 const guardian=LaunchSpecSchema.parse(options.recipes.guardian.launch),controller=LaunchSpecSchema.parse(options.recipes.controller.launch),root=LaunchSpecSchema.parse(options.root);
 const intent=StartupIntentSchema.parse(options.intent),primaryIntentHash=fingerprint(intent);
 const {recipes}=options;
 const blueprint={helperPath:guardian.executable,guardian,controller,executionOwner:owner(root),boundaryHash:root.boundaryHash,rawOutputLimitBytes:options.rawOutputLimitBytes,primaryIntentHash,...(options.unrelatedActionId?{unrelatedActionId:options.unrelatedActionId}:{})};
 function unrelated(){if(!options.unrelatedActionId)return undefined;const value=resolveUnrelated?.(options.unrelatedActionId);if(!value||value.actionId!==options.unrelatedActionId||!Number.isSafeInteger(value.pid)||value.pid<=0||!value.creationIdentity||value.name.toLowerCase()!==win32.basename(root.executable).toLowerCase())fail('OWNED_UNRELATED_UNAVAILABLE');return {pid:value.pid,creationIdentity:value.creationIdentity,name:value.name};}
 let observer:QualificationObservationClient|undefined,resources:ObservationResources|undefined,started=false,launched=false,stopped=false;
 let rootCapture:RawCapture|undefined;
 const allPins=()=>[...Object.values(recipes).flatMap(recipe=>[{path:recipe.launch.executable,sha256:recipe.executableHash},...recipe.resources])];
 function validate(){
  if(!same(recipes.guardian.bindingHash,fingerprint(blueprint))||!same(recipes.controller.bindingHash,fingerprint(blueprint)))fail('OBSERVATION_BINDING_MISMATCH');
  if(guardian.executable!==blueprint.helperPath||!same(guardian.argv,['--qualification-observer-v1'])||controller.argv.length!==3||controller.argv[0]!=='--experimental-strip-types'||win32.basename(controller.argv[1]!)!=='disposable-controller.mjs')fail('OBSERVATION_COMMAND_REFUSED');
  const config=DisposableControllerConfigSchema.parse(JSON.parse(controller.argv[2]!));
  if(config.helper.path!==guardian.executable||config.specHash!==disposableSpecHash(root)||config.deadline!==root.deadline||guardian.deadline<controller.deadline||controller.deadline<root.deadline)fail('OBSERVATION_ROOT_BINDING_MISMATCH');
  const graphRoot=win32.resolve(win32.dirname(config.module.path),'../..');
  const required=['src/runtime/supervisor.ts','src/runtime/qualification-observer.ts','src/contracts/execution.ts','src/contracts/qualification-observation.ts','src/contracts/common.ts','package.json','package-lock.json'].map(path=>win32.join(graphRoot,path).toLowerCase()).sort();
  if(config.module.path.toLowerCase()!==win32.join(graphRoot,'src','qualification','disposable-controller.ts').toLowerCase()||!same(config.dependencies.map(pin=>pin.path.toLowerCase()).sort(),required))fail('CONTROLLER_DEPENDENCY_PINS_REQUIRED');
  const pins=allPins();
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if(!same(owner(root),intent.owner)||root.executable!==intent.runtime.path||root.cwd!==intent.workspace||root.deadline!==intent.expiresAt||root.boundaryHash!==intent.boundaryHash||!same(root.authorization,intent.dispatchAuthorization)||digest(root.argv)!==intent.argumentsHash||digest(root.env)!==intent.environmentHash||Object.keys(root.env).some(key=>!intent.environmentKeys.includes(key as never))||root.stdin!=='pipe'||root.leaseTtlMs!==10000)fail('OBSERVATION_PRIMARY_INTENT_MISMATCH');
  if(guardian.executable!==intent.helper.path||controller.executable!==intent.node.path||!same(config.helper,intent.helper)||recipes.guardian.executableHash!==intent.helper.sha256||recipes.controller.executableHash!==intent.node.sha256||![intent.runtime,intent.node,intent.helper].every(expected=>pins.some(actual=>actual.path===expected.path&&actual.sha256===expected.sha256)))fail('OBSERVATION_PRIMARY_PINS_MISMATCH');
  for(const pin of [config.module,config.helper,...config.dependencies])if(!pins.some(actual=>same(actual,pin)))fail('CONTROLLER_DEPENDENCY_PINS_REQUIRED');
  if(!pins.some(pin=>pin.path===controller.argv[1])||!pins.some(pin=>pin.path===root.executable))fail('OBSERVATION_EXECUTABLE_PINS_REQUIRED');
  const identities=[guardian,controller,root];if(new Set(identities.map(spec=>spec.actionId)).size!==3||identities.some(spec=>spec.runId!==root.runId||spec.generation!==root.generation||spec.boundaryHash!==root.boundaryHash)||recipes.guardian.actionId!==guardian.actionId||recipes.controller.actionId!==controller.actionId||recipes.guardian.role!=='guardian'||recipes.controller.role!=='controller')fail('OBSERVATION_OWNER_MISMATCH');
  return config;
 }
 async function checkPins(){
  const seen=new Map<string,string>();
  for(const pin of allPins()){
   if(!/^[A-Za-z]:\\/.test(pin.path)||win32.normalize(pin.path)!==pin.path||pin.path.slice(2).includes(':')||!/^[a-f0-9]{64}$/.test(pin.sha256))fail('OBSERVATION_PIN_INVALID');
   const key=pin.path.toLowerCase();if(seen.has(key)){if(seen.get(key)!==pin.sha256)fail('OBSERVATION_PIN_CONFLICT');continue;}seen.set(key,pin.sha256);
   if((await primitives.realpath(pin.path)).toLowerCase()!==key||createHash('sha256').update(await primitives.readFile(pin.path)).digest('hex')!==pin.sha256)fail('OBSERVATION_RESOURCE_CHANGED');
  }
 }
 const currentObserver=()=>observer??fail('OBSERVATION_NOT_STARTED');
 return {
  primaryIntentHash,
  preflight:()=>{validate();},
  observation:currentObserver,
  recoverOwned:()=>resources?structuredClone(resources):undefined,
  async start(captures,gates){
   if(started)fail('OBSERVATION_REPLAY');started=true;validate();const other=unrelated();
   const {unrelatedActionId:_reference,primaryIntentHash:_intentHash,...launchBinding}=blueprint;
   const binding:QualificationObservationLaunchBinding={...launchBinding,...(other?{unrelated:other}:{})};
   observer=createQualificationObserver({...binding,authorizeStart:async actual=>{
    if(!same(actual,binding))fail('OBSERVATION_BINDING_MISMATCH');await checkPins();if(!same(unrelated(),other))fail('OWNED_UNRELATED_CHANGED');gates.guardian();gates.controller();return true;
   },onRawBytes:(source,stream,bytes)=>{if(source==='guardian'){captures.guardian.streamBytes?.(source,stream,bytes.length);captures.guardian.write(bytes);}else if(source==='controller'){captures.controller.streamBytes?.(source,stream,bytes.length);captures.controller.write(bytes);}else{if(!rootCapture)fail('UNOWNED_HELPER_OUTPUT');rootCapture.streamBytes?.(source,stream,bytes.length);rootCapture.write(bytes);}}});
   const receipt=await observer.start();
   const make=(kind:'guardian'|'controller')=>({owner:owner(recipes[kind].launch),identity:receipt[kind==='guardian'?'observer':'controller'],launchHash:campaignRecipeHash(recipes[kind]),createdAt:receipt.capturedAt});
   resources={guardian:make('guardian'),controller:make('controller')};
   // Identity is retained before any subsequent failing operation, for cleanup.
   return structuredClone(resources);
  },
  supervisorFor(capture,effectGate,actualIntent){
   if(fingerprint(StartupIntentSchema.parse(actualIntent))!==primaryIntentHash)fail('OBSERVATION_PRIMARY_INTENT_MISMATCH');
   const client=currentObserver();if(typeof effectGate!=='function')fail('ROOT_ADMISSION_REQUIRED');
   return {async launchOwned(request){
    try{
     const spec=LaunchSpecSchema.parse(request);if(launched||stopped||!resources||!same(spec,root))fail('OBSERVED_ROOT_LAUNCH_MISMATCH');
     await checkPins();effectGate('BOOTSTRAP');launched=true;rootCapture=capture;
     const config=validate();const execution=await connectDisposableController(client.controller,spec,{deadline:spec.deadline,moduleHash:config.module.sha256,now:primitives.now,effectGate:kind=>effectGate(kind==='CLEANUP'?'CLEANUP':'BOOTSTRAP'),onRawOutput:listener=>client.onRawOutput(listener),onHelperRawBytes:(stream,bytes)=>{capture.streamBytes?.('helper',stream,bytes.length);capture.write(bytes);}});
     return {ok:true,value:execution};
    }catch{return {ok:false,error:{code:'OBSERVED_ROOT_REFUSED',message:'Exact observed root launch failed or lost current admission',evidenceIds:[]}};}
   }};
  },
  async stop(actual,captures,gates){
   if(stopped||!resources||!same(actual,resources))fail('OBSERVATION_CLEANUP_MISMATCH');stopped=true;
   const client=currentObserver();gates.guardian();gates.controller();let closed=false;
   try{
   // Ending this writer is terminal only. It never creates another process.
   await client.controller.end();
   let terminal=QualificationTerminalSchema.parse(await client.observeTerminal());
   if(!terminal.outerMembershipEmpty||!terminal.outputComplete||!terminal.rootExited||!terminal.helperExited||!terminal.controllerExited){
    gates.guardian();gates.controller();await client.emergencyCleanup('observation-group-cleanup-incomplete');terminal=QualificationTerminalSchema.parse(await client.observeTerminal());
   }
   if(terminal.processMeterError||!terminal.controllerExited||!Number.isSafeInteger(terminal.controllerExitCode)||!terminal.outerMembershipEmpty||!terminal.outputComplete)fail('OBSERVATION_TERMINAL_UNKNOWN');
   const controllerMeter=terminal.processMeters.find(m=>m.kind==='controller');
   if(!controllerMeter||controllerMeter.exitedAt===null||!same(controllerMeter.identity,resources.controller.identity))fail('OBSERVATION_CONTROLLER_METER_UNKNOWN');
   // All controller streams were charged by onRawBytes before RPC parsing.
   const capture=await client.readCapturedOutput();if(capture.overflow||capture.readerFailure)fail('OBSERVATION_CAPTURE_UNKNOWN');
   gates.guardian();gates.controller();const close=await client.close();closed=true;const completedAt=primitives.now();
   if(terminal.emergencyTerminated)fail('OBSERVATION_EMERGENCY_CLEANUP');
   return {guardian:{...resources.guardian,exited:true,exitCode:close.exitCode,outputComplete:close.outputEof,completedAt,activeMs:close.activeMs},controller:{...resources.controller,exited:true,exitCode:terminal.controllerExitCode!,outputComplete:true,completedAt,activeMs:controllerMeter.activeMs}};
   }catch(error){
    if(!closed){try{gates.guardian();gates.controller();await client.emergencyCleanup('observation-evidence-unresolved');gates.guardian();gates.controller();await client.close();}catch{/* Retain UNKNOWN; the guardian's parent-EOF/deadline containment remains armed. */}}
    throw error;
   }
  },
 };
}
