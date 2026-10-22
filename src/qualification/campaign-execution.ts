import {isUnlimited,CampaignCostSchema,type CampaignRemaining} from './campaign-policy.ts';
import {supportedNodeVersion} from '../runtime/compatibility.ts';
import {createHash,randomUUID} from 'node:crypto';
import {win32} from 'node:path';
import {HashSchema,IdSchema,type Result} from '../contracts/common.ts';
import {LaunchSpecSchema,type LaunchSpec} from '../contracts/execution.ts';
import {buildCodexLaunchConfig,type CodexLaunchConfigInput} from '../providers/codex/launch-config.ts';
import {BatchApprovalSchema,CampaignExecutionLimitsSchema,type QualificationCampaign,type CampaignAction} from './campaign.ts';
import {CampaignRunner,campaignRecipeHash,cleanupRecipeHash,type CampaignRecipe,type SessionRecipe,type FixedRecipe,type MetadataRecipe,type StrictRecipe,type AuxiliaryRecipe,type EndpointRecipe,type SessionAdapters} from './campaign-runner.ts';
import {composeCampaignRuntime,type CampaignRuntimeNode,type CampaignRuntimeProposal,type CampaignRuntimeOptions,type RuntimeSessionInputs} from './campaign-runtime.ts';
import {buildCampaignRecipe,CAMPAIGN_PROBE_ROUTES} from './campaign-recipes.ts';
import {createCampaignSessionFixture,type PreparedCampaignFixture} from './campaign-fixture.ts';
import {createFixedDriverManifestV2,type FixedLaunchBase,type PinnedBoundaryResource} from './fixed-driver-backend.ts';
import {DisposableControllerConfigSchema,disposableSpecHash} from './disposable-controller.ts';
import {StartupIntentSchema,assessPhaseAdmission,type StartupIntent} from './codex-startup-authority.ts';
import {PendingDispatchDescriptorSchema} from './pending-dispatch.ts';
import {requiredIntegralProcessMs,requiredStandaloneProcessMs} from './process-budget.ts';
import {REQUIRED_CODEX_WINDOWS_PROBES,fingerprint} from './probes.ts';
import {targetFingerprint} from './ledger.ts';
import {StartupCoverageManifestSchema,type StartupCoverageManifest} from './startup-evidence.ts';
import type {SessionCanary} from './session-driver-backend.ts';
import type {SessionRequest} from './session-drivers.ts';

export type CampaignExecutionSnapshot=Extract<ReturnType<QualificationCampaign['snapshot']>,{ok:true}>['value'];
export type CampaignExecutionBounds={sessionLifetimeMs:number;activeMs:number;sessionOutputBytes:number;resourceLifetimeMs:number;resourceOutputBytes:number;observerOutputBytes:number;cleanupMs:number;cleanupOutputBytes:number};
export type CampaignExecutionStartup={coverage:StartupCoverageManifest;canaries:SessionCanary[]};
export type CampaignExecutionUnit={id:string;kind:'metadata'|'strict-pair'|'probe';probeId?:string;integralProcesses:number;standaloneProcesses:number};
export {CAMPAIGN_EXECUTION_PROBE_ORDER} from './campaign-order.ts';
import {CAMPAIGN_EXECUTION_PROBE_ORDER} from './campaign-order.ts';

type Cost={actions:number;activeMs:number;outputBytes:number};
export type CampaignExecutionPlanInput={snapshot:CampaignExecutionSnapshot;prepared:PreparedCampaignFixture;node:StartupIntent['node'];env:Record<string,string>;boundaryHash:string;controlHash:string;fixtureHash:string;endpointHash:string;
 launches:{worker:Record<'networkDenied'|'networkBoundary',CodexLaunchConfigInput>;verifier:Record<'networkDenied'|'networkBoundary',CodexLaunchConfigInput>};
 startup?:CampaignExecutionStartup;
 observer:{entryPoint:PinnedBoundaryResource;module:PinnedBoundaryResource;dependencies:PinnedBoundaryResource[]};bounds:CampaignExecutionBounds};
export type CampaignExecutionPlan={schemaVersion:1;kind:'native-codex-windows-campaign';input:CampaignExecutionPlanInput;units:CampaignExecutionUnit[];cost:Cost;planHash:string};
export type CampaignExecutionDeficit={scope:string;resource:keyof Cost|'topLevelActions';required:number;available:number;deficit:number};
export type CampaignExecutionProposal={generatedIds:string[];unit:CampaignExecutionUnit;runtime:CampaignRuntimeProposal;cost:Cost;deficits:CampaignExecutionDeficit[];planHash:string;recipes:CampaignRecipe[]};
export type CampaignProposalContext={snapshot:CampaignExecutionSnapshot;now:number;batchId:string;controllerExecutionId:string;currentAdmission:SessionAdapters['currentAdmission'];startup?:CampaignExecutionStartup;id?:()=>string};

