import {randomUUID} from 'node:crypto';
import {closeSync,fstatSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {join,win32} from 'node:path';
import Database from 'better-sqlite3';
import {z} from 'zod';
import {HashSchema,IdSchema,type Result} from '../contracts/common.ts';
import {OwnerTokenSchema} from '../contracts/evidence.ts';
import {openStore,type RunStore} from '../store/database.ts';
import {QualificationCampaign} from './campaign.ts';
import {PhaseAdmissionSchema} from './codex-startup-authority.ts';
import {createCampaignControls,createCampaignPhaseAdmission,CampaignControlGrantSchema,type ReviewedCampaignControls} from './campaign-controls.ts';
import {createCampaignExecutionPlan,buildCampaignExecutionProposal,campaignExecutionLaunches,campaignExecutionDeficits,executeCampaignUnit,type CampaignExecutionPlan,type CampaignExecutionProposal,type CampaignExecutionReport} from './campaign-execution.ts';
import type {CampaignRuntimeOptions} from './campaign-runtime.ts';
import {fingerprint} from './probes.ts';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),pin=z.strictObject({path:z.string().min(3).max(1024),sha256:HashSchema});
const cost=z.strictObject({actions:positive,activeMs:positive,outputBytes:positive});
const reviewedControls=z.strictObject({schemaVersion:z.literal(1),controlHash:HashSchema,boundaryHash:HashSchema,fixtureRoots:z.array(z.string().min(3).max(1024)).min(1).max(8),
 controls:PhaseAdmissionSchema.options[0].shape.controls,pins:z.array(pin).min(1).max(128),sourceArtifacts:z.array(z.strictObject({id:IdSchema,sha256:HashSchema})).max(256).optional()});
export const CampaignCliHumanGrantSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('human-campaign-cli-grant'),executionPlanHash:HashSchema,campaignId:IdSchema,owner:OwnerTokenSchema,
 targetHash:HashSchema,fixtureHash:HashSchema,endpointHash:HashSchema,storeRoot:z.string().min(3).max(1024),selectedUnitIds:z.array(z.string().min(1).max(128)).min(1).max(34),issuedAt:positive,expiresAt:positive,
 limits:cost,coordinatorEnvelope:cost,controls:reviewedControls,
}).refine(value=>value.expiresAt>value.issuedAt&&value.expiresAt-value.issuedAt<=600000&&new Set(value.selectedUnitIds).size===value.selectedUnitIds.length&&value.coordinatorEnvelope.actions===1,'Exact finite one-process CLI scope and ten-minute human grant required');
export type CampaignCliHumanGrant=z.infer<typeof CampaignCliHumanGrantSchema>;
export type CampaignCliPlan={schemaVersion:1;kind:'campaign-cli-plan';plan:CampaignExecutionPlan;grant:CampaignCliHumanGrant;approvalHash:string};
export type CampaignCliRequest={planFile:string;unit:string;approvePlan?:string|null};
export type CampaignCoordinatorUsage={complete:false;externalMeasurementRequired:true;pid:number;startedAt:number;observedThrough:number;rawOutputBytes:null;exitObserved:false;envelope:CampaignCliHumanGrant['coordinatorEnvelope'];requireAccountingBeforeNextUnit:true};
export type CampaignCliReport={mode:'proposal'|'execution';launched:boolean;approvalHash:string;executionPlanHash:string;campaignId:string;unit:string;proposal?:CampaignExecutionProposal;launches?:ReturnType<typeof campaignExecutionLaunches>;
 totalReservedCost:{actions:number;activeMs:number;outputBytes:number};deficits:ReturnType<typeof campaignExecutionDeficits>;execution?:CampaignExecutionReport;coordinatorAccounting?:CampaignCoordinatorUsage;qualificationAccepted:false};
export type CampaignExecutionCli=(request:CampaignCliRequest)=>Promise<CampaignCliReport>;
type Options={readPlanFile?:(path:string)=>unknown;openExistingStore?:(root:string)=>RunStore;now?:()=>number;
 runtime?:Pick<CampaignRuntimeOptions,'supervisorFactory'|'fs'|'sleep'|'timeoutMs'>;recordCoordinatorUsage?:(usage:CampaignCoordinatorUsage)=>void|Promise<void>};
