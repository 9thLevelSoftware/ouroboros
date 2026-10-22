import {CampaignTerminalObservationSchema,validateCampaignTerminal,type CampaignResourceTerminal} from './campaign-terminal.ts';
import { createHash, randomUUID } from 'node:crypto';
import {win32} from 'node:path';
import type { Result } from '../contracts/common.ts';
import { LaunchSpecSchema, WindowsDrainEvidenceSchema, WindowsOwnershipReceiptSchema, type LaunchSpec, type OwnershipReceipt } from '../contracts/execution.ts';
import { publishArtifact } from '../store/artifacts.ts';
import { BatchApprovalSchema, CampaignProbeEvidenceSchema, type BatchApproval, type CampaignAction, QualificationCampaign } from './campaign.ts';
import { assessPhaseAdmission, ownershipHash, startupTargetHash, type PhaseAdmission, type StartupIntent } from './codex-startup-authority.ts';
import { runFixedBoundaryDriver,validateFixedNetworkPlan, type FixedDriverIO, type FixedDriverRequest,type FixedNetworkPlan } from './fixed-driver.ts';
import { fingerprint, REQUIRED_CODEX_WINDOWS_PROBES } from './probes.ts';
import {assertIntegralProcessBudget,assertStandaloneProcessBudget} from './process-budget.ts';
import { isTerminalDrained, runSessionProbe, runStrictPair, runTerminalMetadata, type SessionDeps, type SessionDispatch, type SessionEvidence, type SessionProcess, type SessionRequest, type SessionResult } from './session-drivers.ts';
import { bindManagedPolicyConflictEvidence, ManagedPolicyConflictProjectionSchema, StartupSessionProofSchema,type StartupSessionProof } from './startup-evidence.ts';

/** The producer must send every raw stdout/stderr chunk here, before parsing or
 * redaction. Bytes are counted and discarded; raw credentials are never stored. */
export type ProcessMeter = { kind: 'root'|'helper'; identity: {pid:number;creationIdentity:string}; activeMs:number };
export type RawCapture = { streamBytes?(source:'root'|'helper'|'controller'|'guardian',stream:'stdout'|'stderr',bytes:number):void;write(bytes: Uint8Array): void; processCompleted(meter:ProcessMeter):void };
export type EffectGate = (phase: PhaseAdmission['phase']|'CLEANUP') => void;
export type SessionAdapters = { process(capture: RawCapture, effectGate: EffectGate): SessionProcess; currentAdmission: NonNullable<SessionDeps['currentAdmission']> };
export type FixedResourceReady = { kind: 'fixed-resource-ready'; resourceHash: string; executionId: string; observationHash: string };
export type FixedRootProcess = Pick<SessionProcess, 'launch'|'fence'|'drain'|'reconcileBrokers'> & {
 initialize(): ReturnType<SessionProcess['initialize']>|Promise<FixedResourceReady>; startThread?: SessionProcess['startThread'];
};
export type FixedAdapters = { mode?: 'session'|'verifier-channel'; process(capture: RawCapture, effectGate: EffectGate): FixedRootProcess; currentAdmission: NonNullable<SessionDeps['currentAdmission']>; io(capture: RawCapture, owned: Readonly<OwnershipReceipt>, effectGate: EffectGate): FixedDriverIO };
export type SessionRecipe = { kind: 'session'; actionId: string; probeId: string; request: SessionRequest };
export type StrictRecipe = { kind: 'strict'; actionId: string; request: SessionRequest };
export type MetadataRecipe = { kind: 'metadata'; actionId: string; request: SessionRequest };
export type FixedRecipe = { kind: 'fixed'; actionId: string; request: SessionRequest; boundary: FixedDriverRequest; channel?: { resourceHash: string } };
export type EndpointRecipe = { kind: 'endpoint'; actionId: string;launch:LaunchSpec; endpoint: string; endpoints?: string[]; brokerEndpoint?: string;networkPlan?:FixedNetworkPlan; fixtureRoot: string; executionId: string; generation: string; boundaryHash: string };
export type AuxiliaryRecipe = {kind:'auxiliary';actionId:string;role:'guardian'|'controller';launch:LaunchSpec;executableHash:string;resources:Array<{path:string;sha256:string}>;bindingHash?:string};
export type CampaignRecipe = SessionRecipe | StrictRecipe | MetadataRecipe | FixedRecipe | EndpointRecipe | AuxiliaryRecipe;
export type AuxiliaryResource = {owner:Pick<LaunchSpec,'runId'|'generation'|'actionId'|'role'>;identity:{pid:number;creationIdentity:string};launchHash:string;createdAt:number};
export type AuxiliaryAdapters = {start(capture:RawCapture,effectGate:()=>void):Promise<AuxiliaryResource>;recoverOwned?():AuxiliaryResource|undefined;stop(resource:Readonly<AuxiliaryResource>,capture:RawCapture,effectGate:()=>void):Promise<AuxiliaryResource&{exited:boolean;exitCode:number|null;outputComplete:boolean;completedAt:number}>};
export type ObservationResources={guardian:AuxiliaryResource;controller:AuxiliaryResource};
export type ObservationAdapters={primaryIntentHash:string;start(captures:{guardian:RawCapture;controller:RawCapture},gates:{guardian:()=>void;controller:()=>void}):Promise<ObservationResources>;recoverOwned?():Partial<ObservationResources>|undefined;stop(resources:Readonly<ObservationResources>,captures:{guardian:RawCapture;controller:RawCapture},gates:{guardian:()=>void;controller:()=>void}):Promise<{guardian:AuxiliaryResource&{exited:boolean;exitCode:number|null;outputComplete:boolean;completedAt:number;activeMs?:number};controller:AuxiliaryResource&{exited:boolean;exitCode:number|null;outputComplete:boolean;completedAt:number;activeMs?:number}}>};
export type EndpointResource = { executionId: string; generation: string; ownership: OwnershipReceipt };
export type EndpointAdapters = {launch:Readonly<LaunchSpec>; start(capture: RawCapture, effectGate: () => void): Promise<EndpointResource>; recoverOwned?():EndpointResource|undefined; stop(resource: Readonly<EndpointResource>, capture: RawCapture, effectGate: () => void): Promise<EndpointResource & { terminated: boolean; outputComplete: boolean; drain: unknown }> };
type EvidenceRef = { id: string; sha256: string; category: string };
export type CampaignRunResult = { status: 'PASS'|'FAIL'|'REFUSED'|'UNTESTED'; reason: string; unknown: boolean; actualAttempt: boolean; catalogProbe: boolean; evidenceKind: 'fixture'|'live'|'fault_injection'; evidence: EvidenceRef[] };
type Context = { terminal?:CampaignResourceTerminal;terminalDrain?:unknown;terminalBroker?:unknown; streams:Map<string,{source:string;stream:string;bytes:number}>;recipe: CampaignRecipe; action: CampaignAction; cleanup: CampaignAction; started: number; cleanupStarted?: number; raw: number; cleanupRaw: number; meters:Map<string,ProcessMeter>;auxiliaryMs?:number;finalized:boolean;failed:boolean; unknown: boolean; cleanupUnknown: boolean; cleaning: boolean; primaryDone: boolean; cleanupDone: boolean; nextSequence: number; seen: Set<string>; owned?: Extract<OwnershipReceipt,{environment:'windows'}>; observationHash?: string; attempted: boolean; adapters?: Pick<SessionAdapters, 'currentAdmission'>; };
type RunnerOptions={now():number;current():{fixtureHash:string;endpointHash:string;targetHash:string};evidenceKind:'fixture'|'live'};
type Phase = PhaseAdmission['phase'];
const must = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.code); return result.value; };
const frozen = <T>(value: T): Readonly<T> => { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; };
const digest = (value: string|Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Admissions are separately pinned by action.admissionHash. Excluding only
 * those and dispatchHash avoids a hash cycle without omitting launch inputs. */
export function campaignRecipeHash(recipe: CampaignRecipe): string {
 if (recipe.kind === 'endpoint'||recipe.kind==='auxiliary') return fingerprint(recipe);
 const { admissions: _admissions, intent, ...request } = recipe.request;
 const { dispatchHash: _dispatch, ...input } = intent;
 return fingerprint({ ...recipe, request: { ...request, intent: input } });
}
export function cleanupRecipeHash(batchId: string, action: CampaignAction|CampaignAction[]): string {
 if(Array.isArray(action))return fingerprint({kind:'owned-topology-cleanup',batchId,parents:action.map(a=>({parentActionId:a.id,parentLaunchHash:a.launchHash})).sort((a,b)=>a.parentActionId.localeCompare(b.parentActionId))});
 return fingerprint({ kind: 'owned-terminal-cleanup', batchId, parentActionId: action.id, parentLaunchHash: action.launchHash });
}
// Evidence retains structure, numbers and booleans. Untrusted strings and keys
// are hashed; no free-form model/process output is promoted to controller facts.
function safeProof(value: unknown, depth = 0): unknown {
 if (depth > 12) throw Error('EVIDENCE_DEPTH_LIMIT');
 if (value === null || typeof value === 'boolean') return value;
 if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('INVALID_EVIDENCE'); return value; }
 if (typeof value === 'string') return { sha256: digest(value), bytes: Buffer.byteLength(value) };
 if (Array.isArray(value)) { if (value.length > 128) throw Error('EVIDENCE_ITEM_LIMIT'); return value.map(item => safeProof(item, depth + 1)); }
 if (value && typeof value === 'object') { const entries = Object.entries(value); if (entries.length > 128) throw Error('EVIDENCE_ITEM_LIMIT'); return entries.filter(([, v]) => v !== undefined).map(([key, child]) => ({ keyHash: digest(key), value: safeProof(child, depth + 1) })); }
 throw Error('INVALID_EVIDENCE');
}