const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const clone=<T>(value:T):T=>structuredClone(value);
const jsonHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const zero=():Cost=>({actions:0,activeMs:0,outputBytes:0});
const sum=(a:Cost,b:Cost):Cost=>({actions:a.actions+b.actions,activeMs:a.activeMs+b.activeMs,outputBytes:a.outputBytes+b.outputBytes});
const cost=(actions:readonly CampaignAction[]):Cost=>actions.reduce((value,action)=>sum(value,{actions:1,activeMs:action.maxMs,outputBytes:action.maxOutputBytes}),zero());
const cancellation=(id:string)=>id.startsWith('controller.')&&!id.endsWith('_stop');
const endpoint=(id:string)=>['allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback','broker_escape'].some(suffix=>id.endsWith(`.${suffix}`));
const fail=(code:string):Result<never>=>({ok:false,error:{code,message:'Exact current native campaign inputs and external reviewed authority required',evidenceIds:[]}});
function must<T>(result:Result<T>):T{if(!result.ok)throw Error(result.error.code);return result.value;}
function validateStartup(startup:CampaignExecutionStartup,input:CampaignExecutionPlanInput):CampaignExecutionStartup{
 const coverage=StartupCoverageManifestSchema.parse(startup.coverage),identity=input.snapshot.identity;
 if(coverage.targetHash!==identity.targetHash||coverage.fixtureHash!==input.fixtureHash||coverage.controllerHash!==identity.controllerHash||coverage.protocolHash!==identity.protocolHash||coverage.controlHash!==input.controlHash||coverage.environmentHash!==jsonHash(input.env))throw Error('STARTUP_COVERAGE_BINDING_CHANGED');
 // Actual protected artifact bytes and complete route semantics are checked by
 // the existing backend against its live store immediately before preparation.
 createCampaignSessionFixture(input.prepared,{actionId:identity.id,controlHash:input.controlHash,canaries:startup.canaries});
 return {...clone(startup),coverage};
}
function unitCost(unit:CampaignExecutionUnit,b:CampaignExecutionBounds):Cost{
 const primary=unit.kind==='strict-pair'?2:1,resources=unit.integralProcesses-primary;
 const processes=unit.integralProcesses+unit.standaloneProcesses;
 return {actions:processes*2,activeMs:primary*requiredIntegralProcessMs(1,1+b.sessionLifetimeMs)+resources*requiredIntegralProcessMs(1,1+b.resourceLifetimeMs)+unit.standaloneProcesses*requiredStandaloneProcessMs(1,1+b.resourceLifetimeMs)+processes*b.cleanupMs,
  outputBytes:primary*b.sessionOutputBytes+resources*b.resourceOutputBytes+unit.standaloneProcesses*b.observerOutputBytes+processes*b.cleanupOutputBytes};
}
function checkPlan(plan:CampaignExecutionPlan):void{
 const {planHash,...body}=plan;if(fingerprint(body)!==planHash)throw Error('EXECUTION_PLAN_CHANGED');
}
function current(plan:CampaignExecutionPlan,snapshot:CampaignExecutionSnapshot):void{
 if(fingerprint(snapshot.identity)!==fingerprint(plan.input.snapshot.identity)||snapshot.targetHash!==plan.input.prepared.targetHash||snapshot.fenced||snapshot.superseded||snapshot.reconciliationRequired||snapshot.accountingPending||snapshot.correctionRequired||snapshot.reserved.actions||snapshot.unsuccessfulCorrections>=snapshot.executionLimits.maxUnsuccessfulCorrections)throw Error('CURRENT_TERMINAL_CAMPAIGN_REQUIRED');
}
export function campaignExecutionDeficits(required:Cost,available:CampaignRemaining,scope='campaign'):CampaignExecutionDeficit[]{
 CampaignCostSchema.parse(required);if(isUnlimited(available))return [];
 return (['actions','activeMs','outputBytes'] as const).filter(key=>required[key]>available[key]).map(resource=>({scope,resource,required:required[resource],available:available[resource],deficit:required[resource]-available[resource]}));
}

/** Data-only proposal. No filesystem reads, private-state preparation, process,
 * approval, service or provider request is performed here. All 32 canonical
 * catalog IDs occur exactly once; metadata and strict checks earn no credit. */
