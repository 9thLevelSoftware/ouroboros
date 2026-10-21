import { supportedNodeVersion } from '../runtime/compatibility.ts';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { z } from 'zod';
import { HashSchema, IdSchema, type Result } from '../contracts/common.ts';
import { ExecutionAuthorizationSchema, ExecutionOwnerSchema, WindowsOwnershipReceiptSchema, type OwnershipReceipt } from '../contracts/execution.ts';

const identity=z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const time=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const path=z.string().min(3).max(1024).refine(value=>/^[A-Z]:\\/.test(value)&&!/[\x00-\x1f\x7f]/.test(value)&&win32.normalize(value)===value);
const pinned=z.strictObject({path,sha256:HashSchema});
export const StartupPhaseSchema=z.enum(['UNAUTHORIZED','PREFLIGHT_ACCEPTED','OWNED_PROCESS','INITIALIZED','CONFIG_OBSERVED','REQUIREMENTS_OBSERVED','FENCED','DRAINED']);
export const StartupInputSchema=z.strictObject({
  schemaVersion:z.literal(1),phase:z.literal('PRE_PROCESS'),requestId:IdSchema,
  owner:z.strictObject({runId:IdSchema,generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),actionId:IdSchema,role:z.literal('startup-metadata')}),
  workspace:path,configAncestry:z.array(path).min(1).max(64),
  runtime:pinned.extend({version:z.string().min(1).max(128)}),node:pinned.extend({version:z.string().refine(supportedNodeVersion)}),helper:pinned,
  controllerHash:HashSchema,protocolHash:HashSchema,environmentHash:HashSchema,configHash:HashSchema,boundaryHash:HashSchema,argumentsHash:HashSchema,
  profile:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),sandbox:z.literal('mxc'),
  environmentKeys:z.tuple([z.literal('SystemRoot'),z.literal('SystemDrive'),z.literal('WINDIR'),z.literal('TEMP'),z.literal('TMP'),z.literal('USERPROFILE'),z.literal('APPDATA'),z.literal('LOCALAPPDATA')]),
  issuedAt:time,expiresAt:time,
  expectedExecution:z.strictObject({pid:z.number().int().positive(),creationIdentity:identity,helperPid:z.number().int().positive(),helperCreationIdentity:identity,jobIdentity:identity}),
}).superRefine((value,ctx)=>{
  const ancestry:string[]=[];let parent=value.workspace;
  for(;;){ancestry.unshift(parent);const next=win32.dirname(parent);if(next===parent)break;parent=next;}
  if(JSON.stringify(ancestry)!==JSON.stringify(value.configAncestry)||value.expiresAt<=value.issuedAt||value.expiresAt-value.issuedAt>60000||value.expectedExecution.pid===value.expectedExecution.helperPid)
    ctx.addIssue({code:'custom',message:'Inconsistent startup scope'});
});
export type StartupInput=z.infer<typeof StartupInputSchema>;
export const StartupEvidenceSchema=z.strictObject({schemaVersion:z.literal(1),phase:z.enum(['PRE_PROCESS','METADATA','PRE_THREAD']),
  state:z.enum(['UNKNOWN','CONFLICT','SUPPORTED_SOURCE_ROUTE','OBSERVED_FOR_EXACT_TARGET']),targetHash:HashSchema,observedAt:time});
export type StartupRefusalCode='INVALID_STARTUP_INPUT'|'INVALID_STARTUP_EVIDENCE'|'STALE_STARTUP_INPUT'|'WRONG_AUTHORITY_PHASE'|'WRONG_AUTHORITY_TARGET'|'AUTHORITY_CONFLICT'|'PRELAUNCH_AUTHORITY_UNPROVEN';
function fail<T>(code:string):Result<T>{return {ok:false,error:{code,message:'Startup inspection contract refused',evidenceIds:[]}};}
export function startupTargetHash(input:StartupInput|StartupIntent):string{
 if(input.schemaVersion===2){
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,canonical(child)])):value;
  return createHash('sha256').update(JSON.stringify(canonical(StartupIntentSchema.parse(input)))).digest('hex');
 }
 return createHash('sha256').update(JSON.stringify(StartupInputSchema.parse(input))).digest('hex');
}
/** Legacy evidence stays diagnostic. V2 records human controller dispatch permission,
 * never a complete remote-policy certificate or runtime qualification. */
