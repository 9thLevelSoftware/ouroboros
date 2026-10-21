import type { CampaignRecipe, CampaignRunner, CampaignRunResult, SessionRecipe, SessionAdapters, FixedRecipe, FixedAdapters,
 EndpointRecipe, EndpointAdapters, MetadataRecipe, StrictRecipe, AuxiliaryRecipe, AuxiliaryAdapters, ObservationAdapters } from './campaign-runner.ts';
import { CAMPAIGN_PROBE_ROUTES } from './campaign-recipes.ts';
import { deriveBrokerEndpoint } from './fixed-driver-backend.ts';
import { fingerprint } from './probes.ts';

export type CampaignDispatchStep =
 | {kind:'session';recipe:SessionRecipe;adapters:SessionAdapters}
 | {kind:'fixed';recipe:FixedRecipe;adapters:FixedAdapters}
 | {kind:'metadata';recipe:MetadataRecipe;adapters:SessionAdapters}
 | {kind:'strict';positive:StrictRecipe;negative:StrictRecipe;adapters:{positive:SessionAdapters;negative:SessionAdapters}}
 | {kind:'endpoint';recipe:EndpointRecipe;adapters:EndpointAdapters;steps:CampaignDispatchStep[]}
 | {kind:'unrelated';recipe:MetadataRecipe;adapters:SessionAdapters;steps:CampaignDispatchStep[]}
 | {kind:'auxiliary';recipe:AuxiliaryRecipe;adapters:AuxiliaryAdapters;steps:CampaignDispatchStep[]}
 | {kind:'observation';guardian:AuxiliaryRecipe;controller:AuxiliaryRecipe;adapters:ObservationAdapters;step:Extract<CampaignDispatchStep,{kind:'session'}>};
export type CampaignDispatchReport={status:'PASS'|'STOPPED'|'REFUSED';results:CampaignRunResult[]};
/** The caller supplies an explicitly selected approved batch. There is no
 * default catalog sweep and no retry. Resource lifetime wrappers retain their
 * own cleanup even when a nested probe fails. */
export async function dispatchCampaignBatch(runner:CampaignRunner,input:readonly CampaignDispatchStep[]):Promise<CampaignDispatchReport>{
 const recipes:CampaignRecipe[]=[],results:CampaignRunResult[]=[],admissions=new Map<string,SessionAdapters['currentAdmission']>();
 try{
  let count=0;
  const collect=(steps:readonly CampaignDispatchStep[],scope:{unrelated?:string;observed?:string;endpoints:Set<string>},depth=0):void=>{
   if(depth>8)throw Error('TOPOLOGY_DEPTH');
   for(const step of steps){
    if(++count>96)throw Error('TOPOLOGY_SIZE');
    if(step.kind==='strict'){recipes.push(step.positive,step.negative);admissions.set(step.positive.actionId,step.adapters.positive.currentAdmission);admissions.set(step.negative.actionId,step.adapters.negative.currentAdmission);continue;}
    if(step.kind==='observation'){
     if(step.step.recipe.actionId!==step.step.recipe.request.intent.owner.actionId||step.adapters.primaryIntentHash!==fingerprint(step.step.recipe.request.intent)||!step.guardian.bindingHash||step.guardian.bindingHash!==step.controller.bindingHash)throw Error('OBSERVATION_PRIMARY');
     recipes.push(step.guardian,step.controller);collect([step.step],{...scope,observed:step.step.recipe.actionId},depth+1);continue;
    }
    recipes.push(step.recipe);
    if(step.kind!=='endpoint'&&step.kind!=='auxiliary')admissions.set(step.recipe.actionId,step.adapters.currentAdmission);
    if(step.kind==='endpoint'){
     const endpoints=new Set([...scope.endpoints,step.recipe.endpoint,...step.recipe.endpoints??[],...step.recipe.brokerEndpoint?[step.recipe.brokerEndpoint]:[]]);
     collect(step.steps,{...scope,endpoints},depth+1);continue;
    }
    if(step.kind==='unrelated'){collect(step.steps,{...scope,unrelated:step.recipe.actionId},depth+1);continue;}
    if(step.kind==='auxiliary'){collect(step.steps,scope,depth+1);continue;}
    if(step.kind==='metadata')continue;
    const probeId=step.kind==='session'?step.recipe.probeId:`${step.recipe.boundary.role}.${step.recipe.boundary.role==='verifier'&&step.recipe.boundary.operation==='allowed_edit'?'allowed_command':step.recipe.boundary.operation}`;
    const route=CAMPAIGN_PROBE_ROUTES.find(route=>route.probeId===probeId);
    if(!route||route.kind!==step.kind||step.kind==='fixed'&&(route.backend==='verifier-channel')!==(step.adapters.mode==='verifier-channel'))throw Error('PRODUCTION_ROUTE_REQUIRED');
    if(step.kind==='session'&&probeId.startsWith('controller.')&&!probeId.endsWith('_stop')){
     if(!scope.unrelated||scope.unrelated!==step.recipe.request.unrelatedActionId)throw Error('UNRELATED_TOPOLOGY_REQUIRED');
     if(scope.observed!==step.recipe.actionId)throw Error('OBSERVATION_TOPOLOGY_REQUIRED');
    }
    if(step.kind==='fixed'){
     const b=step.recipe.boundary,endpoint=b.operation==='broker_escape'?undefined:b.operation==='allowed_proxy_network'?'http://localhost:18471/allowed':b.operation==='denied_direct_tcp'&&b.networkPlan?`tcp://${b.networkPlan.directTcp.host}:${b.networkPlan.directTcp.port}`:'http://127.0.0.1:18472/denied';
     if(['allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback'].includes(b.operation)&&!scope.endpoints.has(endpoint!))throw Error('ENDPOINT_TOPOLOGY_REQUIRED');
     if(b.operation==='broker_escape'&&!scope.endpoints.has(deriveBrokerEndpoint(b.fixtureRoot,b.targetHash)))throw Error('BROKER_TOPOLOGY_REQUIRED');
    }
   }
  };
  collect(input,{endpoints:new Set()});
  if(!runner.preflight(recipes,admissions).ok)return {status:'REFUSED',results};
 }catch{return {status:'REFUSED',results};}
 let stopped=false;
 const record=(result:CampaignRunResult)=>{results.push(result);if(result.status!=='PASS'||result.unknown)stopped=true;return result;};
 const execute=async(steps:readonly CampaignDispatchStep[]):Promise<void>=>{
  for(const step of steps){
   if(stopped)return;
   switch(step.kind){
    case 'session':record(await runner.runSession(step.recipe,step.adapters));break;
    case 'fixed':record(await runner.runFixed(step.recipe,step.adapters));break;
    case 'metadata':record(await runner.runMetadata(step.recipe,step.adapters));break;
    case 'strict':record(await runner.runStrictPair({positive:step.positive,negative:step.negative},step.adapters));break;
    case 'endpoint':record(await runner.withEndpoint(step.recipe,step.adapters,()=>execute(step.steps)));break;
    case 'unrelated':record(await runner.withUnrelated(step.recipe,step.adapters,()=>execute(step.steps)));break;
    case 'auxiliary':record(await runner.withAuxiliary(step.recipe,step.adapters,()=>execute(step.steps)));break;
    case 'observation':record(await runner.withObservation({guardian:step.guardian,controller:step.controller,primary:step.step.recipe},step.adapters,()=>execute([step.step])));break;
   }
  }
 };
 try{await execute(input);}catch{stopped=true;}
 return {status:stopped?'STOPPED':'PASS',results};
}