export function createCampaignExecutionPlan(raw:CampaignExecutionPlanInput):Result<CampaignExecutionPlan>{
 try{
  const input=clone(raw),s=input.snapshot,b=input.bounds;
  CampaignExecutionLimitsSchema.parse(s.executionLimits);
  if(targetFingerprint(s.target)!==s.targetHash||s.identity.targetHash!==s.targetHash||fingerprint(s.identity.target)!==fingerprint(s.target)||input.prepared.targetHash!==s.targetHash||input.prepared.manifest.targetHash!==s.targetHash||input.prepared.manifest.wrapperHash!==s.target.verifier.wrapperHash||input.prepared.manifest.driver.sha256!==s.identity.driverHash||fingerprint(input.prepared.manifest.node)!==fingerprint({path:input.node.path,sha256:input.node.sha256})||!supportedNodeVersion(input.node.version))return fail('EXECUTION_TARGET_BINDING');
  const manifest=input.prepared.manifest;
  if(fingerprint(manifest)!==fingerprint(createFixedDriverManifestV2({fixtureRoot:manifest.fixtureRoot,targetHash:manifest.targetHash,node:manifest.node,driver:manifest.driver,endpoint:manifest.endpoint,wrapperHash:manifest.wrapperHash,networkPlan:manifest.networkPlan})))return fail('EXECUTION_MANIFEST_BINDING');
  if(![input.boundaryHash,input.controlHash,input.fixtureHash,input.endpointHash].every(value=>HashSchema.safeParse(value).success)||Object.values(b).some(value=>!Number.isSafeInteger(value)||value<=0)||b.resourceLifetimeMs<b.sessionLifetimeMs||b.cleanupMs>15000||b.resourceLifetimeMs>60000)return fail('EXECUTION_BOUNDS_INVALID');
  const pins=[input.observer.entryPoint,input.observer.module,...input.observer.dependencies];
  if(pins.some(pin=>!HashSchema.safeParse(pin.sha256).success||!win32.isAbsolute(pin.path))||new Set(pins.map(pin=>pin.path.toLowerCase())).size!==pins.length)return fail('EXECUTION_OBSERVER_PINS_INVALID');
  for(const role of ['worker','verifier'] as const)for(const profile of ['networkDenied','networkBoundary'] as const){
   const launch=input.launches[role][profile];if(launch.entryPoint!==role||launch.verifier)return fail('EXECUTION_LAUNCH_ROLE');
   // Verifier's concrete neutral channel is injected by buildCampaignRecipe.
   if(role==='worker')must(buildCodexLaunchConfig(launch));
  }
  if(input.startup)input.startup=validateStartup(input.startup,input);
  const units:CampaignExecutionUnit[]=[{id:'metadata',kind:'metadata',integralProcesses:1,standaloneProcesses:0},{id:'strict-pair',kind:'strict-pair',integralProcesses:2,standaloneProcesses:0},
   ...CAMPAIGN_EXECUTION_PROBE_ORDER.map(probeId=>({id:probeId,kind:'probe' as const,probeId,integralProcesses:1+(cancellation(probeId)?1:0)+(endpoint(probeId)?1:0),standaloneProcesses:cancellation(probeId)?2:0}))];
  if(units.length!==34||new Set(CAMPAIGN_EXECUTION_PROBE_ORDER).size!==32||REQUIRED_CODEX_WINDOWS_PROBES.some(probe=>!CAMPAIGN_EXECUTION_PROBE_ORDER.includes(probe.id))||CAMPAIGN_PROBE_ROUTES.length!==32||units.filter(unit=>unit.kind==='probe').some(unit=>!CAMPAIGN_PROBE_ROUTES.some(route=>route.probeId===unit.id)))return fail('EXECUTION_CATALOG_INCOMPLETE');
  const body={schemaVersion:1 as const,kind:'native-codex-windows-campaign' as const,input,units,cost:units.reduce((value,unit)=>sum(value,unitCost(unit,b)),zero())};
  return {ok:true,value:freeze({...body,planHash:fingerprint(body)})};
 }catch(error){return fail(error instanceof Error?error.message:'EXECUTION_PLAN_INVALID');}
}

/** Materialize ONE complete bounded lifetime against the fresh live-store
 * snapshot. The caller supplies a pure external bootstrap-admission resolver;
 * no control route, source restriction, coverage or permission is invented. */
