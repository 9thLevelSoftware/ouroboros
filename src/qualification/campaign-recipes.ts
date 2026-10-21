import { createHash } from 'node:crypto';
import type { Result } from '../contracts/common.ts';
import { buildCodexLaunchConfig, type CodexLaunchConfigInput } from '../providers/codex/launch-config.ts';
import { StartupIntentSchema } from './codex-startup-authority.ts';
import { campaignRecipeHash, type FixedRecipe, type SessionRecipe } from './campaign-runner.ts';
import { type FixedBoundaryOperation } from './fixed-driver.ts';
import { createFixedDriverManifestV2, type FixedDriverManifestV2 } from './fixed-driver-backend.ts';
import { fingerprint, REQUIRED_CODEX_WINDOWS_PROBES } from './probes.ts';
import { targetFingerprint, type QualificationTarget } from './ledger.ts';
import type { SessionRequest } from './session-drivers.ts';

const sessionIds = ['worker.subscription_request','worker.correlated_lifecycle','worker.allowed_edit','worker.unapproved_config_inactive',
 'controller.foreground_cancel','controller.detached_descendant_cancel','controller.controller_death','controller.helper_death',
 'controller.pending_dispatch_cancel','controller.auth_stop','controller.quota_stop'] as const;
const boundaryOperations = ['denied_source_write','denied_controller_write','denied_sibling_write','denied_sensitive_read',
 'allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback','link_escape','broker_escape'] as const;
export type CampaignProbeRoute = {probeId:string;kind:'session'|'fixed';role:'worker'|'verifier'|'controller';backend:'session'|'worker-command'|'verifier-channel';operation?:FixedBoundaryOperation};
/** Explicit v2 routes. This deliberately does not use the partial legacy v1 map. */
export const CAMPAIGN_PROBE_ROUTES:readonly CampaignProbeRoute[] = Object.freeze([
 ...sessionIds.map(probeId=>Object.freeze({probeId,kind:'session' as const,role:probeId.startsWith('controller.')?'controller' as const:'worker' as const,backend:'session' as const})),
 Object.freeze({probeId:'verifier.allowed_command',kind:'fixed' as const,role:'verifier' as const,backend:'verifier-channel' as const,operation:'allowed_edit' as const}),
 ...(['worker','verifier'] as const).flatMap(role=>boundaryOperations.map(operation=>Object.freeze({probeId:`${role}.${operation}`,kind:'fixed' as const,role,backend:role==='worker'?'worker-command' as const:'verifier-channel' as const,operation}))),
]);

export type CampaignRecipeInput = {target:QualificationTarget;request:SessionRequest;launch:CodexLaunchConfigInput;manifest?:FixedDriverManifestV2};
function fail(code:string):Result<never>{return {ok:false,error:{code,message:'Campaign recipe refused offline validation',evidenceIds:[]}};}
/** Pure construction only. Admissions are cleared because the completed recipe
 * must receive its own independently reviewed admission after its hash exists. */
