import { createHash } from 'node:crypto';
import { readFile,realpath } from 'node:fs/promises';
import type { Result } from '../contracts/common.ts';
import { LaunchSpecSchema,type LaunchSpec,type Supervisor } from '../contracts/execution.ts';
import { createSupervisor,type SupervisorOptions } from '../runtime/supervisor.ts';
import { BatchApprovalSchema,type BatchApproval } from './campaign.ts';
import { CampaignRunner,type SessionRecipe,type FixedRecipe,type MetadataRecipe,type StrictRecipe,type EndpointRecipe,type AuxiliaryRecipe,type SessionAdapters,type FixedAdapters,type RawCapture } from './campaign-runner.ts';
import { dispatchCampaignBatch,type CampaignDispatchStep } from './campaign-dispatch.ts';
import { createSessionBackend,type SessionBackendOptions,type ConcreteSessionProcess,type SessionService } from './session-driver-backend.ts';
import { createFixedDriverManifestV2,createFixedDriverBackend,createFixedVerifierBackend,createControlledEndpointBackend,createFixedControllerIO,type FixedDriverManifestV2,type FixedLaunchBase } from './fixed-driver-backend.ts';
import { createObservedSupervisor } from './observed-supervisor.ts';
import { createPendingDispatchQueue,PendingDispatchDescriptorSchema,type PendingDispatchDescriptor } from './pending-dispatch.ts';
import { StartupIntentSchema,type StartupIntent } from './codex-startup-authority.ts';
import { fingerprint } from './probes.ts';

export type RuntimeSessionInputs={env:Record<string,string>;fixture:SessionBackendOptions['fixture'];pending?:PendingDispatchDescriptor};
type SessionNode={kind:'session';recipe:SessionRecipe;session:RuntimeSessionInputs};
export type CampaignRuntimeNode=SessionNode
 | {kind:'fixed';recipe:FixedRecipe;session?:RuntimeSessionInputs;env:Record<string,string>}
 | {kind:'metadata';recipe:MetadataRecipe;session:RuntimeSessionInputs}
 | {kind:'strict';positive:StrictRecipe;negative:StrictRecipe;positiveSession:RuntimeSessionInputs;negativeSession:RuntimeSessionInputs}
 | {kind:'endpoint';recipe:EndpointRecipe;launch:FixedLaunchBase;steps:CampaignRuntimeNode[]}
 | {kind:'unrelated';recipe:MetadataRecipe;session:RuntimeSessionInputs;steps:CampaignRuntimeNode[]}
 | {kind:'observation';guardian:AuxiliaryRecipe;controller:AuxiliaryRecipe;root:LaunchSpec;step:SessionNode};
export type CampaignRuntimeProposal={batch:BatchApproval;manifest:FixedDriverManifestV2;controllerExecutionId:string;steps:CampaignRuntimeNode[]};
export type CampaignRuntimeOptions={runner:CampaignRunner;currentAdmission:SessionAdapters['currentAdmission'];authorizeLaunch:(spec:Readonly<LaunchSpec>)=>Promise<boolean>;
 supervisorFactory?:(options:SupervisorOptions)=>Supervisor;fs?:SessionBackendOptions['fs'];now?:()=>number;sleep?:SessionBackendOptions['sleep'];timeoutMs?:number;
 pendingCharge?:Parameters<typeof createPendingDispatchQueue>[1]['chargedDispatch']};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function refused():Result<never>{return {ok:false,error:{code:'CAMPAIGN_RUNTIME_REFUSED',message:'Exact typed recipes, resource ownership and external authority required',evidenceIds:[]}};}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

/** Inert native composition: construction does not read fixtures, start a
 * helper, inspect authentication, create approval, or issue a provider request.
 * Only dispatch() invokes the explicit already-approved selected topology. */
