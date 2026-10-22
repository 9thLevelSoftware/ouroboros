import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import { HashSchema } from '../contracts/common.ts';
import { LaunchSpecSchema, type LaunchSpec, type OwnershipReceipt } from '../contracts/execution.ts';
import { checkControls, checkMetadataControls, type SafeConfig, type SafeRequirements } from '../providers/codex/policy.ts';
import { CODEX_CONFIG_SCHEMA, prevalidateCodexLaunchArgv } from '../providers/codex/launch-config.ts';
import { BatchApprovalSchema, type BatchApproval, type CampaignAction, type QualificationCampaign } from './campaign.ts';
import { campaignRecipeHash, type CampaignRecipe, type SessionAdapters } from './campaign-runner.ts';
import { assessPhaseAdmission, ORDINARY_STARTUP_EFFECTS, ownershipHash, PhaseAdmissionSchema, startupTargetHash, StartupIntentSchema, type PhaseAdmission, type StartupIntent } from './codex-startup-authority.ts';
import { fingerprint } from './probes.ts';

type QualificationAdmission=Extract<PhaseAdmission,{schemaVersion:1}>;
export type ReviewedCampaignControls={schemaVersion:1;controlHash:string;boundaryHash:string;fixtureRoots:string[];
 controls:QualificationAdmission['controls'];pins:Array<{path:string;sha256:string}>;
 sourceArtifacts?:Array<{id:string;sha256:string}>};
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const CampaignControlGrantSchema=z.strictObject({schemaVersion:z.literal(1),batchHash:HashSchema,controlsHash:HashSchema,recipesHash:HashSchema,launchesHash:HashSchema,
 targetHash:HashSchema,fixtureHash:HashSchema,endpointHash:HashSchema,issuedAt:positive,expiresAt:positive,
 limits:z.strictObject({actions:positive,activeMs:positive,outputBytes:positive})});
export type CampaignControlGrant=z.infer<typeof CampaignControlGrantSchema>;
type Options={campaign:QualificationCampaign;batch:BatchApproval;controls:ReviewedCampaignControls;recipes:readonly CampaignRecipe[];launches:readonly LaunchSpec[];grant:CampaignControlGrant;
 currentGrant():CampaignControlGrant|undefined;currentInputs():{targetHash:string;fixtureHash:string;endpointHash:string};now?():number;
 currentPolicy?():{configuration:SafeConfig;requirements:SafeRequirements}|undefined;
 readPin?:(path:string)=>Uint8Array};
const frozen=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const same=(a:unknown,b:unknown)=>fingerprint(a)===fingerprint(b);
const absolute=(path:string)=>/^[A-Z]:\\/.test(path)&&win32.normalize(path)===path&&!path.slice(2).includes(':')&&!/[\x00-\x1f]/.test(path);

/** Pure bootstrap construction permits the action's admissionHash to be pinned
 * before the complete batch/grant exists. It grants no current permission. */
export function createCampaignPhaseAdmission(intent:StartupIntent,controls:ReviewedCampaignControls,phase:PhaseAdmission['phase'],now:number,owned?:OwnershipReceipt,observationHash?:string):QualificationAdmission {
 StartupIntentSchema.parse(intent);
 if(controls.schemaVersion!==1||controls.controlHash!==intent.controlHash||controls.boundaryHash!==intent.boundaryHash||intent.dispatchAuthorization.kind!=='qualification'||!same(controls.fixtureRoots,intent.dispatchAuthorization.fixtureRoots))throw Error('CONTROL_SCOPE_CHANGED');
 const approval=PhaseAdmissionSchema.parse({schemaVersion:1,phase,intentHash:startupTargetHash(intent),owner:structuredClone(intent.owner),issuedAt:phase==='BOOTSTRAP'?intent.issuedAt:now,expiresAt:intent.expiresAt,
  ordinaryEffects:[...ORDINARY_STARTUP_EFFECTS],budget:structuredClone(intent.budget),authorization:{kind:'qualification',requestId:intent.requestId},controls:structuredClone(controls.controls),
  ...(phase==='BOOTSTRAP'?{}:{ownershipHash:owned?ownershipHash(owned):undefined,observationHash})});
 if(approval.schemaVersion!==1||!assessPhaseAdmission(intent,approval,now,phase,owned,observationHash).authorized)throw Error('CONTROL_PHASE_REFUSED');
 return frozen(approval);
}

/** Inert external-controller permission. The trusted caller supplies the exact
 * human-authorized grant and reviewed existing control fields. This does not
 * certify runtime policy, source coverage or startup-blocker closure. */