export function buildCampaignExecutionProposal(rawPlan:CampaignExecutionPlan,unitId:string,context:CampaignProposalContext):Result<CampaignExecutionProposal>{
 try{
  checkPlan(rawPlan);const plan=clone(rawPlan),input=plan.input,s=clone(context.snapshot),b=input.bounds,unit=plan.units.find(unit=>unit.id===unitId);
  current(plan,s);if(!unit||!IdSchema.safeParse(context.batchId).success||!IdSchema.safeParse(context.controllerExecutionId).success||!Number.isSafeInteger(context.now)||context.now<=0||typeof context.currentAdmission!=='function')return fail('EXECUTION_CONTEXT_INVALID');
  const sourceId=context.id??randomUUID,generatedIds:string[]=[],id=()=>{const value=sourceId();generatedIds.push(value);return value;},now=context.now,batchId=context.batchId,recipes:CampaignRecipe[]=[],actions:CampaignAction[]=[],prepared=input.prepared;
  const auth=(probeId:string)=>({kind:'qualification' as const,requestId:batchId,probeId,fixtureRoots:[prepared.fixtureRoot]});
  const base=(actionId:string,role:string,probeId:string,lifetime:number):LaunchSpec=>LaunchSpecSchema.parse({runId:s.identity.owner.runId,generation:s.identity.owner.generation,actionId,role,executable:input.node.path,argv:[],cwd:prepared.roots.workspace,env:input.env,boundaryHash:input.boundaryHash,authorization:auth(probeId),stdin:'pipe',leaseTtlMs:10000,deadline:now+lifetime});
  const request=(actionId:string,purpose:string,role:'worker'|'verifier'|'startup-metadata',lifetime=b.sessionLifetimeMs):SessionRequest=>{
   const workspace=prepared.roots.workspace,configAncestry:string[]=[];let parent=workspace;for(;;){configAncestry.unshift(parent);const next=win32.dirname(parent);if(parent===next)break;parent=next;}
   return {argv:[],admissions:{},protectedInputs:clone(prepared.protectedInputs),intent:StartupIntentSchema.parse({schemaVersion:2,phase:'PRE_PROCESS',owner:{runId:s.identity.owner.runId,generation:s.identity.owner.generation,actionId,role},requestId:batchId,workspace,configAncestry,
    runtime:s.target.runtime,node:input.node,helper:{path:s.target.helper.path,sha256:s.target.helper.sha256},controllerHash:s.identity.controllerHash,protocolHash:s.identity.protocolHash,adapterHash:s.target.adapter.sha256,verifierHash:s.target.verifier.wrapperHash,osCapabilitiesHash:s.target.os.sha256,
    environmentHash:jsonHash(input.env),configHash:s.target.startupConfigHash,boundaryHash:input.boundaryHash,argumentsHash:'0'.repeat(64),controlHash:input.controlHash,dispatchHash:'0'.repeat(64),profile:input.launches[role==='verifier'?'verifier':'worker'].networkDenied.baseline.permission.name,sandbox:'mxc',environmentKeys:Object.keys(input.env),issuedAt:now,expiresAt:now+lifetime,authMode:'managed-chatgpt',action:role==='verifier'?'verifier':role==='startup-metadata'?'metadata':'worker-start',dispatchAuthorization:auth(purpose),model:s.target.model,effort:s.target.effort,budget:{activeMs:b.activeMs,outputBytes:b.sessionOutputBytes,cleanupMs:b.cleanupMs}})};
  };
  const session=(r:SessionRequest,startup?:CampaignExecutionStartup):RuntimeSessionInputs=>({env:clone(input.env),fixture:createCampaignSessionFixture(prepared,{actionId:r.intent.owner.actionId,controlHash:input.controlHash,canaries:startup?.canaries??[]})});
  const record=(recipe:CampaignRecipe,kind:CampaignAction['kind'],options:{probeId?:string;auxiliaryFor?:string;auxiliaryRole?:'guardian'|'controller'|'endpoint';resource?:boolean}={}):void=>{
   const cleanupId=id(),standalone=recipe.kind==='auxiliary',deadline='request' in recipe?recipe.request.intent.expiresAt:recipe.launch.deadline;
   let admissionHash=fingerprint({kind:'owned-resource',recipeHash:campaignRecipeHash(recipe)});
   if('request' in recipe){
    recipe.request.intent.dispatchHash=campaignRecipeHash(recipe);
    const admission=context.currentAdmission('BOOTSTRAP',freeze(clone(recipe.request.intent)),undefined,undefined);
    if(!assessPhaseAdmission(recipe.request.intent,admission,now,'BOOTSTRAP').authorized)throw Error('EXECUTION_BOOTSTRAP_ADMISSION_REQUIRED');
    recipe.request.admissions.BOOTSTRAP=clone(admission!);admissionHash=fingerprint(admission);
   }
   const action:CampaignAction={id:recipe.actionId,kind,topLevel:!options.auxiliaryFor,...(options.probeId?{probeId:options.probeId}:{}),...(options.auxiliaryFor?{auxiliaryFor:options.auxiliaryFor,auxiliaryRole:options.auxiliaryRole}:{}),launchHash:campaignRecipeHash(recipe),admissionHash,
    maxMs:standalone?requiredStandaloneProcessMs(now,deadline):requiredIntegralProcessMs(now,deadline),maxOutputBytes:standalone?b.observerOutputBytes:options.resource?b.resourceOutputBytes:b.sessionOutputBytes,cleanupId};
   actions.push(action,{id:cleanupId,kind:'cleanup',topLevel:false,launchHash:cleanupRecipeHash(batchId,action),admissionHash:fingerprint({kind:'owned-terminal-cleanup',batchId,parentActionId:action.id}),maxMs:b.cleanupMs,maxOutputBytes:b.cleanupOutputBytes});recipes.push(recipe);
  };
  const metadata=(lifetime=b.sessionLifetimeMs,resource=false):{recipe:MetadataRecipe;session:RuntimeSessionInputs}=>{
   const r=request(id(),'auxiliary.metadata','startup-metadata',lifetime),config=must(buildCodexLaunchConfig({...input.launches.worker.networkDenied,entryPoint:'metadata'}));r.argv=[...config.argv];r.intent.argumentsHash=fingerprint(r.argv);
   const recipe:MetadataRecipe={kind:'metadata',actionId:r.intent.owner.actionId,request:r};record(recipe,'metadata',{resource});return {recipe,session:session(r)};
  };
  let steps:CampaignRuntimeNode[];
  if(unit.kind==='metadata'){steps=[{kind:'metadata',...metadata()}];}
  else if(unit.kind==='strict-pair'){
   const config=must(buildCodexLaunchConfig({...input.launches.worker.networkDenied,entryPoint:'strict-positive'}));
   const strict=(negative:boolean):StrictRecipe=>{const r=request(id(),`auxiliary.strict-${negative?'negative':'positive'}`,'worker');r.argv=[...config.argv];r.intent.argumentsHash=fingerprint(negative?[...r.argv,'-c','foo="bar"']:r.argv);const recipe:StrictRecipe={kind:'strict',actionId:r.intent.owner.actionId,request:r};record(recipe,negative?'strict-negative':'strict-positive');return recipe;};
   const positive=strict(false),negative=strict(true);steps=[{kind:'strict',positive,negative,positiveSession:session(positive.request),negativeSession:session(negative.request)}];
  }else{
   const probeId=unit.probeId!,route=CAMPAIGN_PROBE_ROUTES.find(route=>route.probeId===probeId)!,role=route.role==='verifier'?'verifier':'worker',r=request(id(),probeId,role),profile=prepared.probeProfiles[probeId];
   if(!profile)throw Error('EXECUTION_PROFILE_REQUIRED');
   r.intent.profile=input.launches[role][profile].baseline.permission.name;
   const unrelated=cancellation(probeId)?metadata(b.resourceLifetimeMs,true):undefined;if(unrelated)r.unrelatedActionId=unrelated.recipe.actionId;
   if(probeId==='controller.pending_dispatch_cancel')r.pendingActionId=id();
   const startup=probeId==='worker.unapproved_config_inactive'?(context.startup??input.startup):undefined;
   if(probeId==='worker.unapproved_config_inactive'){if(!startup)throw Error('EXECUTION_STARTUP_COVERAGE_REQUIRED');r.startupCoverage=validateStartup(startup,input).coverage;}
   const recipe=must(buildCampaignRecipe(probeId,{target:s.target,request:r,launch:input.launches[role][profile],manifest:prepared.manifest}));record(recipe,'probe',{probeId});
   const inputs=session(recipe.request,startup);let step:CampaignRuntimeNode=recipe.kind==='session'?{kind:'session',recipe,session:inputs}:{kind:'fixed',recipe,session:inputs,env:clone(input.env)};
   if(r.pendingActionId){const launch={...base(r.pendingActionId,'pending-canary','auxiliary.preparation',b.resourceLifetimeMs),argv:['--preserve-symlinks-main',prepared.resources.activityDriver.path,'foreground',prepared.fixtureRoot]};inputs.pending=PendingDispatchDescriptorSchema.parse({schemaVersion:1,owner:s.identity.owner,parentActionId:recipe.actionId,actionId:r.pendingActionId,targetHash:s.targetHash,launch,launchHash:fingerprint(launch)});}
   if(unrelated){
    if(step.kind!=='session')throw Error('EXECUTION_OBSERVATION_ROUTE_REQUIRED');
    const root=LaunchSpecSchema.parse({...base(recipe.actionId,role,probeId,b.sessionLifetimeMs),executable:s.target.runtime.path,argv:recipe.request.argv});
    const guardianLaunch={...base(id(),'qualification-guardian','auxiliary.guardian',b.resourceLifetimeMs),executable:s.target.helper.path,argv:['--qualification-observer-v1']};
    const config=DisposableControllerConfigSchema.parse({controllerVersion:1,module:input.observer.module,dependencies:input.observer.dependencies,helper:recipe.request.intent.helper,specHash:disposableSpecHash(root),deadline:root.deadline});
    const controllerLaunch={...base(id(),'qualification-controller','auxiliary.controller',b.resourceLifetimeMs),argv:['--experimental-strip-types',input.observer.entryPoint.path,JSON.stringify(config)]};
    const bindingHash=fingerprint({helperPath:guardianLaunch.executable,guardian:guardianLaunch,controller:controllerLaunch,executionOwner:recipe.request.intent.owner,boundaryHash:root.boundaryHash,rawOutputLimitBytes:recipe.request.intent.budget.outputBytes,primaryIntentHash:fingerprint(recipe.request.intent),unrelatedActionId:unrelated.recipe.actionId});
    const resources=[{path:s.target.runtime.path,sha256:s.target.runtime.sha256},{path:input.node.path,sha256:input.node.sha256},{path:s.target.helper.path,sha256:s.target.helper.sha256},input.observer.entryPoint,input.observer.module,...input.observer.dependencies];
    const auxiliary=(auxRole:'guardian'|'controller',launch:LaunchSpec,executableHash:string):AuxiliaryRecipe=>{const value:AuxiliaryRecipe={kind:'auxiliary',actionId:launch.actionId,role:auxRole,launch,executableHash,resources:clone(resources),bindingHash};record(value,'preparation',{auxiliaryFor:recipe.actionId,auxiliaryRole:auxRole});return value;};
    const guardian=auxiliary('guardian',guardianLaunch,s.target.helper.sha256),controller=auxiliary('controller',controllerLaunch,input.node.sha256);
    step={kind:'unrelated',...unrelated,steps:[{kind:'observation',guardian,controller,root,step}]};
   }
   if(endpoint(probeId)){
    const actionId=id(),spec=base(actionId,'controller','auxiliary.endpoint',b.resourceLifetimeMs),{argv:_argv,stdin:_stdin,...launchBase}=spec;
    const launch:FixedLaunchBase={...launchBase,argvPrefix:[]};
    const actual=LaunchSpecSchema.parse({...spec,argv:['--preserve-symlinks-main',prepared.manifest.endpoint.path,prepared.fixtureRoot,s.targetHash,actionId,JSON.stringify(prepared.manifest.networkPlan)]});
    const resource:EndpointRecipe={kind:'endpoint',actionId,launch:actual,endpoint:prepared.manifest.endpoints[0]!,endpoints:[...prepared.manifest.endpoints],brokerEndpoint:prepared.manifest.brokerEndpoint,networkPlan:clone(prepared.manifest.networkPlan),fixtureRoot:prepared.fixtureRoot,executionId:actionId,generation:actionId,boundaryHash:input.boundaryHash};
    record(resource,'endpoint',{auxiliaryFor:recipe.actionId,auxiliaryRole:'endpoint',resource:true});step={kind:'endpoint',recipe:resource,launch,steps:[step]};
   }
   steps=[step];
  }
  const allowance=s.executionLimits.batchLimits,expiresAt=now+Math.min(allowance.approvalTtlMs,b.resourceLifetimeMs+15000+b.cleanupMs);
  if(expiresAt<now+b.resourceLifetimeMs+b.cleanupMs)throw Error('EXECUTION_APPROVAL_LIFETIME_DEFICIT');
  const batch=BatchApprovalSchema.parse({schemaVersion:isUnlimited(s.remaining)?3:2,id:batchId,campaignId:s.identity.id,owner:s.identity.owner,targetHash:s.targetHash,fixtureHash:input.fixtureHash,endpointHash:input.endpointHash,approvedAt:now,expiresAt,remaining:s.remaining,actions});
  const required=cost(actions),deficits=[...campaignExecutionDeficits(required,s.remaining),...campaignExecutionDeficits(required,{actions:1024,activeMs:allowance.activeMs,outputBytes:allowance.outputBytes},'batch')];
  const topLevel=actions.filter(action=>action.topLevel).length;if(topLevel>allowance.topLevelActions)deficits.push({scope:'batch',resource:'topLevelActions',required:topLevel,available:allowance.topLevelActions,deficit:topLevel-allowance.topLevelActions});
  return {ok:true,value:freeze({generatedIds,unit,runtime:{batch,manifest:prepared.manifest,controllerExecutionId:context.controllerExecutionId,steps},cost:required,deficits,planHash:plan.planHash,recipes})};
 }catch(error){return fail(error instanceof Error?error.message:'EXECUTION_PROPOSAL_INVALID');}
}