export function buildCampaignRecipe(probeId:string,input:CampaignRecipeInput):Result<SessionRecipe|FixedRecipe>{
 try{
  const route=CAMPAIGN_PROBE_ROUTES.find(route=>route.probeId===probeId),definition=REQUIRED_CODEX_WINDOWS_PROBES.find(probe=>probe.id===probeId);
  if(!route||!definition||route.role!==definition.role)return fail('CAMPAIGN_UNKNOWN_PROBE');
  const request=structuredClone(input.request),intent=request.intent,target=input.target,role=route.role==='verifier'?'verifier':'worker';
  if(intent.owner.role!==role||intent.action!==(role==='verifier'?'verifier':'worker-start')||intent.dispatchAuthorization.kind!=='qualification'||intent.dispatchAuthorization.requestId!==intent.requestId||intent.dispatchAuthorization.probeId!==probeId||
   fingerprint(intent.runtime)!==fingerprint(target.runtime)||intent.adapterHash!==target.adapter.sha256||intent.helper.path!==target.helper.path||intent.helper.sha256!==target.helper.sha256||intent.verifierHash!==target.verifier.wrapperHash||intent.osCapabilitiesHash!==target.os.sha256||intent.configHash!==target.startupConfigHash||intent.model!==target.model||intent.effort!==target.effort)return fail('CAMPAIGN_TARGET_BINDING');
  if(input.launch.entryPoint!==role||input.launch.baseline.permission.name!==intent.profile||role==='worker'&&intent.profile!=='ouroboros_worker')return fail('CAMPAIGN_ROLE_BINDING');
  let launch=structuredClone(input.launch),boundary:FixedRecipe['boundary']|undefined;
  if(route.kind==='fixed'){
   const manifest=input.manifest;if(!manifest)return fail('CAMPAIGN_FIXED_MANIFEST_REQUIRED');
   const {identityHash,...body}=manifest;
   const canonical=createFixedDriverManifestV2({fixtureRoot:manifest.fixtureRoot,targetHash:manifest.targetHash,node:manifest.node,driver:manifest.driver,endpoint:manifest.endpoint,wrapperHash:manifest.wrapperHash,networkPlan:manifest.networkPlan});
   if(identityHash!==fingerprint(body)||fingerprint(manifest)!==fingerprint(canonical)||manifest.schemaVersion!==2||manifest.targetHash!==targetFingerprint(target)||manifest.wrapperHash!==intent.verifierHash||!intent.dispatchAuthorization.fixtureRoots.includes(manifest.fixtureRoot)||fingerprint(manifest.node)!==fingerprint({path:intent.node.path,sha256:intent.node.sha256}))return fail('CAMPAIGN_MANIFEST_BINDING');
   boundary={role,executionId:intent.owner.actionId,operation:route.operation!,fixtureRoot:manifest.fixtureRoot,targetHash:manifest.targetHash,networkPlan:structuredClone(manifest.networkPlan)};
   const command=manifest.commands.find(command=>command.probeId===probeId&&command.role===role&&command.operation===boundary!.operation);
   if(!command||command.resourceSha256!==manifest.driver.sha256||command.executable!==manifest.node.path)return fail('CAMPAIGN_FIXED_COMMAND_REQUIRED');
   if(role==='verifier'){
    if(launch.verifier)return fail('CAMPAIGN_COMMAND_OVERRIDE_REFUSED');
    launch.verifier={cwd:intent.workspace,command:[command.executable,...command.argvPrefix,role,intent.owner.actionId,probeId,boundary.operation,manifest.fixtureRoot,manifest.targetHash,JSON.stringify(manifest.networkPlan),'--channel',manifest.driver.sha256]};
   }
  }
  const config=buildCodexLaunchConfig(launch);if(!config.ok)return config;
  if(config.value.configuration.model!==undefined&&config.value.configuration.model!==intent.model||config.value.configuration.model_reasoning_effort!==undefined&&config.value.configuration.model_reasoning_effort!==intent.effort)return fail('CAMPAIGN_MODEL_BINDING');
  request.argv=[...config.value.argv];request.admissions={};
  intent.argumentsHash=createHash('sha256').update(JSON.stringify(request.argv)).digest('hex');
  if(!StartupIntentSchema.safeParse(intent).success)return fail('CAMPAIGN_INVALID_INTENT');
  if(probeId.startsWith('controller.')&&!probeId.endsWith('_stop')&&(!request.unrelatedActionId||request.unrelated||request.unrelatedActionId===intent.owner.actionId))return fail('CAMPAIGN_UNRELATED_RESOURCE_REQUIRED');
  if(probeId==='controller.pending_dispatch_cancel'&&(!request.pendingActionId||request.pendingActionId===intent.owner.actionId||request.pendingActionId===request.unrelatedActionId))return fail('CAMPAIGN_PENDING_RESOURCE_REQUIRED');
  const recipe:SessionRecipe|FixedRecipe=boundary?{kind:'fixed',actionId:intent.owner.actionId,request,boundary,...(role==='verifier'?{channel:{resourceHash:input.manifest!.driver.sha256}}:{})}:{kind:'session',actionId:intent.owner.actionId,probeId,request};
  intent.dispatchHash=campaignRecipeHash(recipe);
  return {ok:true,value:recipe};
 }catch{return fail('CAMPAIGN_INVALID_INPUT');}
}