export function createCampaignControls(input:Options):{currentAdmission:SessionAdapters['currentAdmission'];authorizeCurrent(batch:Readonly<BatchApproval>,action:Readonly<CampaignAction>):boolean;authorizeLaunch(spec:Readonly<LaunchSpec>):Promise<boolean>} {
 const batch=frozen(BatchApprovalSchema.parse(structuredClone(input.batch))),controls=frozen(structuredClone(input.controls)),recipes=frozen(structuredClone(input.recipes)),launches=frozen(input.launches.map(launch=>LaunchSpecSchema.parse(structuredClone(launch)))),grant=frozen(CampaignControlGrantSchema.parse(structuredClone(input.grant)));
 const now=input.now??Date.now,readPin=input.readPin??readFileSync;
 if(grant.batchHash!==fingerprint(batch)||grant.controlsHash!==fingerprint(controls)||grant.recipesHash!==fingerprint(recipes)||grant.launchesHash!==fingerprint(launches)||grant.targetHash!==batch.targetHash||grant.fixtureHash!==batch.fixtureHash||grant.endpointHash!==batch.endpointHash||grant.issuedAt>batch.approvedAt||grant.expiresAt<batch.expiresAt)throw Error('EXACT_CONTROLLER_GRANT_REQUIRED');
 const totals=batch.actions.reduce((sum,action)=>({actions:sum.actions+1,activeMs:sum.activeMs+action.maxMs,outputBytes:sum.outputBytes+action.maxOutputBytes}),{actions:0,activeMs:0,outputBytes:0});
 if(totals.actions>grant.limits.actions||totals.activeMs>grant.limits.activeMs||totals.outputBytes>grant.limits.outputBytes||!controls.pins.length||new Set(controls.pins.map(pin=>pin.path.toLowerCase())).size!==controls.pins.length||controls.pins.some(pin=>!absolute(pin.path)||!HashSchema.safeParse(pin.sha256).success)||!controls.fixtureRoots.length||controls.fixtureRoots.some(root=>!absolute(root)))throw Error('CONTROLLER_LIMIT_OR_PIN_INVALID');
 const byAction=new Map(recipes.map(recipe=>[recipe.actionId,recipe]));
 if(byAction.size!==recipes.length||recipes.length!==batch.actions.filter(action=>action.kind!=='cleanup').length||recipes.some(recipe=>!batch.actions.some(action=>action.id===recipe.actionId&&action.launchHash===campaignRecipeHash(recipe))))throw Error('EXACT_RECIPES_REQUIRED');
 if(new Set(launches.map(launch=>launch.actionId)).size!==launches.length)throw Error('DUPLICATE_LAUNCH');
 const pinMatches=(path:string,sha256:string)=>controls.pins.some(pin=>pin.path===path&&pin.sha256===sha256);
 const sourceBytes=()=>{for(const ref of controls.sourceArtifacts??[]){const loaded=input.campaign.store.loadArtifact(ref.id);if(!loaded.ok)throw Error('SOURCE_MISSING');const artifact=loaded.value;
  if(artifact.sha256!==ref.sha256||artifact.truncated||artifact.producerStopRequired||artifact.redactionApplied||artifact.rawBytes!==artifact.storedBytes||artifact.storedBytes>8388608)throw Error('SOURCE_INCOMPLETE');
  const bytes=readFileSync(join(input.campaign.store.root,'artifacts',artifact.sha256));if(bytes.length!==artifact.storedBytes||hash(bytes)!==ref.sha256)throw Error('SOURCE_CHANGED');}};
 const current=()=>{
  const at=now();if(!Number.isSafeInteger(at)||at<grant.issuedAt||at>=grant.expiresAt||at<batch.approvedAt||at>=batch.expiresAt||!same(input.currentGrant(),grant)||!same(input.currentInputs(),{targetHash:batch.targetHash,fixtureHash:batch.fixtureHash,endpointHash:batch.endpointHash}))throw Error('CURRENT_GRANT_REQUIRED');
  const snapshot=input.campaign.snapshot(batch.campaignId),run=input.campaign.store.loadRun(batch.owner.runId),rows=input.campaign.store.listQualifications();
  if(!snapshot.ok||!run.ok||!rows.ok||snapshot.value.fenced||snapshot.value.superseded||snapshot.value.reconciliationRequired||snapshot.value.accountingPending||snapshot.value.targetHash!==batch.targetHash||!same(snapshot.value.identity.owner,batch.owner)||run.value.generation!==batch.owner.generation||!rows.value.some(row=>row.kind==='BATCH_APPROVAL'&&same(row.payload,batch)))throw Error('CURRENT_CAMPAIGN_REQUIRED');
  for(const pin of controls.pins)if(hash(readPin(pin.path))!==pin.sha256)throw Error('CONTROL_PIN_CHANGED');sourceBytes();return {at,snapshot:snapshot.value};
 };
 const request=(raw:StartupIntent)=>{
  const {at,snapshot}=current(),recipe=byAction.get(raw.owner.actionId),action=batch.actions.find(action=>action.id===raw.owner.actionId);
  if(!recipe||recipe.kind==='auxiliary'||recipe.kind==='endpoint'||!action||!same(recipe.request.intent,raw))throw Error('EXACT_INTENT_REQUIRED');
  const intent=recipe.request.intent,target=snapshot.target;
  StartupIntentSchema.parse(intent);
  if(intent.requestId!==batch.id||intent.dispatchHash!==action.launchHash||intent.owner.runId!==batch.owner.runId||intent.owner.generation!==batch.owner.generation||intent.dispatchAuthorization.kind!=='qualification'||intent.dispatchAuthorization.requestId!==batch.id||intent.dispatchAuthorization.probeId!==(action.probeId??`auxiliary.${action.kind}`)||!same(intent.runtime,target.runtime)||intent.adapterHash!==target.adapter.sha256||intent.helper.path!==target.helper.path||intent.helper.sha256!==target.helper.sha256||intent.verifierHash!==target.verifier.wrapperHash||intent.osCapabilitiesHash!==target.os.sha256||intent.configHash!==target.startupConfigHash||intent.controllerHash!==snapshot.identity.controllerHash||intent.protocolHash!==snapshot.identity.protocolHash||intent.model!==target.model||intent.effort!==target.effort||intent.budget.activeMs>action.maxMs||intent.budget.outputBytes>action.maxOutputBytes||intent.budget.cleanupMs>(batch.actions.find(cleanup=>cleanup.id===action.cleanupId)?.maxMs??0)||intent.expiresAt>batch.expiresAt||!pinMatches(intent.runtime.path,intent.runtime.sha256)||!pinMatches(intent.helper.path,intent.helper.sha256)||!pinMatches(intent.node.path,intent.node.sha256))throw Error('TARGET_OR_BUDGET_CHANGED');
  const argv=action.kind==='strict-negative'?[...recipe.request.argv,'-c','foo="bar"']:recipe.request.argv;
  if(hash(JSON.stringify(argv))!==intent.argumentsHash)throw Error('ARGUMENTS_CHANGED');
  const entryPoint=action.kind==='strict-negative'?'strict-negative':action.kind==='strict-positive'?'strict-positive':intent.action==='metadata'?'metadata':intent.action==='verifier'?'verifier':'worker';
  const requested=prevalidateCodexLaunchArgv({entryPoint,schema:CODEX_CONFIG_SCHEMA,argv});if(!requested.ok||requested.value.permission.name!==intent.profile)throw Error('REQUESTED_CONFIGURATION_INVALID');
  if(input.currentPolicy){const policy=input.currentPolicy();if(!policy||!(intent.action==='metadata'?checkMetadataControls:checkControls)(policy.configuration,policy.requirements,intent.profile).ok)throw Error('CURRENT_POLICY_CONFLICT');}
  return {at,intent,action};
 };
 const currentAdmission:SessionAdapters['currentAdmission']=(phase,raw,owned,observationHash)=>{try{const {at,intent,action}=request(raw),admission=createCampaignPhaseAdmission(raw,controls,phase,at,owned,observationHash);
   if(phase==='BOOTSTRAP'&&fingerprint(admission)!==action.admissionHash)return undefined;
   const actionState=input.campaign.store.loadAction(intent.owner.actionId);if(phase!=='BOOTSTRAP'&&(!actionState.ok||actionState.value.state!=='DISPATCHED')||actionState.ok&&(actionState.value.state==='OBSERVED'||actionState.value.state==='OUTCOME_UNKNOWN'))return undefined;
   return admission;
  }catch{return undefined;}};
 return {currentAdmission,
  authorizeCurrent:(rawBatch,rawAction)=>{try{current();const action=batch.actions.find(action=>action.id===rawAction.id);if(!same(rawBatch,batch)||!action||!same(action,rawAction))return false;
   const recipe=byAction.get(action.id);if(recipe&&recipe.kind!=='auxiliary'&&recipe.kind!=='endpoint'&&!currentAdmission('BOOTSTRAP',recipe.request.intent,undefined,undefined))return false;return true;
  }catch{return false;}},
  authorizeLaunch:async raw=>{try{current();const spec=LaunchSpecSchema.parse(raw),expected=launches.find(launch=>launch.actionId===spec.actionId);
   if(!expected||!same(spec,expected)||spec.runId!==batch.owner.runId||spec.generation!==batch.owner.generation||spec.authorization.kind!=='qualification'||spec.authorization.requestId!==batch.id||!same(spec.authorization.fixtureRoots,controls.fixtureRoots)||spec.boundaryHash!==controls.boundaryHash||spec.deadline<=now()||spec.deadline>batch.expiresAt||!controls.pins.some(pin=>pin.path===spec.executable))return false;
   const recipe=byAction.get(spec.actionId);if(recipe&&recipe.kind!=='auxiliary'&&recipe.kind!=='endpoint'){if(!currentAdmission('BOOTSTRAP',recipe.request.intent,undefined,undefined)||spec.executable!==recipe.request.intent.runtime.path||hash(JSON.stringify(spec.env))!==recipe.request.intent.environmentHash||hash(JSON.stringify(spec.argv))!==recipe.request.intent.argumentsHash)return false;}
   const record=input.campaign.store.loadAction(spec.actionId);return record.ok&&record.value.state==='DISPATCHED'&&record.value.generation===batch.owner.generation;
  }catch{return false;}}
 };
}