/** Replay the inert constructor using its recorded fresh IDs. This validates
 * exact frozen plan semantics rather than trusting a caller's planHash label. */
export function validateCampaignExecutionProposal(plan:CampaignExecutionPlan,proposal:CampaignExecutionProposal,context:Pick<CampaignProposalContext,'snapshot'|'currentAdmission'|'startup'>):boolean{
 try{let used=0;if(!Array.isArray(proposal.generatedIds)||new Set(proposal.generatedIds).size!==proposal.generatedIds.length)return false;
  const rebuilt=buildCampaignExecutionProposal(plan,proposal.unit.id,{...context,now:proposal.runtime.batch.approvedAt,batchId:proposal.runtime.batch.id,controllerExecutionId:proposal.runtime.controllerExecutionId,id:()=>proposal.generatedIds[used++]});
  return rebuilt.ok&&used===proposal.generatedIds.length&&fingerprint(rebuilt.value)===fingerprint(proposal);
 }catch{return false;}
}

export type CampaignExecutionLaunch={kind:'session'|'metadata'|'strict-positive'|'strict-negative'|'endpoint'|'guardian'|'controller'|'pending';spec:LaunchSpec;contingent:boolean};
/** Exact inert grant inputs. Pending is a separately charged contingency;
 * listing it does not authorize its dispatch or claim a process was created. */