export function assessStartupAuthority(input:unknown,evidence:unknown,now:number):{authorized:true}|{authorized:false;code:string} {
  if(input&&typeof input==='object'&&'schemaVersion' in input&&input.schemaVersion===2)return assessPhaseAdmission(input,evidence,now,'BOOTSTRAP');
  const parsed=StartupInputSchema.safeParse(input);if(!parsed.success)return {authorized:false,code:'INVALID_STARTUP_INPUT'};
  if(!Number.isSafeInteger(now)||now<parsed.data.issuedAt||now>=parsed.data.expiresAt)return {authorized:false,code:'STALE_STARTUP_INPUT'};
  if(evidence!==null&&evidence!==undefined){
    const e=StartupEvidenceSchema.safeParse(evidence);if(!e.success)return {authorized:false,code:'INVALID_STARTUP_EVIDENCE'};
    if(e.data.phase!=='PRE_PROCESS')return {authorized:false,code:'WRONG_AUTHORITY_PHASE'};
    if(e.data.targetHash!==startupTargetHash(parsed.data))return {authorized:false,code:'WRONG_AUTHORITY_TARGET'};
    if(e.data.observedAt<parsed.data.issuedAt||e.data.observedAt>now)return {authorized:false,code:'STALE_STARTUP_INPUT'};
    if(e.data.state==='CONFLICT')return {authorized:false,code:'AUTHORITY_CONFLICT'};
  }
  return {authorized:false,code:'PRELAUNCH_AUTHORITY_UNPROVEN'};
}

export const STARTUP_SURFACES=['plugins','browser-computer','mcp','remote-control','hooks-notify','apps','web'] as const;
export const STARTUP_SOURCES=['packaged','system','managed','user','project','session','cloud','plugin'] as const;
export const ORDINARY_STARTUP_EFFECTS=['managed-auth','managed-policy','runtime-storage','runtime-logging'] as const;
export const MANAGED_ENVIRONMENT_KEYS=['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'] as const;
/** Intent contains reviewed non-secret inputs, not future kernel process identities. */
const {expectedExecution:_expectedExecution,...intentFields}=StartupInputSchema.shape;
export const StartupIntentSchema=z.strictObject({...intentFields,
  schemaVersion:z.literal(2),owner:ExecutionOwnerSchema,authMode:z.literal('managed-chatgpt'),action:z.enum(['metadata','worker-start','worker-resume','verifier']),dispatchAuthorization:ExecutionAuthorizationSchema,
  adapterHash:HashSchema,verifierHash:HashSchema,osCapabilitiesHash:HashSchema,controlHash:HashSchema,dispatchHash:HashSchema,model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/),effort:identity,
  budget:z.strictObject({activeMs:z.number().int().positive().max(60000),outputBytes:z.number().int().positive().max(2097152),cleanupMs:z.number().int().positive().max(15000)}),
  environmentKeys:z.array(z.enum(MANAGED_ENVIRONMENT_KEYS)).max(8).refine(keys=>new Set(keys.map(key=>key.toLowerCase())).size===keys.length),
}).superRefine((value,ctx)=>{
  const ancestry:string[]=[];let parent=value.workspace;for(;;){ancestry.unshift(parent);const next=win32.dirname(parent);if(next===parent)break;parent=next;}
  if(JSON.stringify(ancestry)!==JSON.stringify(value.configAncestry)||value.expiresAt<=value.issuedAt||value.expiresAt-value.issuedAt>60000||value.action==='metadata'&&value.owner.role!=='startup-metadata'||value.action==='verifier'&&value.owner.role!=='verifier')ctx.addIssue({code:'custom',message:'Inconsistent intent scope'});
});
export type StartupIntent=z.infer<typeof StartupIntentSchema>;
const controlSchema=z.strictObject({surface:z.enum(STARTUP_SURFACES),lifecycle:z.array(z.enum(['bootstrap','thread-start','thread-resume','verifier'])).min(1).max(4).refine(values=>new Set(values).size===values.length),
  sources:z.array(z.enum(STARTUP_SOURCES)).length(8).refine(values=>new Set(values).size===8),controlHash:HashSchema,
  route:z.enum(['supported-restriction','contained-qualification','blocked']),evidenceHash:HashSchema.optional(),qualificationRef:identity.optional(),
  persistent:z.boolean().optional(),containmentHash:HashSchema.optional(),hostAccessBounded:z.boolean().optional(),externalDestinationsBounded:z.boolean().optional()});