const frozen=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;};
const same=(a:unknown,b:unknown)=>fingerprint(a)===fingerprint(b);
function must<T>(result:Result<T>):T{if(!result.ok)throw Error(result.error.code);return result.value;}
const add=(a:CampaignCliHumanGrant['limits'],b:CampaignCliHumanGrant['limits'])=>({actions:a.actions+b.actions,activeMs:a.activeMs+b.activeMs,outputBytes:a.outputBytes+b.outputBytes});
function absolute(path:string){return /^[A-Z]:\\/.test(path)&&win32.normalize(path)===path&&!path.slice(2).includes(':')&&!/[\x00-\x1f\x7f]/.test(path);}
function readPlanFile(path:string):unknown{
 const handle=openSync(path,'r');try{const metadata=fstatSync(handle);if(!metadata.isFile()||metadata.size>4194304)throw Error('CAMPAIGN_PLAN_FILE_LIMIT');const bytes=Buffer.alloc(4194305),size=readSync(handle,bytes,0,bytes.length,0);if(size>4194304)throw Error('CAMPAIGN_PLAN_FILE_LIMIT');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));}finally{closeSync(handle);}
}
function openExisting(root:string):RunStore{
 if(!absolute(root)||realpathSync(root).toLowerCase()!==root.toLowerCase())throw Error('EXISTING_CANONICAL_CAMPAIGN_STORE_REQUIRED');
 for(const [path,directory] of [[root,true],[join(root,'artifacts'),true],[join(root,'temporary'),true],[join(root,'store.sqlite'),false]] as const){const metadata=lstatSync(path);if(metadata.isSymbolicLink()||metadata.isDirectory()!==directory||!directory&&!metadata.isFile()||realpathSync(path).toLowerCase()!==path.toLowerCase())throw Error('EXISTING_CANONICAL_CAMPAIGN_STORE_REQUIRED');}
 // RunStore can initialize an empty SQLite file. This command must only open a
 // previously initialized store, so inspect its migration marker read-only.
 const existing=new Database(join(root,'store.sqlite'),{readonly:true,fileMustExist:true});
 try{const versions=existing.prepare('SELECT version FROM migrations ORDER BY version').all() as Array<{version:number}>;if(versions.length!==1||versions[0]!.version!==1)throw Error('EXISTING_INITIALIZED_CAMPAIGN_STORE_REQUIRED');}finally{existing.close();}
 return openStore(root);
}
/** Hash binds the reviewed human fields and control pins as well as the
 * underlying execution plan. It creates no file, owner, fixture or approval. */
export function createCampaignCliPlan(planInput:CampaignExecutionPlan,grantInput:CampaignCliHumanGrant):CampaignCliPlan{
 const plan=must(createCampaignExecutionPlan(planInput.input)),grant=CampaignCliHumanGrantSchema.parse(structuredClone(grantInput));
 if(!same(plan,planInput)||grant.executionPlanHash!==plan.planHash||grant.campaignId!==plan.input.snapshot.identity.id||!same(grant.owner,plan.input.snapshot.identity.owner)||grant.targetHash!==plan.input.snapshot.targetHash||grant.fixtureHash!==plan.input.fixtureHash||grant.endpointHash!==plan.input.endpointHash||!absolute(grant.storeRoot)||grant.selectedUnitIds.some(id=>!plan.units.some(unit=>unit.id===id))||grant.controls.controlHash!==plan.input.controlHash||grant.controls.boundaryHash!==plan.input.boundaryHash||!same(grant.controls.fixtureRoots,[plan.input.prepared.fixtureRoot]))throw Error('CAMPAIGN_CLI_GRANT_BINDING');
 const body={schemaVersion:1 as const,kind:'campaign-cli-plan' as const,plan,grant};return frozen({...body,approvalHash:fingerprint(body)});
}
function parsePlan(raw:unknown):CampaignCliPlan{
 const envelope=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('campaign-cli-plan'),plan:z.custom<CampaignExecutionPlan>(value=>!!value&&typeof value==='object'),grant:CampaignCliHumanGrantSchema,approvalHash:HashSchema}).parse(raw);
 const canonical=createCampaignCliPlan(envelope.plan,envelope.grant);if(canonical.approvalHash!==envelope.approvalHash)throw Error('CAMPAIGN_CLI_PLAN_CHANGED');return canonical;
}

/** Concrete existing-store, one-unit CLI. The dry path only reads the selected
 * JSON file. The live path never creates a campaign, claims/releases ownership
 * or prepares a fixture. Its external host must measure this CLI process's
 * actual exit and complete stdout, then charge them before the next unit. */