export function campaignExecutionLaunches(proposal:CampaignExecutionProposal):Result<CampaignExecutionLaunch[]>{
 try{
  const batch=BatchApprovalSchema.parse(proposal.runtime.batch),launches:CampaignExecutionLaunch[]=[];
  const add=(kind:CampaignExecutionLaunch['kind'],raw:LaunchSpec,contingent=false)=>{
   const spec=LaunchSpecSchema.parse(raw);
   if(spec.runId!==batch.owner.runId||spec.generation!==batch.owner.generation||spec.authorization.kind!=='qualification'||spec.authorization.requestId!==batch.id||spec.deadline<=batch.approvedAt||spec.deadline>batch.expiresAt||launches.some(value=>value.spec.actionId===spec.actionId))throw Error('EXECUTION_LAUNCH_BINDING');
   launches.push({kind,spec,contingent});
  };
  const sessionLaunch=(recipe:SessionRecipe|FixedRecipe|MetadataRecipe|StrictRecipe,env:Record<string,string>,kind:CampaignExecutionLaunch['kind'])=>{
   const intent=StartupIntentSchema.parse(recipe.request.intent),argv=kind==='strict-negative'?[...recipe.request.argv,'-c','foo="bar"']:recipe.request.argv;
   if(jsonHash(env)!==intent.environmentHash||jsonHash(argv)!==intent.argumentsHash)throw Error('EXECUTION_LAUNCH_BINDING');
   add(kind,{...intent.owner,executable:intent.runtime.path,argv,cwd:intent.workspace,env,boundaryHash:intent.boundaryHash,authorization:intent.dispatchAuthorization,stdin:'pipe',leaseTtlMs:10000,deadline:intent.expiresAt});
  };
  const pending=(input:RuntimeSessionInputs)=>{if(input.pending)add('pending',PendingDispatchDescriptorSchema.parse(input.pending).launch,true);};
  const visit=(nodes:CampaignRuntimeNode[],depth=0)=>{
   if(depth>8)throw Error('EXECUTION_TOPOLOGY_DEPTH');
   for(const node of nodes){
    switch(node.kind){
     case 'session':case 'metadata':sessionLaunch(node.recipe,node.session.env,node.kind);pending(node.session);break;
     case 'fixed':sessionLaunch(node.recipe,node.env,'session');if(node.session)pending(node.session);break;
     case 'strict':sessionLaunch(node.positive,node.positiveSession.env,'strict-positive');sessionLaunch(node.negative,node.negativeSession.env,'strict-negative');pending(node.positiveSession);pending(node.negativeSession);break;
     case 'unrelated':sessionLaunch(node.recipe,node.session.env,'metadata');pending(node.session);visit(node.steps,depth+1);break;
     case 'endpoint':add('endpoint',node.recipe.launch);visit(node.steps,depth+1);break;
     case 'observation':add('guardian',node.guardian.launch);add('controller',node.controller.launch);visit([node.step],depth+1);break;
    }
   }
  };
  visit(proposal.runtime.steps);return {ok:true,value:freeze(launches)};
 }catch{return fail('EXECUTION_LAUNCH_LIST_REFUSED');}
}