export function composeCampaignRuntime(raw:CampaignRuntimeProposal,options:CampaignRuntimeOptions):Result<{steps:readonly CampaignDispatchStep[];dispatch:()=>ReturnType<typeof dispatchCampaignBatch>}>{
 try{
  const proposal=freeze(structuredClone(raw)),batch=BatchApprovalSchema.parse(proposal.batch),manifest=proposal.manifest;
  if(typeof options.currentAdmission!=='function'||typeof options.authorizeLaunch!=='function'||manifest.schemaVersion!==2||manifest.targetHash!==batch.targetHash||!proposal.controllerExecutionId||!proposal.steps.length)return refused();
  if(fingerprint(manifest)!==fingerprint(createFixedDriverManifestV2({fixtureRoot:manifest.fixtureRoot,targetHash:manifest.targetHash,node:manifest.node,driver:manifest.driver,endpoint:manifest.endpoint,wrapperHash:manifest.wrapperHash,networkPlan:manifest.networkPlan})))return refused();
  const native=options.supervisorFactory??createSupervisor,now=options.now??Date.now,files=options.fs;
  const read=(path:string)=>files?files.readFile(path):readFile(path);
  const services=new Map<string,{backend:ReturnType<typeof createControlledEndpointBackend>;resource:SessionService}>();
  const sameOwner=(spec:LaunchSpec)=>spec.runId===batch.owner.runId&&spec.generation===batch.owner.generation&&spec.authorization.kind==='qualification'&&spec.authorization.requestId===batch.id;
  const sessionRoot=(recipe:SessionRecipe|FixedRecipe|MetadataRecipe|StrictRecipe,env:Record<string,string>):LaunchSpec=>{
   const intent=StartupIntentSchema.parse(recipe.request.intent);
   const argv=recipe.kind==='strict'&&intent.dispatchAuthorization.kind==='qualification'&&intent.dispatchAuthorization.probeId==='auxiliary.strict-negative'?[...recipe.request.argv,'-c','foo="bar"']:recipe.request.argv;
   if(!sameOwner({...intent.owner,authorization:intent.dispatchAuthorization} as LaunchSpec)||intent.owner.actionId!==recipe.actionId||hash(JSON.stringify(env))!==intent.environmentHash||hash(JSON.stringify(argv))!==intent.argumentsHash)return (()=>{throw Error('SESSION_LAUNCH_BINDING');})();
   return LaunchSpecSchema.parse({...intent.owner,executable:intent.runtime.path,argv,cwd:intent.workspace,env,boundaryHash:intent.boundaryHash,authorization:intent.dispatchAuthorization,stdin:'pipe',leaseTtlMs:10000,deadline:intent.expiresAt});
  };
  const supervisor=(intent:StartupIntent,expected:LaunchSpec,capture:RawCapture,gate:()=>void):Supervisor=>native({helperPath:intent.helper.path,authorize:async actual=>{
   gate();if(fingerprint(actual)!==fingerprint(expected)||!sameOwner(actual))return false;
   const authorized=await options.authorizeLaunch(freeze(structuredClone(actual)));gate();return authorized;
  },observation:{onRawBytes:(_source,_stream,bytes)=>capture.write(bytes),onProcessCompleted:meter=>capture.processCompleted(meter),waitHelperExit:true}});
  const pending=(descriptor:PendingDispatchDescriptor|undefined,intent:StartupIntent)=>{
   if(!descriptor)return undefined;
   const parsed=PendingDispatchDescriptorSchema.parse(descriptor);
   if(!options.pendingCharge||parsed.owner.runId!==batch.owner.runId||parsed.owner.generation!==batch.owner.generation||parsed.parentActionId!==intent.owner.actionId||parsed.targetHash!==batch.targetHash||parsed.launch.authorization.kind!=='qualification'||parsed.launch.authorization.requestId!==batch.id)throw Error('PENDING_ACCOUNTING_BINDING');
   return {queue:createPendingDispatchQueue(options.runner.campaign.store,{chargedDispatch:options.pendingCharge}),descriptor:parsed,targetHash:batch.targetHash};
  };
  const session=(recipe:SessionRecipe|FixedRecipe|MetadataRecipe|StrictRecipe,input:RuntimeSessionInputs,observed?:ReturnType<typeof createObservedSupervisor>):SessionAdapters&{channel:()=>ConcreteSessionProcess}=>{
   const root=sessionRoot(recipe,input.env),intent=recipe.request.intent;
   if(input.fixture.root!==manifest.fixtureRoot||input.fixture.controlHash!==intent.controlHash||input.fixture.activityDriver.sha256.length!==64)throw Error('SESSION_FIXTURE_BINDING');
   const queued=pending(input.pending,intent);let process:ConcreteSessionProcess|undefined;
   return {currentAdmission:options.currentAdmission,channel:()=>{if(!process)throw Error('WORKER_CHANNEL_NOT_OWNED');return process;},process:(capture,effectGate)=>{
    if(process)throw Error('SESSION_RESOURCE_REPLAY');
    const broker=[...services.values()].find(service=>service.backend.launch.actionId!==recipe.actionId)?.resource;
    const state=options.runner.campaign.snapshot(batch.campaignId);if(!state.ok)throw Error('CAMPAIGN_TARGET_UNAVAILABLE');
    const backend=createSessionBackend({env:input.env,fixture:input.fixture,currentAdmission:options.currentAdmission,fs:files,now,sleep:options.sleep,timeoutMs:options.timeoutMs,
     startupEvidence:{store:options.runner.campaign.store,target:state.value.target,fixtureHash:batch.fixtureHash},
     ...(broker?{broker}:{}),...(queued?{pendingDispatch:queued}:{}),...(observed?{observation:observed.observation}:{}),ownedBrokerRegistry:actual=>options.runner.ownedBrokerRegistry(actual),
     supervisorFor:(rawCapture,gate,actual)=>{
      if(fingerprint(actual)!==fingerprint(intent))throw Error('SESSION_INTENT_CHANGED');
      return observed?observed.supervisorFor(rawCapture as RawCapture,gate,actual):supervisor(actual,root,rawCapture as RawCapture,()=>gate('BOOTSTRAP'));
     }});
    process=backend.process(capture,effectGate);return process;
   }};
  };
  const controller=(gate:(phase:'BOOTSTRAP'|'TURN'|'VERIFIER')=>void)=>createFixedControllerIO({manifest,controllerExecutionId:proposal.controllerExecutionId,readFile:read,realpath:files?files.realpath:realpath,now,effectGate:gate,service:()=>{
   const service=[...services.values()][0];if(!service)throw Error('CHARGED_ENDPOINT_NOT_OWNED');return service.backend.client();
  }});
  const build=(nodes:readonly CampaignRuntimeNode[],depth=0):CampaignDispatchStep[]=>{
   if(depth>8)throw Error('RUNTIME_TOPOLOGY_DEPTH');
   return nodes.map(node=>{
    if(node.kind==='session'||node.kind==='metadata')return {kind:node.kind,recipe:node.recipe,adapters:session(node.recipe,node.session)} as CampaignDispatchStep;
    if(node.kind==='unrelated')return {kind:'unrelated',recipe:node.recipe,adapters:session(node.recipe,node.session),steps:build(node.steps,depth+1)};
    if(node.kind==='strict')return {kind:'strict',positive:node.positive,negative:node.negative,adapters:{positive:session(node.positive,node.positiveSession),negative:session(node.negative,node.negativeSession)}};
    if(node.kind==='observation'){
     if(fingerprint(node.root)!==fingerprint(sessionRoot(node.step.recipe,node.step.session.env)))throw Error('OBSERVED_ROOT_CHANGED');
     const observed=createObservedSupervisor({recipes:{guardian:node.guardian,controller:node.controller},intent:node.step.recipe.request.intent,root:node.root,rawOutputLimitBytes:node.step.recipe.request.intent.budget.outputBytes,unrelatedActionId:node.step.recipe.request.unrelatedActionId,resolveUnrelated:actionId=>options.runner.ownedUnrelated(actionId)},{readFile:read,realpath:files?files.realpath:realpath,now});
     observed.preflight();
     return {kind:'observation',guardian:node.guardian,controller:node.controller,adapters:observed,step:{kind:'session',recipe:node.step.recipe,adapters:session(node.step.recipe,node.step.session,observed)}};
    }
    if(node.kind==='endpoint'){
     if(node.launch.executable!==manifest.node.path||node.launch.argvPrefix.length)throw Error('PINNED_DIRECT_ENDPOINT_REQUIRED');
     const intentNode=findSession(proposal.steps);if(!intentNode)throw Error('ENDPOINT_HELPER_TARGET_REQUIRED');const intent=intentNode.recipe.request.intent;
     let expected:LaunchSpec,endpointGate:(()=>void)|undefined;
     const backend=createControlledEndpointBackend({manifest,launch:node.launch,readResource:read,now,supervisorFor:capture=>supervisor(intent,expected,capture,()=>{if(!endpointGate)throw Error('ENDPOINT_GATE_REQUIRED');endpointGate();})});expected=backend.launch;
     if(fingerprint(expected)!==fingerprint(node.recipe.launch)||!sameOwner(expected)||node.recipe.executionId!==expected.actionId||node.recipe.generation!==expected.actionId)throw Error('ENDPOINT_RECIPE_CHANGED');
     return {kind:'endpoint',recipe:node.recipe,steps:build(node.steps,depth+1),adapters:{launch:backend.launch,start:async(capture,gate)=>{
      endpointGate=gate;const resource=await backend.start(capture,gate);services.set(node.recipe.actionId,{backend,resource:{client:backend.client(),ownership:resource.ownership}});return resource;
     },recoverOwned:backend.recoverOwned,stop:async(resource,capture,gate)=>{try{return await backend.stop(resource,capture,gate);}finally{services.delete(node.recipe.actionId);}}}};
    }
    if(node.kind==='fixed'){
     const intent=node.recipe.request.intent;
     if(node.recipe.boundary.role==='worker'){
      if(!node.session||fingerprint(node.env)!==fingerprint(node.session.env)||node.session.fixture.boundaryDriver?.path!==manifest.driver.path||node.session.fixture.boundaryDriver.sha256!==manifest.driver.sha256)throw Error('WORKER_FIXED_RESOURCE_REQUIRED');
      const worker=session(node.recipe,node.session),adapters:FixedAdapters={...worker,io:(_capture,_owned,gate)=>createFixedDriverBackend({manifest,request:node.recipe.boundary,readResource:read,workerChannel:worker.channel(),effectGate:gate,controller:controller(gate)})};
      return {kind:'fixed',recipe:node.recipe,adapters};
     }
     const root=sessionRoot(node.recipe,node.env),separator=node.recipe.request.argv.indexOf('--');if(separator<0)throw Error('VERIFIER_PREFIX_REQUIRED');
     const {argv:_argv,stdin:_stdin,...base}=root;
     let backend:ReturnType<typeof createFixedVerifierBackend>|undefined;
     const adapters:FixedAdapters={mode:'verifier-channel',currentAdmission:options.currentAdmission,process:(capture,gate)=>{
      if(backend)throw Error('VERIFIER_RESOURCE_REPLAY');
      backend=createFixedVerifierBackend({manifest,request:node.recipe.boundary,launch:{...base,argvPrefix:node.recipe.request.argv.slice(0,separator+1)},readResource:read,now,supervisorFor:rawCapture=>supervisor(intent,root,rawCapture,()=>gate('BOOTSTRAP')),controller:controller(gate),brokerInventory:()=>{
       const service=[...services.values()][0];if(!service)throw Error('CHARGED_BROKER_NOT_OWNED');return service.backend.client().inventory();
      }});
      if(fingerprint(backend.launchSpec)!==fingerprint(root))throw Error('VERIFIER_LAUNCH_CHANGED');return backend.process(capture,gate);
     },io:(capture,owned,gate)=>{if(!backend)throw Error('VERIFIER_NOT_OWNED');return backend.io(capture,owned,gate);}};
     return {kind:'fixed',recipe:node.recipe,adapters};
    }
    throw Error('RUNTIME_NODE_UNSUPPORTED');
   });
  };
  const steps=build(proposal.steps);
  return {ok:true,value:{steps,dispatch:()=>dispatchCampaignBatch(options.runner,steps)}};
 }catch{return refused();}
}
function findSession(nodes:readonly CampaignRuntimeNode[]):{recipe:SessionRecipe|FixedRecipe|MetadataRecipe|StrictRecipe}|undefined{
 for(const node of nodes){if(node.kind==='session'||node.kind==='metadata'||node.kind==='fixed')return node;if(node.kind==='strict')return {recipe:node.positive};if(node.kind==='observation')return node.step;if('steps' in node){const result=findSession(node.steps);if(result)return result;}}
 return undefined;
}