const QualificationPhaseAdmissionSchema=z.strictObject({schemaVersion:z.literal(1),phase:z.enum(['BOOTSTRAP','PRE_THREAD','TURN','VERIFIER']),intentHash:HashSchema,owner:ExecutionOwnerSchema,
  issuedAt:time,expiresAt:time,ordinaryEffects:z.array(z.enum(ORDINARY_STARTUP_EFFECTS)).length(4).refine(values=>new Set(values).size===4),
  budget:z.strictObject({activeMs:z.number().int().positive().max(60000),outputBytes:z.number().int().positive().max(2097152),cleanupMs:z.number().int().positive().max(15000)}),
  authorization:z.union([z.strictObject({kind:z.literal('qualification'),requestId:IdSchema}),z.strictObject({kind:z.literal('qualified'),qualificationRef:identity})]),
  controls:z.array(controlSchema).length(7).refine(values=>new Set(values.map(value=>value.surface)).size===7),
  ownershipHash:HashSchema.optional(),observationHash:HashSchema.optional()});
/** Ordinary explicit task permission is not a runtime qualification receipt.
 * The controller binds its requested recipe here; the adapter must still inspect
 * actual account, configuration, requirements and thread settings before a turn. */
export const TaskPhaseAdmissionSchema=z.strictObject({
  schemaVersion:z.literal(2),semantics:z.literal('requested-controls-and-observed-policy'),
  phase:z.enum(['BOOTSTRAP','PRE_THREAD','TURN','VERIFIER']),intentHash:HashSchema,owner:ExecutionOwnerSchema,
  issuedAt:time,expiresAt:time,ordinaryEffects:QualificationPhaseAdmissionSchema.shape.ordinaryEffects,
  budget:QualificationPhaseAdmissionSchema.shape.budget.extend({activeMs:z.number().int().positive().max(60000)}),
  authorization:z.strictObject({kind:z.literal('user-task'),authorizationId:IdSchema,taskHash:HashSchema}),
  argumentsHash:HashSchema,controlHash:HashSchema,ownershipHash:HashSchema.optional(),observationHash:HashSchema.optional(),
});
export const PhaseAdmissionSchema=z.union([QualificationPhaseAdmissionSchema,TaskPhaseAdmissionSchema]);
export type PhaseAdmission=z.infer<typeof PhaseAdmissionSchema>;
export function ownershipHash(receipt:OwnershipReceipt):string{const {capturedAt:_at,...identity}=receipt;return createHash('sha256').update(JSON.stringify(identity)).digest('hex');}
export function assessPhaseAdmission(rawIntent:unknown,rawApproval:unknown,now:number,phase:PhaseAdmission['phase'],owned?:OwnershipReceipt,observationHash?:string):{authorized:true}|{authorized:false;code:string}{
  const i=StartupIntentSchema.safeParse(rawIntent),a=PhaseAdmissionSchema.safeParse(rawApproval);
  if(!i.success||!a.success)return {authorized:false,code:'INVALID_PHASE_ADMISSION'};
  const intent=i.data,approval=a.data;
  if(phase==='VERIFIER'&&intent.action!=='verifier'||(phase==='PRE_THREAD'||phase==='TURN')&&intent.action!=='worker-start'&&intent.action!=='worker-resume')return {authorized:false,code:'WRONG_ADMISSION_SCOPE'};
  if(!Number.isSafeInteger(now)||now<intent.issuedAt||now>=intent.expiresAt||now<approval.issuedAt||now>=approval.expiresAt||approval.issuedAt<intent.issuedAt||approval.expiresAt>intent.expiresAt)return {authorized:false,code:'STALE_STARTUP_INPUT'};
  if(approval.phase!==phase||approval.intentHash!==startupTargetHash(rawIntent as StartupIntent)||JSON.stringify(approval.owner)!==JSON.stringify(intent.owner))return {authorized:false,code:'WRONG_ADMISSION_SCOPE'};
  if(approval.authorization.kind==='qualification'&&approval.authorization.requestId!==intent.requestId)return {authorized:false,code:'WRONG_ADMISSION_SCOPE'};
  if(intent.dispatchAuthorization.kind!==approval.authorization.kind||intent.dispatchAuthorization.kind==='qualified'&&approval.authorization.kind==='qualified'&&intent.dispatchAuthorization.qualificationRef!==approval.authorization.qualificationRef||intent.dispatchAuthorization.kind==='qualification'&&approval.authorization.kind==='qualification'&&intent.dispatchAuthorization.requestId!==approval.authorization.requestId)return {authorized:false,code:'WRONG_ADMISSION_SCOPE'};
  if(approval.schemaVersion===2){
    if(intent.dispatchAuthorization.kind!=='user-task'||approval.authorization.authorizationId!==intent.dispatchAuthorization.authorizationId||approval.authorization.taskHash!==intent.dispatchAuthorization.taskHash||approval.argumentsHash!==intent.argumentsHash||approval.controlHash!==intent.controlHash||intent.action==='metadata'||intent.action==='worker-resume')return {authorized:false,code:'WRONG_ADMISSION_SCOPE'};
  }
  if(JSON.stringify(approval.budget)!==JSON.stringify(intent.budget))return {authorized:false,code:'WRONG_ADMISSION_BUDGET'};
  const lifecycle=phase==='BOOTSTRAP'?'bootstrap':phase==='VERIFIER'?'verifier':intent.action==='worker-resume'?'thread-resume':'thread-start';
  for(const control of approval.schemaVersion===1?approval.controls:[]){
    if(control.controlHash!==intent.controlHash||!control.lifecycle.includes(lifecycle)||control.route==='blocked')return {authorized:false,code:'STARTUP_CONTROL_UNPROVEN'};
    if(control.route==='contained-qualification'){
      if(approval.authorization.kind!=='qualification'||!control.containmentHash||control.hostAccessBounded!==true||control.externalDestinationsBounded!==true)return {authorized:false,code:'QUALIFICATION_NOT_CONTAINED'};
    }else if(!control.evidenceHash||control.persistent!==true||approval.authorization.kind==='qualified'&&control.qualificationRef!==approval.authorization.qualificationRef)return {authorized:false,code:'STARTUP_CONTROL_UNPROVEN'};
  }
  if(phase!=='BOOTSTRAP'){
    const receipt=WindowsOwnershipReceiptSchema.safeParse(owned);
    if(!receipt.success||receipt.data.pid===receipt.data.helperPid||receipt.data.capturedAt<intent.issuedAt||receipt.data.capturedAt>now||JSON.stringify(Object.fromEntries(Object.keys(intent.owner).map(key=>[key,receipt.data[key as keyof typeof receipt.data]])))!==JSON.stringify(intent.owner)||receipt.data.boundaryHash!==intent.boundaryHash||approval.ownershipHash!==ownershipHash(receipt.data)||!observationHash||approval.observationHash!==observationHash)return {authorized:false,code:'OWNERSHIP_OR_OBSERVATION_MISMATCH'};
  }
  return {authorized:true};
}
declare const metadataPlanBrand:unique symbol;
export type StartupMetadataPlan=Readonly<{kind:'metadata-inspection-plan';[metadataPlanBrand]:true}>;
type InspectionInput=StartupInput&{admittedTargetHash?:string;admittedBudget?:StartupIntent['budget'];admissionDeadline?:number};
const plans=new WeakMap<object,InspectionInput>();
/** Validated, one-use inspection data only. This is never authority to create a process. */
export function prepareStartupMetadataInspection(input:unknown,now=Date.now(),admitted?:{approval:PhaseAdmission;ownership:OwnershipReceipt}):Result<StartupMetadataPlan> {
  const intent=StartupIntentSchema.safeParse(input);
  if(intent.success){
    if(intent.data.action!=='metadata'||!admitted||!assessPhaseAdmission(input,admitted.approval,now,'BOOTSTRAP').authorized)return fail('INVALID_PHASE_ADMISSION');
    const receipt=WindowsOwnershipReceiptSchema.safeParse(admitted.ownership);
    if(!receipt.success||receipt.data.pid===receipt.data.helperPid||receipt.data.capturedAt<intent.data.issuedAt||receipt.data.capturedAt>now||receipt.data.boundaryHash!==intent.data.boundaryHash||Object.entries(intent.data.owner).some(([key,value])=>receipt.data[key as keyof typeof receipt.data]!==value))return fail('OWNERSHIP_MISMATCH');
    const {schemaVersion:_version,authMode:_auth,action:_action,adapterHash:_adapter,verifierHash:_verifier,osCapabilitiesHash:_os,model:_model,effort:_effort,controlHash:_control,dispatchHash:_dispatch,budget:_budget,dispatchAuthorization:_authorization,...legacy}=intent.data;
    const bound=StartupInputSchema.safeParse({...legacy,schemaVersion:1,expectedExecution:{pid:receipt.data.pid,creationIdentity:receipt.data.creationIdentity,helperPid:receipt.data.helperPid,helperCreationIdentity:receipt.data.helperCreationIdentity,jobIdentity:receipt.data.jobIdentity}});
    if(!bound.success)return fail('INVALID_STARTUP_INPUT');
    const handle=Object.freeze({kind:'metadata-inspection-plan' as const}) as StartupMetadataPlan;plans.set(handle,{...bound.data,admittedTargetHash:startupTargetHash(input as StartupIntent),admittedBudget:intent.data.budget,admissionDeadline:Math.min(intent.data.expiresAt,admitted.approval.expiresAt)});return {ok:true,value:handle};
  }
  const parsed=StartupInputSchema.safeParse(input);if(!parsed.success)return fail('INVALID_STARTUP_INPUT');
  if(!Number.isSafeInteger(now)||now<parsed.data.issuedAt||now>=parsed.data.expiresAt)return fail('STALE_STARTUP_INPUT');
  const handle=Object.freeze({kind:'metadata-inspection-plan' as const}) as StartupMetadataPlan;
  plans.set(handle,parsed.data);return {ok:true,value:handle};
}
/** Internal handoff consumes before asynchronous work, preventing concurrent reuse. */
export function consumeStartupMetadataPlan(plan:StartupMetadataPlan,now:number):Result<InspectionInput> {
  if(!plan||typeof plan!=='object')return fail('INVALID_INSPECTION_PLAN');
  const input=plans.get(plan);plans.delete(plan);
  if(!input)return fail('INVALID_INSPECTION_PLAN');
  if(!Number.isSafeInteger(now)||now<input.issuedAt||now>=Math.min(input.expiresAt,input.admissionDeadline??Infinity))return fail('STALE_STARTUP_INPUT');
  return {ok:true,value:input};
}