export type CampaignExecutionReport={status:'EXECUTED'|'UNIT_EXECUTED'|'STOPPED'|'REFUSED';planHash:string;completedUnits:string[];probesExecuted:string[];batches:Array<{unitId:string;batchId:string;status:string;evidenceIds:string[]}>;reason:string;deficits:CampaignExecutionDeficit[];qualificationAccepted:false};
export type CampaignExecutionOptions=Omit<CampaignRuntimeOptions,'runner'|'now'> & {campaign:QualificationCampaign;now():number;current():{fixtureHash:string;endpointHash:string;targetHash:string};authorizeBatch(proposal:Readonly<CampaignExecutionProposal>):Promise<boolean>;currentStartup?:()=>CampaignExecutionStartup|undefined;id?:()=>string};
/** Explicit sequential execution of the proposed complete catalog. Durable
 * approvals, ownership, output capture, cleanup and evidence publication stay
 * in the existing campaign/runtime path. A failed unit is never retried here.
 * EXECUTED is not a qualification or independent startup-review receipt. */
export async function executeCampaignPlan(plan:CampaignExecutionPlan,options:CampaignExecutionOptions):Promise<CampaignExecutionReport>{
 return executeSelectedCampaignUnits(plan,plan.units.map(unit=>unit.id),options,true);
}
/** Explicit one-unit entry point for terminal review boundaries. It does not
 * accept caller completion booleans, reuse old PASSs or confer full-catalog
 * credit. A coordinator may dispatch metadata, review its actual artifacts,
 * then select the next unit with a fresh durable approval and current inputs. */