export function createCampaignExecutionCli(options:Options={}):CampaignExecutionCli{
 const load=options.readPlanFile??readPlanFile,now=options.now??Date.now;
 return async request=>{
  const startedAt=now(),envelope=parsePlan(load(request.planFile)),{plan,grant}=envelope;
  if(!grant.selectedUnitIds.includes(request.unit))throw Error('CAMPAIGN_CLI_UNIT_NOT_SELECTED');
  const approve=request.approvePlan??null;if(approve!==null&&(!HashSchema.safeParse(approve).success||approve!==envelope.approvalHash))throw Error('CAMPAIGN_CLI_APPROVAL_HASH_MISMATCH');
  const bootstrap=(phase:Parameters<CampaignRuntimeOptions['currentAdmission']>[0],intent:Parameters<CampaignRuntimeOptions['currentAdmission']>[1],owned:Parameters<CampaignRuntimeOptions['currentAdmission']>[2],observation:Parameters<CampaignRuntimeOptions['currentAdmission']>[3])=>{
   if(phase!=='BOOTSTRAP')return undefined;try{return createCampaignPhaseAdmission(intent as Parameters<typeof createCampaignPhaseAdmission>[0],grant.controls,phase,now(),owned,observation);}catch{return undefined;}
  };
  const draft=must(buildCampaignExecutionProposal(plan,request.unit,{snapshot:plan.input.snapshot,now:now(),batchId:randomUUID(),controllerExecutionId:randomUUID(),currentAdmission:bootstrap}));
  const total=add(draft.cost,grant.coordinatorEnvelope),deficits=[...draft.deficits,...campaignExecutionDeficits(total,plan.input.snapshot.remaining),...campaignExecutionDeficits(total,grant.limits,'human-grant')];
  const base:CampaignCliReport={mode:approve===null?'proposal':'execution',launched:false,approvalHash:envelope.approvalHash,executionPlanHash:plan.planHash,campaignId:grant.campaignId,unit:request.unit,totalReservedCost:total,deficits,qualificationAccepted:false};
  if(approve===null)return {...base,proposal:draft,launches:campaignExecutionLaunches(draft)};
  // The explicit hash is the only user confirmation. Refreshing current inputs
  // and pins below supplies no additional authority or approval workflow.
  const currentEnvelope=()=>{const current=parsePlan(load(request.planFile)),at=now();if(current.approvalHash!==approve||at<grant.issuedAt||at>=grant.expiresAt)throw Error('CAMPAIGN_CLI_CURRENT_GRANT_REQUIRED');return current;};
  currentEnvelope();
  if(deficits.length)throw Error('CAMPAIGN_CLI_BUDGET_DEFICIT');
  const store=(options.openExistingStore??openExisting)(grant.storeRoot);
  let controls:ReturnType<typeof createCampaignControls>|undefined,activeGrant:z.infer<typeof CampaignControlGrantSchema>|undefined;
  try{
   // Existing nonce is fenced; this never claims, releases or renews an owner.
   must(store.reserveOutput(grant.owner,null,0));
   const campaign=new QualificationCampaign(store,{now,authorizeCurrent:(batch,action)=>controls?.authorizeCurrent(batch,action)===true});
   const current=()=>{currentEnvelope();return {targetHash:grant.targetHash,fixtureHash:grant.fixtureHash,endpointHash:grant.endpointHash};};
   const admission:CampaignRuntimeOptions['currentAdmission']=(...args)=>controls?controls.currentAdmission(...args):bootstrap(...args);
   const execution=await executeCampaignUnit(plan,request.unit,{...options.runtime,campaign,now,current,currentAdmission:admission,
    authorizeLaunch:async spec=>controls?controls.authorizeLaunch(spec):false,
    authorizeBatch:async proposal=>{
     currentEnvelope();if(proposal.planHash!==plan.planHash||proposal.unit.id!==request.unit||proposal.runtime.batch.campaignId!==grant.campaignId||!same(proposal.runtime.batch.owner,grant.owner)||proposal.runtime.batch.targetHash!==grant.targetHash)return false;
     const snapshot=must(campaign.snapshot(grant.campaignId)),required=add(proposal.cost,grant.coordinatorEnvelope);
     if(campaignExecutionDeficits(required,snapshot.remaining).length||campaignExecutionDeficits(required,grant.limits).length||proposal.runtime.batch.expiresAt>grant.expiresAt)return false;
     const launches=must(campaignExecutionLaunches(proposal)).map(value=>value.spec);
     activeGrant=CampaignControlGrantSchema.parse({schemaVersion:1,batchHash:fingerprint(proposal.runtime.batch),controlsHash:fingerprint(grant.controls),recipesHash:fingerprint(proposal.recipes),launchesHash:fingerprint(launches),targetHash:grant.targetHash,fixtureHash:grant.fixtureHash,endpointHash:grant.endpointHash,issuedAt:grant.issuedAt,expiresAt:grant.expiresAt,limits:grant.limits});
     controls=createCampaignControls({campaign,batch:proposal.runtime.batch,controls:grant.controls as ReviewedCampaignControls,recipes:proposal.recipes,launches,grant:activeGrant,currentGrant:()=>{try{currentEnvelope();return activeGrant;}catch{return undefined;}},currentInputs:current,now});
     return true;
    },
    // This probe must cancel its genuine durable pending descriptor before any
    // child dispatch. An unexpected dispatch is refused and remains a failure;
    // it cannot create an uncharged canary through this CLI.
    pendingCharge:async()=>({ok:false,error:{code:'UNEXPECTED_PENDING_DISPATCH',message:'Pending cancellation requires zero child dispatches',evidenceIds:[]}}),
   });
   const usage:CampaignCoordinatorUsage={complete:false,externalMeasurementRequired:true,pid:process.pid,startedAt,observedThrough:now(),rawOutputBytes:null,exitObserved:false,envelope:grant.coordinatorEnvelope,requireAccountingBeforeNextUnit:true};
   await options.recordCoordinatorUsage?.(usage);
   return {...base,launched:execution.batches.length>0,deficits:execution.deficits,execution,coordinatorAccounting:usage};
  }finally{store.close();}
 };
}