/** Composition has no native process/network defaults. Production backends
 * implement concrete operations with the owned supervisor/transport; tests
 * inject primitives. Approval history alone is never current permission. */
export class CampaignRunner {
 readonly #batch: Readonly<BatchApproval>;
 readonly #used = new Set<string>();
 readonly #contexts=new Map<string,Context>();
 readonly #cleanupStarted=new Map<string,number>();
 readonly #unrelated=new Map<string,{context:Context;identity:{actionId:string;pid:number;creationIdentity:string;name:string}}>();
 readonly #services = new Map<string, { recipe: EndpointRecipe; resource: Readonly<EndpointResource>; context: Context }>();
 readonly campaign:QualificationCampaign;
 readonly options:RunnerOptions;
 constructor(campaign: QualificationCampaign, batch: BatchApproval, options:RunnerOptions) { this.campaign=campaign;this.options=options;this.#batch = frozen(structuredClone(BatchApprovalSchema.parse(batch))); }
 /** Validate the complete selected batch before any process is started. This
  * reads durable approval; it neither creates approval nor consumes an action. */
 preflight(recipes:readonly CampaignRecipe[],admissions?:ReadonlyMap<string,SessionAdapters['currentAdmission']>):Result<void>{
  try{
   const records=must(this.campaign.store.listQualifications());
   if(!records.some(record=>record.kind==='BATCH_APPROVAL'&&fingerprint(record.payload)===fingerprint(this.#batch)))throw Error('DURABLE_BATCH_REQUIRED');
   const state=must(this.campaign.snapshot(this.#batch.campaignId));
   if(state.fenced||state.superseded||state.reconciliationRequired||state.accountingPending)throw Error('CURRENT_CAMPAIGN_REQUIRED');
   this.#current();
   if(this.options.now()<this.#batch.approvedAt||this.options.now()>=this.#batch.expiresAt)throw Error('CURRENT_BATCH_REQUIRED');
   const ids=recipes.map(recipe=>recipe.actionId),expected=this.#batch.actions.filter(action=>action.kind!=='cleanup').map(action=>action.id);
   if(new Set(ids).size!==ids.length||ids.length!==expected.length||expected.some(id=>!ids.includes(id)))throw Error('COMPLETE_BATCH_REQUIRED');
   if(records.some(record=>record.kind==='CAMPAIGN_DISPATCH'&&record.actionId!==null&&ids.includes(record.actionId)))throw Error('FRESH_BATCH_REQUIRED');
   for(const recipe of recipes){
    const currentAdmission=admissions?.get(recipe.actionId),c=this.#context(recipe,currentAdmission?{currentAdmission}:undefined,true);
    if(admissions&&recipe.kind!=='auxiliary'&&recipe.kind!=='endpoint'){if(!currentAdmission)throw Error('CURRENT_PHASE_REQUIRED');this.#phase(c,'BOOTSTRAP');}
    if(this.campaign.options.authorizeCurrent(this.#batch,frozen(structuredClone(c.action)))!==true)throw Error('CURRENT_BATCH_REQUIRED');
   }
   return {ok:true,value:undefined};
  }catch{return {ok:false,error:{code:'CAMPAIGN_PREFLIGHT_REFUSED',message:'Complete exact current durable batch required',evidenceIds:[]}};}
 }
 #kind(probeId?: string): CampaignRunResult['evidenceKind'] { return this.options.evidenceKind === 'fixture' ? 'fixture' : probeId === 'controller.auth_stop' || probeId === 'controller.quota_stop' ? 'fault_injection' : 'live'; }
 #refused(reason: string): CampaignRunResult { return { status: 'REFUSED', reason, unknown: false, actualAttempt: false, catalogProbe: false, evidenceKind: this.#kind(), evidence: [] }; }
 #phase(c: Context, phase: Phase): { intent: StartupIntent; admission: PhaseAdmission; owned?: OwnershipReceipt; observationHash?: string } {
  if (c.recipe.kind === 'endpoint'||c.recipe.kind==='auxiliary' || !c.adapters) throw Error('PHASE_REQUIRED');
  const intent = c.recipe.request.intent;
  const admission = c.adapters.currentAdmission(phase, frozen(structuredClone(intent)), c.owned ? frozen(structuredClone(c.owned)) : undefined, c.observationHash);
  if (!admission || !assessPhaseAdmission(intent, admission, this.options.now(), phase, c.owned, c.observationHash).authorized) throw Error('CURRENT_PHASE_REFUSED');
  if (phase === 'BOOTSTRAP' && fingerprint(admission) !== c.action.admissionHash) throw Error('BOOTSTRAP_APPROVAL_CHANGED');
  return { intent, admission, ...(c.owned ? { owned: c.owned } : {}), ...(c.observationHash ? { observationHash: c.observationHash } : {}) };
 }
 #current() {
  const current = this.options.current();
  if (current.fixtureHash !== this.#batch.fixtureHash || current.endpointHash !== this.#batch.endpointHash || current.targetHash !== this.#batch.targetHash) throw Error('CURRENT_INPUT_CHANGED');
  return current;
 }
 #context(raw: CampaignRecipe, adapters?: Pick<SessionAdapters, 'currentAdmission'>,validateOnly=false): Context {
  const recipe = frozen(structuredClone(raw)) as CampaignRecipe, action = this.#batch.actions.find(a => a.id === recipe.actionId), cleanup = this.#batch.actions.find(a => a.id === action?.cleanupId);
  const parents=this.#batch.actions.filter(a=>a.cleanupId===cleanup?.id);
  if (!action || !cleanup || cleanup.kind !== 'cleanup' || cleanup.launchHash !== cleanupRecipeHash(this.#batch.id, parents.length===1?action:parents) || action.launchHash !== campaignRecipeHash(recipe) || this.#used.has(action.id)) throw Error('EXACT_RECIPE_REQUIRED');
  if (recipe.kind === 'endpoint' ? action.kind !== 'endpoint' : recipe.kind==='auxiliary'?action.kind!=='preparation':recipe.kind === 'metadata' ? action.kind !== 'metadata' : recipe.kind === 'strict' ? !['strict-positive','strict-negative'].includes(action.kind) : action.kind !== 'probe') throw Error('ACTION_KIND_MISMATCH');
  if(recipe.kind==='auxiliary'){
   const launch=LaunchSpecSchema.parse(recipe.launch),identity=must(this.campaign.snapshot(this.#batch.campaignId)).identity;
   if(!action.topLevel&&action.auxiliaryRole!==recipe.role)throw Error('AUXILIARY_ROLE_MISMATCH');
   if(!['guardian','controller'].includes(recipe.role)||launch.role!==`qualification-${recipe.role}`||launch.runId!==this.#batch.owner.runId||launch.generation!==this.#batch.owner.generation||launch.actionId!==action.id||launch.authorization.kind!=='qualification'||launch.authorization.requestId!==this.#batch.id||launch.authorization.probeId!==`auxiliary.${recipe.role}`||launch.deadline<=this.options.now()||launch.deadline>this.options.now()+action.maxMs||!recipe.resources.length||recipe.resources.some(r=>!r.path||!/^[a-f0-9]{64}$/.test(r.sha256))||new Set(recipe.resources.map(r=>r.path)).size!==recipe.resources.length||!/^[a-f0-9]{64}$/.test(recipe.executableHash))throw Error('AUXILIARY_RECIPE_INVALID');
   if(recipe.role==='guardian'&&(launch.executable!==identity.target.helper.path||recipe.executableHash!==identity.target.helper.sha256||launch.argv[0]!=='--qualification-observer-v1'))throw Error('GUARDIAN_TARGET_MISMATCH');
  } else if (recipe.kind !== 'endpoint') {
   const i = recipe.request.intent, snapshot = must(this.campaign.snapshot(this.#batch.campaignId)), target = snapshot.target;
   if (i.controllerHash !== snapshot.identity.controllerHash || i.protocolHash !== snapshot.identity.protocolHash) throw Error('CAMPAIGN_IDENTITY_MISMATCH');
   const argv = action.kind === 'strict-negative' ? [...recipe.request.argv, '-c', 'foo="bar"'] : recipe.request.argv;
   if (i.argumentsHash !== digest(JSON.stringify(argv))) throw Error('ARGUMENT_BINDING_MISMATCH');
   if (!adapters&&!validateOnly || i.owner.actionId !== action.id || i.owner.runId !== this.#batch.owner.runId || i.owner.generation !== this.#batch.owner.generation || i.requestId !== this.#batch.id || i.dispatchHash !== action.launchHash || i.dispatchAuthorization.kind !== 'qualification' || i.dispatchAuthorization.probeId !== (action.probeId ?? `auxiliary.${action.kind}`) || fingerprint(i.runtime) !== fingerprint(target.runtime) || i.adapterHash !== target.adapter.sha256 || i.helper.path !== target.helper.path || i.helper.sha256 !== target.helper.sha256 || i.verifierHash !== target.verifier.wrapperHash || i.osCapabilitiesHash !== target.os.sha256 || i.configHash !== target.startupConfigHash || i.model !== target.model || i.effort !== target.effort || i.budget.activeMs > action.maxMs || i.budget.outputBytes > action.maxOutputBytes || i.budget.cleanupMs > cleanup.maxMs) throw Error('RUNTIME_RECIPE_MISMATCH');
   if (recipe.kind === 'session' && action.probeId !== recipe.probeId) throw Error('PROBE_MISMATCH');
   if (recipe.kind === 'fixed' && (recipe.boundary.targetHash !== this.#batch.targetHash || recipe.boundary.role !== i.owner.role || action.probeId !== `${recipe.boundary.role}.${recipe.boundary.role === 'verifier' && recipe.boundary.operation === 'allowed_edit' ? 'allowed_command' : recipe.boundary.operation}` || i.action !== (recipe.boundary.role === 'verifier' ? 'verifier' : 'worker-start'))) throw Error('FIXED_RECIPE_MISMATCH');
   if (recipe.kind === 'metadata' && i.action !== 'metadata') throw Error('METADATA_ONLY_REQUIRED');
  } else {if(recipe.networkPlan)validateFixedNetworkPlan(recipe.networkPlan);const endpoints=['http://localhost:18471/allowed','http://127.0.0.1:18472/denied',...(recipe.networkPlan?[`tcp://${recipe.networkPlan.directTcp.host}:${recipe.networkPlan.directTcp.port}`]:[])];if (!endpoints.includes(recipe.endpoint) || recipe.endpoints?.some(endpoint => !endpoints.includes(endpoint)) || recipe.brokerEndpoint && recipe.brokerEndpoint !== `\\\\.\\pipe\\ouroboros-boundary-${digest(`${recipe.fixtureRoot}\n${this.#batch.targetHash}`).slice(0,24)}` || !recipe.executionId || !recipe.generation || !/^[a-f0-9]{64}$/.test(recipe.boundaryHash)) throw Error('ENDPOINT_RECIPE_INVALID');}
  if(recipe.kind==='endpoint'){const launch=LaunchSpecSchema.parse(recipe.launch);if(launch.runId!==this.#batch.owner.runId||launch.generation!==this.#batch.owner.generation||launch.actionId!==action.id||launch.boundaryHash!==recipe.boundaryHash||launch.authorization.kind!=='qualification'||launch.authorization.requestId!==this.#batch.id||launch.authorization.probeId!=='auxiliary.endpoint')throw Error('ENDPOINT_LAUNCH_MISMATCH');}
  const context:Context={ recipe, action, cleanup, started: this.options.now(), raw: 0, cleanupRaw: 0,streams:new Map(), meters:new Map(),finalized:false,failed:false, unknown: false, cleanupUnknown: false, cleaning: false, primaryDone: false, cleanupDone: false, nextSequence: 1, seen: new Set(), attempted: false, adapters };this.#reserve(context);this.#contexts.set(action.id,context);return context;
 }
 #reserve(c:Context){if(c.recipe.kind==='auxiliary')assertStandaloneProcessBudget(c.started,c.recipe.launch.deadline,c.action.maxMs);else assertIntegralProcessBudget(c.started,c.recipe.kind==='endpoint'?c.recipe.launch.deadline:c.recipe.request.intent.expiresAt,c.action.maxMs);}
 #begin(c: Context) {
  if(this.#cleanupStarted.has(c.cleanup.id))throw Error('CLEANUP_ALREADY_ACTIVE');
  const current = this.#current();
  must(this.campaign.dispatch(this.#batch.id, c.action, { ...current, ...(['endpoint','auxiliary'].includes(c.recipe.kind) ? {} : { phase: this.#phase(c, 'BOOTSTRAP') }) }));
  this.#used.add(c.action.id);
 }
 #unknown(c: Context, cleanup = c.cleaning) {
  if (cleanup ? c.cleanupUnknown : c.unknown) return;
  if (cleanup) c.cleanupUnknown = true; else c.unknown = true;
  this.campaign.unknown(this.#batch.id, cleanup ? c.cleanup.id : c.action.id);
 }
 #capture(c: Context): RawCapture { return {streamBytes:(source,stream,bytes)=>{if(!Number.isSafeInteger(bytes)||bytes<0)throw Error('INVALID_STREAM_METER');const key=source+':'+stream,old=c.streams.get(key);const total=(old?.bytes??0)+bytes;if(!Number.isSafeInteger(total))throw Error('STREAM_METER_OVERFLOW');c.streams.set(key,{source,stream,bytes:total});}, write: bytes => {
  if (!(bytes instanceof Uint8Array)) { this.#unknown(c); throw Error('INVALID_RAW_OUTPUT'); }
  if (c.cleaning) c.cleanupRaw += bytes.byteLength; else c.raw += bytes.byteLength;
  if (c.cleaning ? c.cleanupRaw > c.cleanup.maxOutputBytes || c.cleanupDone : c.raw > c.action.maxOutputBytes || c.primaryDone) { this.#unknown(c); throw Error('RAW_OUTPUT_LIMIT'); }
 },processCompleted:raw=>{
  const meter=structuredClone(raw);
  if(!['root','helper'].includes(meter.kind)||!Number.isSafeInteger(meter.identity?.pid)||meter.identity.pid<=0||!meter.identity.creationIdentity||!Number.isSafeInteger(meter.activeMs)||meter.activeMs<0||c.meters.has(meter.kind)||c.primaryDone){this.#unknown(c,false);throw Error('PROCESS_METER_INVALID');}
  c.meters.set(meter.kind,frozen(meter));
  if([...c.meters.values()].reduce((sum,m)=>sum+m.activeMs,0)>c.action.maxMs){this.#unknown(c,false);throw Error('PROCESS_LIFETIME_LIMIT');}
 } }; }
 #gate(c: Context): EffectGate { return phase => {
  const cleanup = phase === 'CLEANUP';
  if (cleanup !== c.cleaning || (!cleanup && c.unknown) || this.options.now() >= (cleanup ? c.cleanupStarted! + c.cleanup.maxMs : c.started + c.action.maxMs)) throw Error('EFFECT_NOT_AUTHORIZED');
  if (!cleanup) { this.#reserve(c);this.#current(); if (this.options.now() >= this.#batch.expiresAt || !this.campaign.options.authorizeCurrent(this.#batch, frozen(structuredClone(c.action)))) throw Error('EFFECT_NOT_AUTHORIZED'); if (c.adapters) this.#phase(c, phase); }
 }; }
 async #bounded<T>(c: Context, operation: () => Promise<T>, phase?: Phase): Promise<T> {
  const cleanup = c.cleaning, deadline = (cleanup ? c.cleanupStarted! : c.started) + (cleanup ? c.cleanup.maxMs : c.action.maxMs);
  const check = () => { if ((!cleanup && c.unknown) || this.options.now() >= deadline) throw Error('ACTION_DEADLINE'); if (!cleanup) { this.#current(); if (this.options.now() >= this.#batch.expiresAt || !this.campaign.options.authorizeCurrent(this.#batch, frozen(structuredClone(c.action)))) throw Error('APPROVAL_EXPIRED'); if (phase) this.#phase(c, phase); } };
  let timer: ReturnType<typeof setTimeout>|undefined;
  try { check(); const value = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('ACTION_DEADLINE')), Math.max(1, deadline - this.options.now())); })]); check(); return value; }
  catch (error) { this.#unknown(c, cleanup); throw error; }
  finally { if (timer) clearTimeout(timer); }
 }
 #cleanup(c: Context) {
  if (c.cleaning) return;
  // This reservation terminates only the prior action. It never creates a root.
  if(!this.#cleanupStarted.has(c.cleanup.id)){must(this.campaign.dispatch(this.#batch.id, c.cleanup, { fixtureHash: this.#batch.fixtureHash, endpointHash: this.#batch.endpointHash, targetHash: this.#batch.targetHash }));this.#cleanupStarted.set(c.cleanup.id,this.options.now());} c.cleanupStarted = this.#cleanupStarted.get(c.cleanup.id)!; c.cleaning = true;
 }
 #owned(c: Context, raw: OwnershipReceipt) {
  if (c.recipe.kind === 'endpoint'||c.recipe.kind==='auxiliary') throw Error('RUNTIME_REQUIRED');
  const actual = WindowsOwnershipReceiptSchema.parse(raw), intent = c.recipe.request.intent;
  if (actual.pid === actual.helperPid || Object.entries(intent.owner).some(([key, value]) => actual[key as keyof typeof actual] !== value) || actual.boundaryHash !== intent.boundaryHash || actual.capturedAt < intent.issuedAt || actual.capturedAt > this.options.now()) throw Error('OWNERSHIP_MISMATCH');
  c.owned = frozen(structuredClone(actual)); c.attempted = true;
 }
 #dispatch(c: Context): SessionDeps['dispatch'] { return async <T>(descriptor: SessionDispatch, operation: () => Promise<T>) => {
  if (c.recipe.kind === 'endpoint'||c.recipe.kind==='auxiliary') throw Error('RUNTIME_REQUIRED');
  const snapshot = structuredClone(descriptor);
  if (descriptor.owner.actionId !== c.action.id || fingerprint(descriptor.owner) !== fingerprint(c.recipe.request.intent.owner) || descriptor.targetHash !== startupTargetHash(c.recipe.request.intent) || descriptor.sequence !== c.nextSequence++ || c.seen.has(descriptor.dispatchId) || descriptor.limits.activeMs > (descriptor.cleanup ? c.cleanup.maxMs : c.action.maxMs) || descriptor.limits.outputBytes > c.action.maxOutputBytes) throw Error('RPC_ENVELOPE_MISMATCH');
  c.seen.add(descriptor.dispatchId);
  if (descriptor.cleanup) this.#cleanup(c);
  if (c.cleaning && ['launch','initialize','thread-start','turn-start','prepare','cancellation-arm'].includes(descriptor.kind)) throw Error('CLEANUP_CANNOT_LAUNCH');
  const phase: Phase|undefined = c.cleaning ? undefined : descriptor.kind === 'thread-start' ? 'PRE_THREAD' : ['turn-start','cancellation-arm','cancellation-trigger'].includes(descriptor.kind) ? 'TURN' : 'BOOTSTRAP';
  return this.#bounded(c, async () => {
   if (fingerprint(descriptor) !== fingerprint(snapshot)) throw Error('RPC_CHANGED');
   const value = await operation();
   if (descriptor.kind === 'launch') this.#owned(c, value as OwnershipReceipt);
   if (['initialize','thread-start'].includes(descriptor.kind)) c.observationHash = (value as { observationHash: string }).observationHash;
   if(descriptor.kind==='drain')c.terminalDrain=(value as {drain:unknown}).drain;
   if(descriptor.kind==='broker-reconcile')c.terminalBroker=value;
   return value;
  }, phase);
 }; }
 async #publish(c: Context, category: string, body: unknown): Promise<EvidenceRef> {
  const bytes = Buffer.from(JSON.stringify(body));
  if (bytes.byteLength > 65536 || c.raw + bytes.byteLength > c.action.maxOutputBytes) throw Error('SAFE_EVIDENCE_LIMIT');
  c.raw += bytes.byteLength;
  async function* stream() { yield bytes; }
  const artifact = must(await publishArtifact(this.campaign.store, stream(), { schemaVersion: 1, id: randomUUID(), owner: this.#batch.owner, actionId: c.action.id, mediaType: 'application/json', secrets: [] }));
  if (artifact.truncated || artifact.producerStopRequired) throw Error('EVIDENCE_TRUNCATED');
  return { id: artifact.id, sha256: artifact.sha256, category };
 }
 async #finish(c: Context, status: CampaignRunResult['status'], reason: string, observations: Array<{category: string; body: Record<string, unknown>}> = [], proof: unknown = {}, actualAttempt = c.attempted,startupEvidence:readonly StartupSessionProof[]=[],managedConflicts:NonNullable<SessionResult['managedConflicts']>=[]): Promise<CampaignRunResult> {
  const catalogProbe = c.action.kind === 'probe', evidenceKind = this.#kind(c.action.probeId), evidence: EvidenceRef[] = [];
  let finalStatus: 'PASS'|'FAIL'|'UNTESTED' = status === 'REFUSED' ? 'UNTESTED' : status;
  if (!actualAttempt && finalStatus === 'PASS') finalStatus = 'UNTESTED';
  try {
   if (!c.unknown) {
    const role = REQUIRED_CODEX_WINDOWS_PROBES.find(p => p.id === c.action.probeId)?.role ?? 'controller';
    const operation = { schemaVersion: 2 as const, kind: 'campaign-probe' as const, targetHash: this.#batch.targetHash, probeId: c.action.probeId ?? `auxiliary.${c.action.kind}`, role, launchHash: c.action.launchHash, status: finalStatus, actualAttempt, evidenceKind, proof: safeProof(proof) };
    evidence.push(await this.#publish(c, 'operation', CampaignProbeEvidenceSchema.parse(operation)));
    const startupArtifacts:Array<{proof:StartupSessionProof;ref:EvidenceRef}>=[];
    for(const raw of startupEvidence){
     const startup=StartupSessionProofSchema.parse(raw);
     if(c.recipe.kind==='auxiliary'||c.recipe.kind==='endpoint'||fingerprint(startup.intent)!==fingerprint(c.recipe.request.intent)||startup.intent.owner.actionId!==c.action.id||startup.evidenceKind!==(evidenceKind==='fixture'?'simulation':evidenceKind))throw Error('STARTUP_PROOF_BINDING_MISMATCH');
     const ref=await this.#publish(c,'startup-proof',startup);evidence.push(ref);startupArtifacts.push({proof:startup,ref});
    }
    if(managedConflicts.length>1)throw Error('MANAGED_CONFLICT_DUPLICATE');
    for(const raw of managedConflicts){
     const projection=ManagedPolicyConflictProjectionSchema.parse(raw.projection);
     if(c.recipe.kind==='auxiliary'||c.recipe.kind==='endpoint'||raw.actionId!==c.action.id||projection.intentHash!==fingerprint(c.recipe.request.intent)||startupArtifacts.length!==1)throw Error('MANAGED_CONFLICT_BINDING_MISMATCH');
     const startup=startupArtifacts[0]!;
     if(!startup.proof.initialized||!startup.proof.policy||fingerprint(projection.configuration)!==startup.proof.policy.configurationHash||fingerprint(projection.requirements)!==startup.proof.policy.requirementsHash)throw Error('MANAGED_CONFLICT_POLICY_MISMATCH');
     evidence.push(await this.#publish(c,'managed-conflict',bindManagedPolicyConflictEvidence({targetHash:this.#batch.targetHash,policyEvidence:{id:startup.ref.id,sha256:startup.ref.sha256},projection})));
    }
    for (const category of new Set(observations.filter(e => e.category !== 'operation').map(e => e.category))) evidence.push(await this.#publish(c, category, { schemaVersion: 1, category, proof: safeProof(observations.filter(e => e.category === category).map(e => e.body)) }));
    if(c.meters.size){if(c.meters.size!==2||!c.owned)throw Error('PROCESS_METERS_INCOMPLETE');for(const meter of c.meters.values()){const pid=meter.kind==='root'?c.owned.pid:c.owned.helperPid,creationIdentity=meter.kind==='root'?c.owned.creationIdentity:c.owned.helperCreationIdentity;if(meter.identity.pid!==pid||meter.identity.creationIdentity!==creationIdentity)throw Error('PROCESS_METER_OWNERSHIP_MISMATCH');}}
    if(!c.terminal&&c.owned&&c.terminalDrain&&c.terminalBroker){const broker=c.terminalBroker as {inventoryComplete:boolean;active:string[];unresolved:string[]};c.terminal={kind:'owned-execution',ownership:c.owned,drain:c.terminalDrain,brokerInventory:{inventoryComplete:broker.inventoryComplete,active:broker.active,unresolved:broker.unresolved}} as CampaignResourceTerminal;}
    if(c.terminal&&this.#batch.schemaVersion===3){
     const terminal=validateCampaignTerminal(CampaignTerminalObservationSchema.parse({schemaVersion:1,kind:'campaign-terminal-observation',targetHash:this.#batch.targetHash,batchId:this.#batch.id,actionId:c.action.id,launchHash:c.action.launchHash,resource:c.terminal,processMeters:[...c.meters.values()],primaryOutputBytes:c.raw,cleanupOutputBytes:c.cleanupRaw,rawOutputBytes:c.raw+c.cleanupRaw,streamCounters:[...c.streams.values()],observedAt:this.options.now()}),this.#batch as BatchApproval,c.action);
     evidence.push(await this.#publish(c,'terminal-observation',terminal));
    }else if(this.#batch.schemaVersion===3&&finalStatus==='PASS')throw Error('TERMINAL_OBSERVATION_REQUIRED');
    const processMs=[...c.meters.values()].reduce((sum,m)=>sum+m.activeMs,0);
    must(this.campaign.finish(this.#batch.id, c.action.id, { elapsedMs: Math.max((c.cleanupStarted ?? this.options.now()) - c.started,processMs,c.auxiliaryMs??0), outputBytes: c.raw, status: finalStatus, evidenceKind, evidence })); c.primaryDone = true;
   }
  } catch { this.#unknown(c, false); }
  c.finalized=true;c.failed=finalStatus!=='PASS'||c.unknown;
  const group=[...this.#contexts.values()].filter(member=>member.cleanup.id===c.cleanup.id&&this.#used.has(member.action.id));
  if (c.cleaning && !group.some(member=>member.cleanupUnknown)&&group.every(member=>member.finalized)) {
   const finished = this.campaign.finish(this.#batch.id, c.cleanup.id, { elapsedMs: this.options.now() - c.cleanupStarted!, outputBytes: group.reduce((sum,member)=>sum+member.cleanupRaw,0), status:'PASS', evidenceKind });
   if (!finished.ok) for(const member of group)this.#unknown(member, true); else for(const member of group)member.cleanupDone = true;
  }
  const unknown = c.unknown || c.cleanupUnknown || !c.cleaning;
  if (unknown) this.#unknown(c, false);
  return { status: unknown ? 'FAIL' : finalStatus, reason: unknown ? 'RECONCILIATION_REQUIRED' : reason, unknown, actualAttempt, catalogProbe, evidenceKind, evidence };
 }
 async runSession(recipe: SessionRecipe, adapters: SessionAdapters): Promise<CampaignRunResult> {
  let c: Context; try { c = this.#context(recipe, adapters); this.#begin(c); } catch { return this.#refused('EXACT_CURRENT_RECIPE_REFUSED'); }
  try {
   const seam = adapters.process(this.#capture(c), this.#gate(c));
   const result = await runSessionProbe(c.recipe.kind === 'session' ? c.recipe.probeId : '', (c.recipe as SessionRecipe).request, { now: this.options.now, seam, dispatch: this.#dispatch(c), currentAdmission: adapters.currentAdmission,resolveUnrelated:actionId=>this.ownedUnrelated(actionId), evidenceKind: this.options.evidenceKind === 'fixture' ? 'simulation' : 'live' });
   if (result.reason === 'TERMINAL_RECONCILIATION_REQUIRED') { this.#unknown(c, false); if (c.cleaning) this.#unknown(c, true); }
   return this.#finish(c, result.status, result.reason, result.evidence, { reason: result.reason, evidence: result.evidence }, c.attempted,result.startupEvidence,result.managedConflicts);
  } catch { this.#unknown(c, false); return this.#finish(c, 'FAIL', 'SESSION_FAILED'); }
 }
 async #terminal(c: Context, seam: Pick<SessionProcess, 'fence'|'drain'|'reconcileBrokers'>) {
  this.#cleanup(c); let valid = !!c.owned;
  const matches = (receipt: OwnershipReceipt) => !!c.owned && ownershipHash(receipt) === ownershipHash(c.owned);
  try { const r = await this.#bounded(c, () => seam.fence()); valid = r.fenced && matches(r.ownership) && valid; } catch { valid = false; }
  try { const r = await this.#bounded(c, () => seam.drain()); c.terminalDrain=r.drain;valid = valid && matches(r.ownership) && !!c.owned && isTerminalDrained(r.drain,c.owned,c.action.probeId??''); } catch { valid = false; }
  try { const r = await this.#bounded(c, () => seam.reconcileBrokers());c.terminalBroker=r; valid = valid && matches(r.ownership) && r.inventoryComplete && !r.active.length && !r.unresolved.length; } catch { valid = false; }
  if (!valid) { this.#unknown(c, false); this.#unknown(c, true); }
 }
 async runMetadata(recipe: MetadataRecipe, adapters: SessionAdapters): Promise<CampaignRunResult> {
  let c: Context; try { c = this.#context(recipe, adapters); this.#begin(c); } catch { return this.#refused('EXACT_CURRENT_RECIPE_REFUSED'); }
  try {
   const seam=adapters.process(this.#capture(c),this.#gate(c));
   const result=await runTerminalMetadata((c.recipe as MetadataRecipe).request,{now:this.options.now,seam,dispatch:this.#dispatch(c),currentAdmission:adapters.currentAdmission,evidenceKind:this.options.evidenceKind==='fixture'?'simulation':'live'});
   if(result.reason==='TERMINAL_RECONCILIATION_REQUIRED'){this.#unknown(c,false);if(c.cleaning)this.#unknown(c,true);}
   return this.#finish(c,result.status,result.reason,result.evidence,{terminal:true},c.attempted,result.startupEvidence,result.managedConflicts);
  }catch{this.#unknown(c,false);return this.#finish(c,'FAIL','METADATA_FAILED');}
 }
 /** The unrelated same-name process is separately approved and charged. Its
  * metadata authority is terminal and never becomes a worker session ticket. */
 ownedUnrelated(actionId:string):{actionId:string;pid:number;creationIdentity:string;name:string}|undefined{
  const entry=this.#unrelated.get(actionId);if(!entry||entry.context.cleaning||entry.context.unknown||entry.context.finalized)return undefined;
  try{this.#gate(entry.context)('BOOTSTRAP');return frozen(structuredClone(entry.identity));}catch{return undefined;}
 }
 /** This is an inventory of this live controller's registered services. It
  * makes no claim about arbitrary host brokers or provider-wide inventories. */
 ownedBrokerRegistry(intent:Readonly<StartupIntent>):{schemaVersion:1;scope:'campaign-owned-controlled-services';source:'campaign-owned-resource-registry';owner:StartupIntent['owner'];targetHash:string;controlHash:string;registeredActionIds:string[]}|undefined{
  const c=this.#contexts.get(intent.owner.actionId);if(!c||!this.#used.has(c.action.id)||!c.owned||c.finalized||c.recipe.kind==='endpoint'||c.recipe.kind==='auxiliary'||fingerprint(c.recipe.request.intent)!==fingerprint(intent))return undefined;
  const registeredActionIds=[...new Set([...this.#services.values()].map(service=>service.resource.ownership.actionId))].sort();
  return frozen({schemaVersion:1,scope:'campaign-owned-controlled-services',source:'campaign-owned-resource-registry',owner:structuredClone(intent.owner),targetHash:startupTargetHash(intent),controlHash:intent.controlHash,registeredActionIds});
 }
 async withUnrelated<T>(recipe:MetadataRecipe,adapters:SessionAdapters,nested:(identity:Readonly<{actionId:string;pid:number;creationIdentity:string;name:string}>)=>Promise<T>):Promise<CampaignRunResult&{nested?:T}>{
  let c:Context;try{c=this.#context(recipe,adapters);this.#begin(c);}catch{return this.#refused('EXACT_CURRENT_RECIPE_REFUSED');}
  const r=c.recipe as MetadataRecipe,seam=adapters.process(this.#capture(c),this.#gate(c));let status:'PASS'|'FAIL'='FAIL',value:T|undefined;
  try{
   this.#owned(c,await this.#bounded(c,()=>seam.launch({intent:r.request.intent,argv:r.request.argv,strictNegative:false}),'BOOTSTRAP'));
   const initialized=await this.#bounded(c,()=>seam.initialize(),'BOOTSTRAP');c.observationHash=initialized.observationHash;
   if(initialized.account!=='chatgpt'||initialized.provider!=='openai'||initialized.model!==r.request.intent.model||initialized.effort!==r.request.intent.effort)throw Error('METADATA_MISMATCH');
   const identity=frozen({actionId:c.action.id,pid:c.owned!.pid,creationIdentity:c.owned!.creationIdentity,name:win32.basename(r.request.intent.runtime.path)});
   this.#unrelated.set(c.action.id,{context:c,identity});value=await this.#bounded(c,()=>nested(identity),'BOOTSTRAP');status='PASS';
  }catch{this.#unknown(c,false);}finally{this.#unrelated.delete(c.action.id);await this.#terminal(c,seam);}
  return {...await this.#finish(c,status,'TERMINAL_UNRELATED_METADATA',[],{terminal:true,sameName:win32.basename(r.request.intent.runtime.path)}),...(value===undefined?{}:{nested:value})};
 }
 async runFixed(recipe: FixedRecipe, adapters: FixedAdapters): Promise<CampaignRunResult> {
  const network = ['allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback'].includes(recipe.boundary.operation);
  const broker = recipe.boundary.operation === 'broker_escape';
  const endpoint = broker ? `\\\\.\\pipe\\ouroboros-boundary-${digest(`${recipe.boundary.fixtureRoot}\n${this.#batch.targetHash}`).slice(0,24)}` : recipe.boundary.operation === 'allowed_proxy_network' ? 'http://localhost:18471/allowed' :recipe.boundary.operation==='denied_direct_tcp'&&recipe.boundary.networkPlan?`tcp://${recipe.boundary.networkPlan.directTcp.host}:${recipe.boundary.networkPlan.directTcp.port}`: 'http://127.0.0.1:18472/denied';
  let c: Context; try { c = this.#context(recipe, adapters); if ((network || broker) && !this.#services.has(endpoint) || adapters.mode === 'verifier-channel' && (recipe.boundary.role !== 'verifier' || !recipe.channel || recipe.channel.resourceHash !== must(this.campaign.snapshot(this.#batch.campaignId)).identity.driverHash)) throw Error('OWNED_RESOURCE_REQUIRED'); this.#begin(c); } catch { return this.#refused('EXACT_CURRENT_RECIPE_REFUSED'); }
  const r = c.recipe as FixedRecipe, seam = adapters.process(this.#capture(c), this.#gate(c)); let result: Awaited<ReturnType<typeof runFixedBoundaryDriver>>|undefined;
  try {
   this.#owned(c, await this.#bounded(c, () => seam.launch({ intent: r.request.intent, argv: r.request.argv, strictNegative: false }), 'BOOTSTRAP'));
   // The launched root must be neutral; the protected fixed command is sent only
   // after its actual ownership and initialized observation have been admitted.
   const initialized = await this.#bounded<Awaited<ReturnType<FixedRootProcess['initialize']>>>(c, () => seam.initialize(), 'BOOTSTRAP');
   if (adapters.mode === 'verifier-channel') {
    if (!('kind' in initialized) || initialized.kind !== 'fixed-resource-ready' || initialized.resourceHash !== r.channel!.resourceHash || initialized.executionId !== c.owned!.actionId || !/^[a-f0-9]{64}$/.test(initialized.observationHash)) throw Error('FIXED_RESOURCE_NOT_READY');
    c.observationHash = fingerprint({ initialized, ownershipHash: ownershipHash(c.owned!), targetHash: this.#batch.targetHash });
   } else {
    if ('kind' in initialized || initialized.account !== 'chatgpt' || initialized.provider !== 'openai' || initialized.model !== r.request.intent.model || initialized.effort !== r.request.intent.effort) throw Error('FIXED_OWNED_BINDING_MISMATCH');
    c.observationHash = initialized.observationHash;
   }
   if (r.boundary.executionId !== c.owned!.actionId) throw Error('FIXED_OWNED_BINDING_MISMATCH');
   if (r.boundary.role === 'worker') { if (!seam.startThread) throw Error('WORKER_CHANNEL_REQUIRED'); const thread = await this.#bounded(c, () => seam.startThread!({ workspace: r.request.intent.workspace, authMode: 'managed-chatgpt' }), 'PRE_THREAD'); c.observationHash = thread.observationHash; if (!thread.threadId || thread.account !== 'chatgpt' || thread.provider !== 'openai' || thread.model !== r.request.intent.model || thread.effort !== r.request.intent.effort) throw Error('THREAD_MISMATCH'); }
   const phase = r.boundary.role === 'verifier' ? 'VERIFIER' : 'TURN', raw = adapters.io(this.#capture(c), frozen(structuredClone(c.owned!)), this.#gate(c));
   const wrap = <T, I>(fn: (input: I) => Promise<T>) => async (input: I): Promise<T> => this.#bounded(c, () => fn(input), phase);
   const observe = (observer: NonNullable<NonNullable<FixedDriverIO['controller']>['observeEndpoint']>) => wrap(async (input: Parameters<typeof observer>[0]) => {
    const service = this.#services.get(input.endpoint); if (!service || service.context.unknown || service.context.cleaning || service.recipe.fixtureRoot !== input.fixtureRoot) throw Error('CHARGED_ENDPOINT_UNAVAILABLE');
    const observed = await observer(input); if (observed.executionId !== service.resource.executionId || observed.serviceGeneration !== service.resource.generation) throw Error('ENDPOINT_GENERATION_MISMATCH'); return observed;
   });
   const io: FixedDriverIO = { filesystem: { read: wrap(raw.filesystem.read), write: wrap(raw.filesystem.write), linkAndWrite: wrap(raw.filesystem.linkAndWrite) }, network: { proxyHttp: wrap(raw.network.proxyHttp), directTcp: wrap(raw.network.directTcp), loopback: wrap(raw.network.loopback) }, broker: { writeThroughBroker: wrap(raw.broker.writeThroughBroker) }, ...(raw.controller ? { controller: { now: raw.controller.now, ...(raw.controller.observeEndpoint ? { observeEndpoint: observe(raw.controller.observeEndpoint) } : {}), ...(raw.controller.observeBroker ? { observeBroker: observe(raw.controller.observeBroker) } : {}), ...(raw.controller.snapshotSentinel ? { snapshotSentinel: wrap(raw.controller.snapshotSentinel) } : {}) } } : {}) };
   result = await runFixedBoundaryDriver(r.boundary, io);
  } catch { this.#unknown(c, false); } finally { await this.#terminal(c, seam); }
  return this.#finish(c, result?.status ?? 'FAIL', result?.reasonCode ?? 'FIXED_FAILED', result?.availability ? [{ category: 'network', body: { before: result.availabilityBefore, after: result.availability } }] : [], result ?? {}, result?.actualAttempt ?? false);
 }
 async runStrictPair(recipes: { positive: StrictRecipe; negative: StrictRecipe }, adapters: { positive: SessionAdapters; negative: SessionAdapters }): Promise<CampaignRunResult> {
  let positive: Context, negative: Context;
  try { positive = this.#context(recipes.positive, adapters.positive); negative = this.#context(recipes.negative, adapters.negative); if (positive.action.kind !== 'strict-positive' || negative.action.kind !== 'strict-negative') throw Error('STRICT_ORDER'); this.#begin(positive); } catch { return this.#refused('EXACT_CURRENT_RECIPE_REFUSED'); }
  let negativeStarted = false;
  const dispatch: SessionDeps['dispatch'] = async (descriptor, operation) => { const c = descriptor.owner.actionId === positive.action.id ? positive : descriptor.owner.actionId === negative.action.id ? negative : undefined; if (!c) throw Error('STRICT_OWNER_MISMATCH'); if (c === negative && !negativeStarted) { negative.started = this.options.now(); this.#begin(negative); negativeStarted = true; } return this.#dispatch(c)(descriptor, operation); };
  const currentAdmission: NonNullable<SessionDeps['currentAdmission']> = (phase, intent, owned, observation) => (intent.owner.actionId === positive.action.id ? adapters.positive : adapters.negative).currentAdmission(phase, intent, owned, observation);
  let result: SessionResult;
  try { result = await runStrictPair({ positive: (positive.recipe as StrictRecipe).request, negative: (negative.recipe as StrictRecipe).request }, { now: this.options.now, dispatch, seam: adapters.positive.process(this.#capture(positive), this.#gate(positive)), negativeSeam: adapters.negative.process(this.#capture(negative), this.#gate(negative)), currentAdmission, evidenceKind: this.options.evidenceKind === 'fixture' ? 'simulation' : 'live' }); }
  catch { this.#unknown(positive, false); result = { status: 'FAIL', reason: 'STRICT_FAILED', evidenceKind: 'simulation', catalogProbe: false, evidence: [] }; }
  const first = await this.#finish(positive, result.status, result.reason, [], { strictPair: result.reason },positive.attempted,result.startupEvidence?.filter(proof=>proof.intent.owner.actionId===positive.action.id),result.managedConflicts?.filter(proof=>proof.actionId===positive.action.id));
  if (!negativeStarted) return first;
  const second = await this.#finish(negative, result.status, result.reason, [], { strictPair: result.reason },negative.attempted,result.startupEvidence?.filter(proof=>proof.intent.owner.actionId===negative.action.id),result.managedConflicts?.filter(proof=>proof.actionId===negative.action.id));
  return { ...second, status: first.status === 'PASS' ? second.status : first.status, unknown: first.unknown || second.unknown, evidence: [...first.evidence, ...second.evidence] };
 }
 async withAuxiliary<T>(recipe:AuxiliaryRecipe,adapters:AuxiliaryAdapters,nested:(resource:Readonly<AuxiliaryResource>)=>Promise<T>):Promise<CampaignRunResult&{nested?:T}>{
  let c:Context;try{c=this.#context(recipe);this.#begin(c);}catch{return this.#refused('EXACT_CURRENT_RECIPE_REFUSED');}
  const r=c.recipe as AuxiliaryRecipe;
  const bind=(raw:AuxiliaryResource)=>{const resource=frozen(structuredClone(raw));if(fingerprint(resource.owner)!==fingerprint({runId:r.launch.runId,generation:r.launch.generation,actionId:r.launch.actionId,role:r.launch.role})||resource.launchHash!==c.action.launchHash||!Number.isSafeInteger(resource.identity.pid)||resource.identity.pid<=0||!resource.identity.creationIdentity||!Number.isSafeInteger(resource.createdAt)||resource.createdAt<c.started||resource.createdAt>this.options.now())throw Error('AUXILIARY_OWNERSHIP_MISMATCH');return resource;};
  let resource:Readonly<AuxiliaryResource>|undefined,value:T|undefined,status:'PASS'|'FAIL'='FAIL';
  try{resource=bind(await this.#bounded(c,()=>adapters.start(this.#capture(c),()=>this.#gate(c)('BOOTSTRAP'))));c.attempted=true;value=await this.#bounded(c,()=>nested(resource!));status='PASS';}
  catch{this.#unknown(c,false);if(!resource&&adapters.recoverOwned)try{const recovered=adapters.recoverOwned();if(recovered){resource=bind(recovered);c.attempted=true;}}catch{/* No unknown PID is ever terminated. */}}
  finally{this.#cleanup(c);if(resource)try{const stopped=await this.#bounded(c,()=>adapters.stop(resource!,this.#capture(c),()=>this.#gate(c)('CLEANUP')));if(fingerprint({owner:stopped.owner,identity:stopped.identity,launchHash:stopped.launchHash,createdAt:stopped.createdAt})!==fingerprint(resource)||!stopped.exited||stopped.exitCode===null||!Number.isSafeInteger(stopped.exitCode)||!stopped.outputComplete||!Number.isSafeInteger(stopped.completedAt)||stopped.completedAt<resource.createdAt||stopped.completedAt>this.options.now())throw Error('AUXILIARY_EXIT_UNPROVEN');c.auxiliaryMs=stopped.completedAt-resource.createdAt;c.terminal={kind:'auxiliary-exit',owner:stopped.owner,identity:stopped.identity,createdAt:stopped.createdAt,completedAt:stopped.completedAt,activeMs:c.auxiliaryMs,exitCode:stopped.exitCode,outputComplete:true};}catch{this.#unknown(c,true);}else this.#unknown(c,true);}
  return {...await this.#finish(c,status,'AUXILIARY_LIFETIME',[],{resource,terminated:!c.cleanupUnknown}),...(value===undefined?{}:{nested:value})};
 }
 async withObservation<T>(recipes:{guardian:AuxiliaryRecipe;controller:AuxiliaryRecipe;primary:SessionRecipe|StrictRecipe},adapters:ObservationAdapters,nested:(resources:Readonly<ObservationResources>)=>Promise<T>):Promise<CampaignRunResult&{nested?:T}>{
  let guardian:Context,controller:Context;
  try{if(recipes.guardian.role!=='guardian'||recipes.controller.role!=='controller'||!/^[a-f0-9]{64}$/.test(recipes.guardian.bindingHash??'')||recipes.guardian.bindingHash!==recipes.controller.bindingHash||!recipes.primary||adapters.primaryIntentHash!==fingerprint(recipes.primary.request.intent))throw Error('OBSERVATION_BINDING_REQUIRED');const primary=this.#context(recipes.primary,undefined,true);guardian=this.#context(recipes.guardian);controller=this.#context(recipes.controller);if(guardian.action.auxiliaryFor!==primary.action.id||controller.action.auxiliaryFor!==primary.action.id)throw Error('OBSERVATION_PRIMARY_MISMATCH');}
  catch{return this.#refused('EXACT_CURRENT_RECIPE_REFUSED');}
  const contexts={guardian,controller};
  const captures={guardian:this.#capture(guardian),controller:this.#capture(controller)};
  const gates={guardian:()=>this.#gate(guardian)(guardian.cleaning?'CLEANUP':'BOOTSTRAP'),controller:()=>this.#gate(controller)(controller.cleaning?'CLEANUP':'BOOTSTRAP')};
  const bind=(raw:ObservationResources):Readonly<ObservationResources>=>{const resources=frozen(structuredClone(raw));for(const kind of ['guardian','controller'] as const){const c=contexts[kind],r=c.recipe as AuxiliaryRecipe,value=resources[kind];if(!value||fingerprint(value.owner)!==fingerprint({runId:r.launch.runId,generation:r.launch.generation,actionId:r.launch.actionId,role:r.launch.role})||value.launchHash!==c.action.launchHash||!Number.isSafeInteger(value.identity.pid)||value.identity.pid<=0||!value.identity.creationIdentity||!Number.isSafeInteger(value.createdAt)||value.createdAt<c.started||value.createdAt>this.options.now())throw Error('OBSERVATION_OWNERSHIP_MISMATCH');}if(resources.guardian.identity.pid===resources.controller.identity.pid)throw Error('OBSERVATION_TOPOLOGY_COLLAPSED');return resources;};
  let resources:Readonly<ObservationResources>|undefined,value:T|undefined,status:'PASS'|'FAIL'='FAIL';
  try{
   // Both immutable envelopes and their cleanup are durable before the guardian
   // creates either independently owned process. A partial CAS remains fenced.
   this.#begin(guardian);this.#begin(controller);
   resources=bind(await this.#bounded(guardian,()=>this.#bounded(controller,()=>adapters.start(captures,gates))));guardian.attempted=controller.attempted=true;
   value=await this.#bounded(guardian,()=>this.#bounded(controller,()=>nested(resources!)));status='PASS';
  }catch{for(const c of Object.values(contexts))if(this.#used.has(c.action.id))this.#unknown(c,false);if(!resources&&adapters.recoverOwned)try{const recovered=adapters.recoverOwned();if(recovered?.guardian&&recovered.controller){resources=bind(recovered as ObservationResources);guardian.attempted=controller.attempted=true;}}catch{/* Unknown process identities are not guessed. */}}
  finally{
   for(const c of Object.values(contexts))if(this.#used.has(c.action.id))try{this.#cleanup(c);}catch{this.#unknown(c,true);}
   if(resources&&guardian.cleaning&&controller.cleaning)try{const terminal=await this.#bounded(guardian,()=>this.#bounded(controller,()=>adapters.stop(resources!,captures,gates)));for(const kind of ['guardian','controller'] as const){const c=contexts[kind],before=resources[kind],after=terminal[kind];if(fingerprint({owner:after.owner,identity:after.identity,launchHash:after.launchHash,createdAt:after.createdAt})!==fingerprint(before)||!after.exited||!after.outputComplete||after.exitCode===null||!Number.isSafeInteger(after.exitCode)||!Number.isSafeInteger(after.completedAt)||after.completedAt<before.createdAt||after.completedAt>this.options.now()||after.activeMs!==undefined&&(!Number.isSafeInteger(after.activeMs)||after.activeMs<0))throw Error('OBSERVATION_EXIT_UNPROVEN');c.auxiliaryMs=Math.max(after.completedAt-before.createdAt,after.activeMs??0);c.terminal={kind:'auxiliary-exit',owner:after.owner,identity:after.identity,createdAt:after.createdAt,completedAt:after.completedAt,activeMs:c.auxiliaryMs,exitCode:after.exitCode,outputComplete:true};}}catch{this.#unknown(guardian,true);this.#unknown(controller,true);}else for(const c of Object.values(contexts))if(this.#used.has(c.action.id))this.#unknown(c,true);
  }
  const results:CampaignRunResult[]=[];for(const c of Object.values(contexts))if(this.#used.has(c.action.id))results.push(await this.#finish(c,status,'OBSERVATION_TOPOLOGY',[],{resource:resources?.[(c.recipe as AuxiliaryRecipe).role]}));
  const unknown=results.some(result=>result.unknown),failed=results.some(result=>result.status!=='PASS');return {...(results.at(-1)??this.#refused('EXACT_CURRENT_RECIPE_REFUSED')),status:failed?'FAIL':'PASS',unknown,evidence:results.flatMap(result=>result.evidence),...(value===undefined?{}:{nested:value})};
 }
 async withEndpoint<T>(recipe: EndpointRecipe, adapters: EndpointAdapters, nested: (resource: Readonly<EndpointResource>) => Promise<T>): Promise<CampaignRunResult & { nested?: T }> {
  let c: Context; try { if(fingerprint(LaunchSpecSchema.parse(adapters.launch))!==fingerprint(LaunchSpecSchema.parse(recipe.launch)))throw Error('ENDPOINT_ACTUAL_LAUNCH_CHANGED');c = this.#context(recipe); if ([recipe.endpoint, ...recipe.endpoints ?? [], ...recipe.brokerEndpoint ? [recipe.brokerEndpoint] : []].some(endpoint => this.#services.has(endpoint))) throw Error('ENDPOINT_ALREADY_OWNED'); this.#begin(c); } catch { return this.#refused('EXACT_CURRENT_RECIPE_REFUSED'); }
  const r = c.recipe as EndpointRecipe;
  const identifiers = [...new Set([r.endpoint, ...r.endpoints ?? [], ...r.brokerEndpoint ? [r.brokerEndpoint] : []])];
  const bind=(raw:EndpointResource)=>{const started=frozen(structuredClone(raw)),owned=WindowsOwnershipReceiptSchema.parse(started.ownership);if(started.executionId!==r.executionId||started.generation!==r.generation||owned.runId!==this.#batch.owner.runId||owned.generation!==this.#batch.owner.generation||owned.actionId!==c.action.id||owned.role!==r.launch.role||owned.boundaryHash!==r.boundaryHash||owned.capturedAt<this.#batch.approvedAt||owned.capturedAt>this.options.now())throw Error('ENDPOINT_OWNERSHIP_MISMATCH');c.owned=owned;return started;};
  let resource: EndpointResource|undefined, value: T|undefined, status: 'PASS'|'FAIL' = 'FAIL';
  try { resource=bind(await this.#bounded(c, () => adapters.start(this.#capture(c), () => this.#gate(c)('BOOTSTRAP')))); c.attempted = true; for (const identifier of identifiers) this.#services.set(identifier, { recipe: r, resource, context: c }); value = await this.#bounded(c, () => nested(resource!)); status = 'PASS'; }
  catch { this.#unknown(c, false); if(!resource&&adapters.recoverOwned)try{const recovered=adapters.recoverOwned();if(recovered){resource=bind(recovered);c.attempted=true;}}catch{/* Missing ownership stays fenced. */} }
  finally { for (const identifier of identifiers) this.#services.delete(identifier); this.#cleanup(c); if (resource) { try { const stopped = await this.#bounded(c, () => adapters.stop(resource!, this.#capture(c), () => this.#gate(c)('CLEANUP'))); const drain = WindowsDrainEvidenceSchema.parse(stopped.drain); if (stopped.executionId !== resource.executionId || stopped.generation !== resource.generation || ownershipHash(stopped.ownership) !== ownershipHash(resource.ownership) || !stopped.terminated || !stopped.outputComplete || drain.runId !== this.#batch.owner.runId || drain.actionId !== c.action.id || drain.generation !== this.#batch.owner.generation || drain.role !== resource.ownership.role || !drain.rootExited || !drain.membershipEmpty || !drain.outputComplete || drain.unresolvedExecutions.length || drain.unresolvedOutputStreams.length) throw Error('ENDPOINT_DRAIN_UNPROVEN');c.terminal={kind:'endpoint',ownership:resource.ownership as Extract<OwnershipReceipt,{environment:'windows'}>,drain,terminated:true,outputComplete:true}; } catch { this.#unknown(c, true); } } else this.#unknown(c, true); }
  return { ...await this.#finish(c, status, 'ENDPOINT_LIFETIME', [], { resource, terminated: status === 'PASS' }), ...(value === undefined ? {} : { nested: value }) };
 }
}