export async function executeCampaignUnit(plan:CampaignExecutionPlan,unitId:string,options:CampaignExecutionOptions):Promise<CampaignExecutionReport>{
 return executeSelectedCampaignUnits(plan,[unitId],options,false);
}
async function executeSelectedCampaignUnits(plan:CampaignExecutionPlan,unitIds:readonly string[],options:CampaignExecutionOptions,complete:boolean):Promise<CampaignExecutionReport>{
 const report:CampaignExecutionReport={status:'REFUSED',planHash:plan.planHash,completedUnits:[],probesExecuted:[],batches:[],reason:'EXECUTION_REFUSED',deficits:[],qualificationAccepted:false};
 try{
  checkPlan(plan);if(unitIds.some(id=>!plan.units.some(unit=>unit.id===id)))throw Error('EXECUTION_UNKNOWN_UNIT');
  if(typeof options.authorizeBatch!=='function'||typeof options.currentAdmission!=='function'||typeof options.authorizeLaunch!=='function'||unitIds.includes('controller.pending_dispatch_cancel')&&!options.pendingCharge)throw Error('EXECUTION_EXTERNAL_AUTHORITY_REQUIRED');
  const initial=must(options.campaign.snapshot(plan.input.snapshot.identity.id));current(plan,initial);
  const units=unitIds.map(id=>plan.units.find(unit=>unit.id===id)!);
  report.deficits=campaignExecutionDeficits(units.reduce((value,unit)=>sum(value,unitCost(unit,plan.input.bounds)),zero()),initial.remaining);if(report.deficits.length)throw Error('EXECUTION_CAMPAIGN_BUDGET_DEFICIT');
  const id=options.id??randomUUID;
  for(const unit of units){
   const snapshot=must(options.campaign.snapshot(initial.identity.id));current(plan,snapshot);
   const expected={fixtureHash:plan.input.fixtureHash,endpointHash:plan.input.endpointHash,targetHash:snapshot.targetHash};if(fingerprint(options.current())!==fingerprint(expected))throw Error('EXECUTION_CURRENT_INPUT_CHANGED');
   const proposal=must(buildCampaignExecutionProposal(plan,unit.id,{snapshot,now:options.now(),batchId:id(),controllerExecutionId:id(),currentAdmission:options.currentAdmission,startup:options.currentStartup?.(),id}));
   report.deficits=proposal.deficits;if(report.deficits.length)throw Error('EXECUTION_BATCH_BUDGET_DEFICIT');
   // Approval remains an external human/controller decision over the exact
   // frozen proposal. Every native launch also consults its external resolver.
   if(await options.authorizeBatch(freeze(clone(proposal)))!==true)throw Error('EXECUTION_BATCH_AUTHORITY_REFUSED');
   if(fingerprint(options.current())!==fingerprint(expected))throw Error('EXECUTION_CURRENT_INPUT_CHANGED');
   must(options.campaign.approve(proposal.runtime.batch));
   const runner=new CampaignRunner(options.campaign,proposal.runtime.batch,{now:options.now,current:options.current,evidenceKind:'live'});
   const native=must(composeCampaignRuntime(proposal.runtime,{...options,runner}));
   report.status='STOPPED';const dispatched=await native.dispatch();
   report.batches.push({unitId:unit.id,batchId:proposal.runtime.batch.id,status:dispatched.status,evidenceIds:[...new Set(dispatched.results.flatMap(result=>result.evidence.map(ref=>ref.id)))]});
   if(dispatched.status!=='PASS'||!dispatched.results.length||dispatched.results.some(result=>result.status!=='PASS'||result.unknown))throw Error('EXECUTION_UNIT_STOPPED');
   report.completedUnits.push(unit.id);if(unit.kind==='probe')report.probesExecuted.push(unit.probeId!);
  }
  if(complete&&(report.probesExecuted.length!==32||new Set(report.probesExecuted).size!==32||REQUIRED_CODEX_WINDOWS_PROBES.some(probe=>!report.probesExecuted.includes(probe.id))))throw Error('EXECUTION_CATALOG_INCOMPLETE');
  report.status=complete?'EXECUTED':'UNIT_EXECUTED';report.reason=complete?'CATALOG_EXECUTED_INDEPENDENT_ACCEPTANCE_REQUIRED':'SELECTED_UNIT_EXECUTED_INDEPENDENT_ACCEPTANCE_REQUIRED';return report;
 }catch(error){report.reason=error instanceof Error?error.message:'EXECUTION_UNKNOWN';return report;}
}
