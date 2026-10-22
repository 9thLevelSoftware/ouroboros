import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BytesSchema, HashSchema, IdSchema, PositiveLimitSchema } from '../contracts/common.ts';
import { WindowsDrainEvidenceSchema, WindowsOwnershipReceiptSchema } from '../contracts/execution.ts';
import { QualificationTerminalSchema } from '../contracts/qualification-observation.ts';
import type { RunStore, QualificationEnvelope } from '../store/database.ts';
import type { QualificationTarget } from './ledger.ts';
import { StartupIntentSchema, STARTUP_SOURCES, startupTargetHash } from './codex-startup-authority.ts';
import { fingerprint } from './probes.ts';
import { checkControls, projectConfig, projectRequirements } from '../providers/codex/policy.ts';

export const STARTUP_RULE_VERSION = 'startup-closure-v1' as const;
export const STARTUP_BLOCKER_IDS = ['PLUGIN_STARTUP_UNPROVEN', 'BROWSER_COMPUTER_STARTUP_UNPROVEN', 'MCP_INVENTORY_UNPROVEN', 'MANAGED_REQUIREMENTS_UNVERIFIED', 'STRICT_CONFIG_RUNTIME_UNVERIFIED'] as const;
export const STARTUP_SUPPORTING_IDS = ['remote-control', 'hooks-notify', 'apps-web', 'environment'] as const;
export const STARTUP_MONITOR_PATHS = ['plugins','plugin-contributions','browser-native','browser-cdp','computer','mcp-ordinary','mcp-managed-cloud','mcp-plugin','remote-control','hooks','legacy-notify','apps','web'] as const;
const paths=STARTUP_MONITOR_PATHS;
const ref = z.strictObject({ id: IdSchema, sha256: HashSchema });
export type StartupArtifactRef = z.infer<typeof ref>;
export const StartupPolicyObservationSchema = z.strictObject({ configurationHash: HashSchema, requirementsHash: HashSchema,
 permissionsHash: HashSchema, environmentHash: HashSchema, shellEnvironmentPolicyHash: HashSchema, account: z.literal('chatgpt'), provider: z.literal('openai'), observedAt: PositiveLimitSchema });
export type StartupPolicyObservation = z.infer<typeof StartupPolicyObservationSchema>;
export const StartupMonitorObservationSchema = z.strictObject({ path: z.enum(paths), armedAt: PositiveLimitSchema, observedThrough: PositiveLimitSchema, activationCount: BytesSchema,
 registrationHash: HashSchema.optional(), monitorHash: HashSchema.optional(), baselineHash: HashSchema.optional(), finalHash: HashSchema.optional(),
 registrationEvidence: ref.optional() });
export type StartupMonitorObservation = z.infer<typeof StartupMonitorObservationSchema>;
/** Only controller-owned identities, fixed classifications, digests and counts.
 * Process output and config scalar values never belong in this artifact. */
export const StartupSessionProofSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('startup-session-proof'),
 evidenceKind: z.enum(['live','simulation','fault_injection']), intent: StartupIntentSchema,
 status: z.enum(['PASS','FAIL','REFUSED']), initialized: z.boolean(), threadStarted: z.boolean(),
 ownership: WindowsOwnershipReceiptSchema, drain: z.union([WindowsDrainEvidenceSchema, QualificationTerminalSchema]),
 dispatches: z.array(z.strictObject({ dispatchId: HashSchema, sequence: PositiveLimitSchema, kind: z.enum(['prepare','launch','initialize','thread-start','turn-start','inactivity-observe','protected-snapshot','edit-read','cancellation-arm','cancellation-trigger','strict-outcome','fence','drain','broker-reconcile','heartbeat-observe','checkpoint']), launchHash: HashSchema })).max(64),
 policy: StartupPolicyObservationSchema.optional(), monitors: z.array(StartupMonitorObservationSchema).max(13).optional(),
 sourceCoverage:z.strictObject({sha256:HashSchema,paths:z.array(z.enum(paths)).max(13).refine(values=>new Set(values).size===values.length)}).optional(),
 strict: z.strictObject({ phase: z.enum(['positive','negative']), baselineHash: HashSchema, classification: z.enum(['initialized','unknown-field-foo']), exitCode: z.number().int().nonnegative(), rpcCount: BytesSchema,
  termination: z.enum(['natural','forced','unknown']) }).optional(),
 broker: z.strictObject({ inventoryScope: z.literal('campaign-owned-controlled-services'), registryHash: HashSchema, activeCount: BytesSchema, unresolvedCount: BytesSchema }).optional(),
 policyConflict: z.strictObject({ classification: z.literal('managed-requirements-conflict'), requirementsHash: HashSchema, permissionsHash: HashSchema, exitCode: PositiveLimitSchema, termination: z.literal('natural') }).optional(),
});
export type StartupSessionProof = z.infer<typeof StartupSessionProofSchema>;
const state = z.enum(['disabled','enabled','unknown']);
const subscription = z.strictObject({ endpoint: z.enum(['absent','null','packaged-default','rejected']), providerDefinitions: z.boolean() });
const SafeConflictConfigSchema = z.strictObject({ provider: z.enum(['openai','unexpected','unknown']), profile: z.enum(['expected','unexpected','unknown']),
 mxc:z.boolean(), appsDisabled:z.boolean(), hooksDisabled:z.boolean(), webDisabled:z.boolean(), mcpDisabled:z.boolean(), disallowedAuth:z.boolean(), optionalConflict:z.boolean(), notifyDisabled:z.boolean(),
 states:z.strictObject({plugins:state,browser:state,browserExternal:state,browserCdp:state,computer:state,remoteControl:state,apps:state,hooks:state,mcp:state}),
 selectedPermissionsHash:HashSchema.optional(),shellEnvironmentPolicyHash:HashSchema.optional(),sqliteHomeHash:HashSchema.optional(),subscription:subscription.extend({forcedLogin:z.boolean()}).optional() });
const SafeConflictRequirementsSchema=z.strictObject({pluginsDisabled:z.boolean(),browserDisabled:z.boolean(),computerDisabled:z.boolean(),disallowedAuth:z.boolean(),providerSafe:z.boolean(),loginSafe:z.boolean(),approvalSafe:z.boolean(),
 states:z.strictObject({plugins:state,browser:state,browserExternal:state,browserCdp:state,computer:state,browserComputer:state}),subscription:subscription.optional()});
export const StartupLocalScopeSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('current-controller-reviewed-local-stdio-scope'),targetHash:HashSchema,
 controllerHash:HashSchema,protocolHash:HashSchema,fixtureHash:HashSchema,environmentHash:HashSchema,controlHash:HashSchema,intentHash:HashSchema,
 configuration:SafeConflictConfigSchema,
 preparation:z.strictObject({actionId:IdSchema,runId:IdSchema,generation:PositiveLimitSchema,observedAt:PositiveLimitSchema,operation:z.literal('atomic-new-empty-directory'),sqliteHomeHash:HashSchema,initialEntries:z.array(z.never()).length(0)}),
 client:z.strictObject({name:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),transport:z.literal('stdio'),environment:z.literal('local'),threadMode:z.literal('new-only'),reconfiguration:z.literal('none'),remoteStartup:z.literal('resolve-persisted'),dynamicTools:z.literal('none').optional(),selectedCapabilityRoots:z.literal('none').optional(),remoteEnvironments:z.literal('none').optional(),
  allowedMethods:z.array(z.enum(['initialize','initialized','account/read','config/read','configRequirements/read','thread/start','turn/start','turn/interrupt'])).min(5).max(8).refine(values=>new Set(values).size===values.length)}),
});
export type StartupLocalScope=z.infer<typeof StartupLocalScopeSchema>;
const conflictFields={configuration:SafeConflictConfigSchema,requirements:SafeConflictRequirementsSchema,
 outcomes:z.tuple([z.strictObject({case:z.literal('disallow-chatgpt'),code:z.literal('SUBSCRIPTION_SOURCE_UNSAFE')}),z.strictObject({case:z.literal('disallow-approval-policy'),code:z.literal('CAPABILITY_UNAVAILABLE')})])};
export const ManagedPolicyConflictProjectionSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('managed-policy-conflict-projection'),evidenceKind:z.literal('fault_injection'),intentHash:HashSchema,...conflictFields});
export type ManagedPolicyConflictProjection=z.infer<typeof ManagedPolicyConflictProjectionSchema>;
export const ManagedPolicyConflictEvidenceSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('managed-policy-conflict'),evidenceKind:z.literal('fault_injection'),targetHash:HashSchema,
 policyEvidence:ref,intentHash:HashSchema.optional(),...conflictFields});
function conflictProjection(rawConfig:unknown,rawRequirements:unknown){
 const configuration=SafeConflictConfigSchema.parse(projectConfig(rawConfig)),requirements=SafeConflictRequirementsSchema.parse(projectRequirements(rawRequirements));
 if(!checkControls(configuration,requirements,'ouroboros_worker').ok)throw Error('COMPATIBLE_BASELINE_REQUIRED');
 const login=checkControls(configuration,{...requirements,loginSafe:false},'ouroboros_worker'),approval=checkControls(configuration,{...requirements,approvalSafe:false},'ouroboros_worker');
 if(login.ok||approval.ok)throw Error('CONFLICT_NOT_REJECTED');
 return {configuration,requirements,outcomes:[{case:'disallow-chatgpt',code:login.error.code},{case:'disallow-approval-policy',code:approval.error.code}]};
}
export function createManagedPolicyConflictProjection(input:{intentHash:string;rawConfig:unknown;rawRequirements:unknown}):ManagedPolicyConflictProjection{
 return ManagedPolicyConflictProjectionSchema.parse({schemaVersion:1,kind:'managed-policy-conflict-projection',evidenceKind:'fault_injection',intentHash:input.intentHash,...conflictProjection(input.rawConfig,input.rawRequirements)});
}
export function bindManagedPolicyConflictEvidence(input:{targetHash:string;policyEvidence:StartupArtifactRef;projection:ManagedPolicyConflictProjection}){
 const projection=ManagedPolicyConflictProjectionSchema.parse(input.projection),{kind:_kind,...fields}=projection;
 return ManagedPolicyConflictEvidenceSchema.parse({...fields,kind:'managed-policy-conflict',targetHash:input.targetHash,policyEvidence:input.policyEvidence});
}
/** Pure production diagnostic: exercise the same admission consumer against
 * two explicit incompatible requirement projections. No organization mutation,
 * process launch or synthetic LIVE claim occurs. */
export function createManagedPolicyConflictEvidence(input:{targetHash:string;policyEvidence:StartupArtifactRef;rawConfig:unknown;rawRequirements:unknown}) {
 return ManagedPolicyConflictEvidenceSchema.parse({schemaVersion:1,kind:'managed-policy-conflict',evidenceKind:'fault_injection',targetHash:input.targetHash,policyEvidence:input.policyEvidence,...conflictProjection(input.rawConfig,input.rawRequirements)});
}
const source = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().regex(/^[A-Za-z0-9_./-]{1,256}$/), blobHash: HashSchema, artifact: ref,
 consumer: z.string().regex(/^[A-Za-z0-9_:./-]{1,256}$/) });
const claim = z.enum([...STARTUP_BLOCKER_IDS, ...STARTUP_SUPPORTING_IDS]);
export const StartupCoverageManifestSchema = z.strictObject({ schemaVersion: z.literal(1), ruleVersion: z.literal(STARTUP_RULE_VERSION), kind: z.literal('startup-coverage'), targetHash: HashSchema,
 scope: z.literal('headless-local-stdio-new-thread'), controllerHash: HashSchema, protocolHash: HashSchema, controlHash: HashSchema, environmentHash: HashSchema, fixtureHash: HashSchema,
 expectedPolicy: StartupPolicyObservationSchema.omit({ observedAt: true }),
 routes: z.array(z.strictObject({ path: z.enum(paths), source: z.enum(STARTUP_SOURCES), lifecycle: z.enum(['bootstrap','thread-start']),
  enforcement: z.enum(['persistent-restriction','registered-canary','inapplicable']), sourceEvidence: z.array(source).min(1).max(16),
  registrationHash: HashSchema.optional(), monitorHash: HashSchema.optional() })).min(1).max(208),
 exclusions: z.array(z.enum(['thread-resume','reload','desktop-client','remote-client'])).max(4),
 managedConflict: ref.optional(), scopeEvidence:ref.optional(), boundaryEvidence: z.array(ref).max(32),
 sourceCatalog:z.array(source).max(256).optional(),
 requirementsSources: z.array(z.strictObject({ source: z.enum(STARTUP_SOURCES), sourceEvidence: z.array(source).min(1).max(16) })).max(8).optional(),
});
export type StartupCoverageManifest = z.infer<typeof StartupCoverageManifestSchema>;
function targetMatchesIntent(target:QualificationTarget,intent:StartupSessionProof['intent']):boolean{
 return fingerprint(intent.runtime)===fingerprint(target.runtime)&&intent.adapterHash===target.adapter.sha256&&intent.helper.sha256===target.helper.sha256&&intent.helper.path===target.helper.path&&intent.verifierHash===target.verifier.wrapperHash&&intent.osCapabilitiesHash===target.os.sha256&&intent.configHash===target.startupConfigHash&&intent.model===target.model&&intent.effort===target.effort;
}
/** Pure recipe construction from an actual policy observation. Source semantics
 * and byte provenance remain independently checked by preparation and loading. */
export function buildStartupCoverageManifest(input:{target:QualificationTarget;proof:StartupSessionProof;fixtureHash:string;routes:StartupCoverageManifest['routes'];requirementsSources?:StartupCoverageManifest['requirementsSources'];managedConflict?:StartupArtifactRef;scopeEvidence?:StartupArtifactRef;sourceCatalog?:StartupCoverageManifest['sourceCatalog'];boundaryEvidence?:StartupArtifactRef[]}):StartupCoverageManifest{
 const proof=StartupSessionProofSchema.parse(input.proof);
 if(proof.evidenceKind!=='live'||proof.status!=='PASS'||!proof.initialized||!proof.policy||!completeDrain(proof)||!targetMatchesIntent(input.target,proof.intent)||proof.policy.environmentHash!==proof.intent.environmentHash)throw Error('ACTUAL_COMPATIBLE_POLICY_REQUIRED');
 const {observedAt:_at,...expectedPolicy}=proof.policy;
 return StartupCoverageManifestSchema.parse({schemaVersion:1,ruleVersion:STARTUP_RULE_VERSION,kind:'startup-coverage',targetHash:fingerprint(input.target),scope:'headless-local-stdio-new-thread',
 controllerHash:proof.intent.controllerHash,protocolHash:proof.intent.protocolHash,controlHash:proof.intent.controlHash,environmentHash:proof.intent.environmentHash,fixtureHash:input.fixtureHash,expectedPolicy,
 routes:input.routes,requirementsSources:input.requirementsSources,managedConflict:input.managedConflict,scopeEvidence:input.scopeEvidence,sourceCatalog:input.sourceCatalog,boundaryEvidence:input.boundaryEvidence??[],exclusions:['thread-resume','reload','desktop-client','remote-client']});
}
export function validateStartupLocalScope(raw:unknown,proof:StartupSessionProof,targetHash:string,fixtureHash:string):StartupLocalScope{
 const scope=StartupLocalScopeSchema.parse(raw),i=proof.intent,p=scope.preparation;
 const methods=i.action==='metadata'?['initialize','initialized','account/read','config/read','configRequirements/read']:['initialize','initialized','account/read','config/read','configRequirements/read','thread/start','turn/start','turn/interrupt'];
 const client=i.action==='metadata'?`ouroboros-qualification-${i.owner.actionId}`:'ouroboros';
 if(scope.targetHash!==targetHash||scope.fixtureHash!==fixtureHash||scope.controllerHash!==i.controllerHash||scope.protocolHash!==i.protocolHash||scope.environmentHash!==i.environmentHash||scope.controlHash!==i.controlHash||scope.intentHash!==fingerprint(i)||scope.client.name!==client||fingerprint([...scope.client.allowedMethods].sort())!==fingerprint(methods.sort())||p.runId!==i.owner.runId||p.generation!==i.owner.generation||p.observedAt>proof.ownership.capturedAt||!proof.policy||fingerprint(scope.configuration)!==proof.policy.configurationHash||scope.configuration.sqliteHomeHash!==p.sqliteHomeHash)throw Error('LOCAL_SCOPE_BINDING_CHANGED');
 return scope;
}
/** Lists instrumentation exclusions, never CLOSED decisions. Every source and
 * admitted lifecycle must have a source-backed non-registration route. */
export function sourceCoveredStartupPaths(input:StartupCoverageManifest):Array<typeof paths[number]>{
 const manifest=StartupCoverageManifestSchema.parse(input);
 return paths.filter(path=>STARTUP_SOURCES.every(source=>['bootstrap','thread-start'].every(lifecycle=>{
  const routes=manifest.routes.filter(route=>route.path===path&&route.source===source&&route.lifecycle===lifecycle);
  return routes.length===1&&routes[0]!.enforcement!=='registered-canary';
 })));
}
/** Trusted-store preflight for instrumentation selection. This does not admit
 * a process or replace the independent accepted review used for final closure. */
export function validateStartupCoverageForPreparation(store:RunStore,target:QualificationTarget,fixtureHash:string,rawIntent:StartupSessionProof['intent'],input:StartupCoverageManifest):StartupCoverageManifest{
 const intent=StartupIntentSchema.parse(rawIntent),manifest=StartupCoverageManifestSchema.parse(input);
 if(!targetMatchesIntent(target,intent)||manifest.targetHash!==fingerprint(target)||manifest.fixtureHash!==fixtureHash||manifest.controlHash!==intent.controlHash||manifest.controllerHash!==intent.controllerHash||manifest.protocolHash!==intent.protocolHash||manifest.environmentHash!==intent.environmentHash||manifest.expectedPolicy.environmentHash!==intent.environmentHash)throw Error('STARTUP_COVERAGE_BINDING_CHANGED');
 const keys=manifest.routes.map(route=>`${route.path}:${route.source}:${route.lifecycle}`);if(new Set(keys).size!==keys.length)throw Error('CONTRADICTORY_COVERAGE');
 for(const route of [...manifest.routes,...manifest.requirementsSources??[]])for(const source of route.sourceEvidence){const loaded=readArtifact(store,source.artifact,8388608);if(loaded.artifact.sha256!==source.blobHash)throw Error('SOURCE_BLOB_CHANGED');}
 for(const source of manifest.sourceCatalog??[]){const loaded=readArtifact(store,source.artifact,8388608);if(loaded.artifact.sha256!==source.blobHash)throw Error('SOURCE_BLOB_CHANGED');}
 if(manifest.scopeEvidence){const scope=StartupLocalScopeSchema.parse(readJson(store,manifest.scopeEvidence).value);if(scope.targetHash!==manifest.targetHash||scope.fixtureHash!==fixtureHash||scope.controllerHash!==manifest.controllerHash||scope.protocolHash!==manifest.protocolHash||scope.environmentHash!==manifest.environmentHash||scope.controlHash!==manifest.controlHash||fingerprint(scope.configuration)!==manifest.expectedPolicy.configurationHash||scope.configuration.sqliteHomeHash!==scope.preparation.sqliteHomeHash||scope.preparation.runId!==intent.owner.runId||scope.preparation.generation!==intent.owner.generation)throw Error('LOCAL_SCOPE_BINDING_CHANGED');}
 return manifest;
}
export const StartupAcceptanceSchema = z.strictObject({ schemaVersion: z.literal(1), ruleVersion: z.literal(STARTUP_RULE_VERSION), kind: z.literal('startup-independent-review'), targetHash: HashSchema,
 reviewerId: IdSchema, producerId: IdSchema, reviewedAt: PositiveLimitSchema, coverage: ref.optional(), strictSources:z.array(source).min(1).max(16).optional(), observations: z.array(ref).min(1).max(64),
 acceptedClaims: z.array(claim).min(1).max(9), unresolvedClaims: z.array(claim).max(9),
}).refine(value => value.reviewerId !== value.producerId && new Set(value.acceptedClaims).size === value.acceptedClaims.length && !value.acceptedClaims.some(id => value.unresolvedClaims.includes(id)) &&
 (value.coverage!==undefined||value.acceptedClaims.every(id=>id==='STRICT_CONFIG_RUNTIME_UNVERIFIED')&&!!value.strictSources?.length), 'Independent non-conflicting review and claim-specific source evidence required');
export type StartupAcceptance = z.infer<typeof StartupAcceptanceSchema>;
type LoadedReview = { review: StartupAcceptance; manifest?: StartupCoverageManifest; proofs: Array<{ ref: StartupArtifactRef; proof: StartupSessionProof; batch: { fixtureHash: string } }>; refs: StartupArtifactRef[]; managedAccepted:boolean; scope?:StartupLocalScope };
export type AcceptedStartupEvidence = Readonly<{ targetHash: string; issues: readonly string[] }>;
const validated = new WeakMap<AcceptedStartupEvidence, { reviews:readonly LoadedReview[]; store:RunStore; historyHash:string }>();
export type StartupEvidenceOptions = { reviews?: readonly StartupArtifactRef[]; acceptedReviewHashes?: readonly string[] };
type RecordBody = Record<string, unknown>;
const body = (value: unknown): RecordBody => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordBody : {};
const reference = (value: unknown) => { const v = body(value); return ref.parse({ id: v.id, sha256: v.sha256 }); };
const terminalTime = (proof: StartupSessionProof) => 'completedAt' in proof.drain ? proof.drain.completedAt : proof.drain.observedAt;
function completeDrain(proof: StartupSessionProof) {
 const d = proof.drain, o = proof.ownership;
 if (!d.rootExited || !d.outputComplete) return false;
 if ('completedAt' in d) return d.membershipEmpty && d.activeProcesses === 0 && !d.unresolvedExecutions.length && !d.unresolvedOutputStreams.length;
 return d.helperExited && d.controllerExited && d.outerMembershipEmpty === true && d.outerQueryError === null && !d.emergencyTerminated && !d.overflow && !d.readerFailure && !d.processMeterError &&
  d.description.root.pid === o.pid && d.description.root.creationIdentity === o.creationIdentity && d.description.helper.pid === o.helperPid && d.description.helper.creationIdentity === o.helperCreationIdentity && d.description.innerJobIdentity === o.jobIdentity && d.description.boundaryHash === o.boundaryHash && d.rootLifetimeMs !== null && d.helperLifetimeMs !== null;
}
function readArtifact(store: RunStore, input: StartupArtifactRef,maxBytes=262144) {
 const pointer = ref.parse(input), loaded = store.loadArtifact(pointer.id);
 if (!loaded.ok) throw Error('ARTIFACT_MISSING');
 const artifact = loaded.value;
 if (artifact.sha256 !== pointer.sha256 || artifact.truncated || artifact.producerStopRequired || artifact.redactionApplied || artifact.rawBytes !== artifact.storedBytes || artifact.storedBytes > maxBytes) throw Error('ARTIFACT_INCOMPLETE');
 const bytes = readFileSync(join(store.root, 'artifacts', artifact.sha256));
 if (bytes.length !== artifact.storedBytes || createHash('sha256').update(bytes).digest('hex') !== pointer.sha256) throw Error('ARTIFACT_CHANGED');
 return { artifact, bytes };
}
function readJson(store: RunStore, input: StartupArtifactRef,maxBytes=262144) { const loaded = readArtifact(store, input,maxBytes); return { ...loaded, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes)) as unknown }; }
function rowsForAction(rows: QualificationEnvelope[], actionId: string, kind: QualificationEnvelope['kind']) { return rows.filter(row => row.kind === kind && row.actionId === actionId); }
function durableProof(store: RunStore, rows: QualificationEnvelope[], target: QualificationTarget, pointer: StartupArtifactRef) {
 const loaded = readJson(store, pointer), proof = StartupSessionProofSchema.parse(loaded.value), i = proof.intent, targetHash = fingerprint(target), actionId = i.owner.actionId;
 if (proof.evidenceKind !== 'live' || proof.status !== 'PASS' || loaded.artifact.actionId !== actionId || loaded.artifact.runId !== i.owner.runId) throw Error('LIVE_PROOF_REQUIRED');
 const dispatches = rowsForAction(rows, actionId, 'CAMPAIGN_DISPATCH'), results = rowsForAction(rows, actionId, 'CAMPAIGN_RESULT');
 if (dispatches.length !== 1 || results.length !== 1) throw Error('EXACT_DISPATCH_REQUIRED');
 const dispatch = dispatches[0]!, result = results[0]!, p = body(dispatch.payload), action = body(p.action), r = body(result.payload), usage = body(r.usage);
 const approvals = rows.filter(row => row.kind === 'BATCH_APPROVAL' && body(row.payload).id === p.batchId);
 if (approvals.length !== 1) throw Error('EXACT_BATCH_REQUIRED');
 const batch = body(approvals[0]!.payload), owner = body(batch.owner);
 const campaigns=rows.filter(row=>row.kind==='CAMPAIGN'&&row.requestId===dispatch.requestId),identity=body(body(campaigns[0]?.payload).identity);
 const cleanupId = action.cleanupId;
 const cleanup = typeof cleanupId === 'string' ? rowsForAction(rows, cleanupId, 'CAMPAIGN_RESULT') : [];
 const actionRecord = store.loadAction(actionId), recovery = store.reconcileEvidence(i.owner.runId);
 if (campaigns.length!==1||identity.id!==dispatch.requestId||fingerprint(identity.target)!==targetHash||identity.controllerHash!==i.controllerHash||identity.protocolHash!==i.protocolHash||
  dispatch.runId!==i.owner.runId||result.runId!==i.owner.runId||dispatch.generation!==i.owner.generation||result.generation!==i.owner.generation||rows.indexOf(approvals[0]!)>=rows.indexOf(dispatch)||rows.indexOf(dispatch)>=rows.indexOf(result)||
  !Array.isArray(batch.actions)||!batch.actions.some(item=>fingerprint(item)===fingerprint(action))||
  dispatch.targetHash !== targetHash || result.targetHash !== targetHash || batch.targetHash !== targetHash || dispatch.requestId !== result.requestId ||
  p.batchId !== r.batchId || batch.id !== i.requestId || owner.runId !== i.owner.runId || owner.generation !== i.owner.generation ||
  action.id !== actionId || action.launchHash !== i.dispatchHash || usage.status !== 'PASS' || usage.evidenceKind !== 'live' ||
  !Array.isArray(usage.evidence) || !usage.evidence.some(item => body(item).id === pointer.id && body(item).sha256 === pointer.sha256 && body(item).category === 'startup-proof') ||
  !actionRecord.ok || actionRecord.value.kind!=='CAMPAIGN_ACTION'||actionRecord.value.payload.batchId!==i.requestId||actionRecord.value.payload.campaignId!==dispatch.requestId||actionRecord.value.payload.launchHash!==i.dispatchHash||actionRecord.value.generation!==i.owner.generation||actionRecord.value.state !== 'OBSERVED' || actionRecord.value.outcome?.status !== 'SUCCEEDED' || !actionRecord.value.outcome.evidenceIds.includes(pointer.id) ||
  !recovery.ok || !recovery.value.allowsReady || cleanup.length !== 1 || body(body(cleanup[0]!.payload).usage).status !== 'PASS') throw Error('DURABLE_PROOF_BINDING_MISMATCH');
 if (fingerprint(i.runtime) !== fingerprint(target.runtime) || i.adapterHash !== target.adapter.sha256 || i.helper.sha256 !== target.helper.sha256 || i.helper.path !== target.helper.path || i.verifierHash !== target.verifier.wrapperHash || i.osCapabilitiesHash !== target.os.sha256 || i.configHash !== target.startupConfigHash || i.model !== target.model || i.effort !== target.effort || i.action !== 'worker-start' && i.action !== 'metadata') throw Error('PROOF_TARGET_CHANGED');
 const ownership = proof.ownership, drain = proof.drain;
 if (Object.entries(i.owner).some(([key, value]) => body(ownership)[key] !== value || body(drain)[key] !== value) || ownership.boundaryHash !== i.boundaryHash || ownership.capturedAt < i.issuedAt ||
  !completeDrain(proof) || terminalTime(proof) < ownership.capturedAt ||
  new Set(proof.dispatches.map(item => item.dispatchId)).size !== proof.dispatches.length || !proof.dispatches.some(item => item.kind === 'launch') || !proof.dispatches.some(item => item.kind === 'drain')) throw Error('OWNED_DRAIN_REQUIRED');
 // Retain the approved action-to-intent relation, not just a target-sized hash.
 const operation = (usage.evidence as unknown[]).find(item => body(item).category === 'operation');
 if (!operation) throw Error('OPERATION_EVIDENCE_REQUIRED');
 const op = body(readJson(store, reference(operation)).value);
 if (op.targetHash !== targetHash || op.launchHash !== i.dispatchHash || op.actualAttempt !== true || op.status !== 'PASS' || op.evidenceKind !== 'live') throw Error('OPERATION_EVIDENCE_MISMATCH');
 return { ref: pointer, proof, batch: { fixtureHash: HashSchema.parse(batch.fixtureHash) } };
}
/** acceptedReviewHashes is the controller's explicit independent-review trust
 * input. A file hash or reviewer label discovered in the ledger is never trust. */
export function loadStartupEvidence(store: RunStore, target: QualificationTarget, options: StartupEvidenceOptions = {}): AcceptedStartupEvidence {
 const targetHash = fingerprint(target), issues: string[] = [], accepted: LoadedReview[] = [];let historyHash='';
 try {
  const history = store.listQualifications(); if (!history.ok) throw Error('INVALID_LEDGER'); const rows = history.value;historyHash=fingerprint(rows);
  for (const pointer of options.reviews ?? []) {
   try {
    if (!options.acceptedReviewHashes?.includes(pointer.sha256)) throw Error('UNACCEPTED_REVIEW');
    const review = StartupAcceptanceSchema.parse(readJson(store, pointer).value);
    if (review.targetHash !== targetHash) throw Error('REVIEW_TARGET_CHANGED');
    const manifest = review.coverage?StartupCoverageManifestSchema.parse(readJson(store, review.coverage,4194304).value):undefined;
    if (manifest&&(manifest.targetHash !== targetHash || !['thread-resume','reload','desktop-client','remote-client'].every(path => manifest.exclusions.includes(path as typeof manifest.exclusions[number])))) throw Error('SCOPE_UNBOUNDED');
    const refs = [pointer, ...(review.coverage?[review.coverage]:[]), ...review.observations];
    const sources=[...(review.strictSources??[]),...(manifest?[...manifest.routes,...manifest.requirementsSources??[]].flatMap(route=>route.sourceEvidence):[]),...(manifest?.sourceCatalog??[])];
    for (const source of sources) { const loaded = readArtifact(store, source.artifact,8388608); if (loaded.artifact.sha256 !== source.blobHash) throw Error('SOURCE_BLOB_CHANGED'); refs.push(source.artifact); }
    const routeKeys = (manifest?.routes??[]).map(route => `${route.path}:${route.source}:${route.lifecycle}`);
    if (new Set(routeKeys).size !== routeKeys.length) throw Error('CONTRADICTORY_COVERAGE');
    const proofs = review.observations.map(item => durableProof(store, rows, target, item));
    let localScope:StartupLocalScope|undefined;
    if(manifest?.scopeEvidence){const scope=readJson(store,manifest.scopeEvidence);const scoped=proofs.find(item=>fingerprint(item.proof.intent)===body(scope.value).intentHash);if(!scoped||scope.artifact.runId!==scoped.proof.intent.owner.runId)throw Error('LOCAL_SCOPE_PROOF_REQUIRED');localScope=validateStartupLocalScope(scope.value,scoped.proof,targetHash,manifest.fixtureHash);refs.push(manifest.scopeEvidence);}
    if (new Set(proofs.map(item => item.proof.intent.owner.actionId)).size !== proofs.length) throw Error('DUPLICATE_PROOF');
    if (proofs.some(({ proof, batch }) => terminalTime(proof) > review.reviewedAt||manifest&&(proof.intent.controllerHash !== manifest.controllerHash || proof.intent.protocolHash !== manifest.protocolHash || proof.intent.controlHash !== manifest.controlHash || proof.intent.environmentHash !== manifest.environmentHash || batch.fixtureHash !== manifest.fixtureHash))) throw Error('REVIEW_SCOPE_CHANGED');
    // A later unresolved relevant failure invalidates historical acceptance.
    const last = Math.max(...proofs.map(item => rows.indexOf(rowsForAction(rows, item.proof.intent.owner.actionId, 'CAMPAIGN_RESULT')[0]!)));
    if (rows.slice(last + 1).some(row => row.targetHash === targetHash && (row.kind === 'CAMPAIGN_FENCE' || row.kind === 'CAMPAIGN_RESULT' && body(body(row.payload).usage).status !== 'PASS'))) throw Error('LATER_FAILURE_REOPENS');
    for (const { proof } of proofs) for (const monitor of proof.monitors ?? []) if (monitor.registrationEvidence) { const registration = body(readJson(store, monitor.registrationEvidence).value); if (registration.kind !== 'effective-startup-registration' || registration.intentHash !== startupTargetHash(proof.intent) || registration.registrationHash !== monitor.registrationHash || registration.monitorHash !== monitor.monitorHash || registration.path !== monitor.path || registration.controlHash !== proof.intent.controlHash) throw Error('EFFECTIVE_REGISTRATION_UNPROVEN'); refs.push(monitor.registrationEvidence); }
    const managedAccepted=manifest?managed(store,rows,targetHash,manifest,proofs,refs):false;
    accepted.push({ review, manifest, proofs, refs,managedAccepted,scope:localScope });
   } catch (error) { issues.push(error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'INVALID_STARTUP_EVIDENCE'); }
  }
 } catch { issues.push('INVALID_LEDGER'); }
 const value = Object.freeze({ targetHash, issues: Object.freeze(issues) }); validated.set(value, {reviews:accepted,store,historyHash}); return value;
}
function managed(store:RunStore,rows:QualificationEnvelope[],targetHash:string,manifest:StartupCoverageManifest,proofs:LoadedReview['proofs'],refs:StartupArtifactRef[]):boolean{
 if(!manifest.managedConflict||!STARTUP_SOURCES.every(source=>manifest.requirementsSources?.filter(item=>item.source===source).length===1))return false;
 const conflict=ManagedPolicyConflictEvidenceSchema.parse(readJson(store,manifest.managedConflict).value),live=proofs.find(item=>item.ref.id===conflict.policyEvidence.id&&item.ref.sha256===conflict.policyEvidence.sha256);
 if(conflict.targetHash!==targetHash||!live||conflict.intentHash!==undefined&&conflict.intentHash!==fingerprint(live.proof.intent)||!policyMatches(live.proof,manifest)||fingerprint(conflict.configuration)!==live.proof.policy!.configurationHash||fingerprint(conflict.requirements)!==live.proof.policy!.requirementsHash||!checkControls(conflict.configuration,conflict.requirements,'ouroboros_worker').ok)return false;
 for(const outcome of conflict.outcomes){const result=checkControls(conflict.configuration,{...conflict.requirements,...(outcome.case==='disallow-chatgpt'?{loginSafe:false}:{approvalSafe:false})},'ouroboros_worker');if(result.ok||result.error.code!==outcome.code)return false;}
 const required=['worker.allowed_edit','verifier.allowed_command',...(['worker','verifier'] as const).flatMap(role=>['denied_source_write','denied_sensitive_read','denied_network'].map(name=>`${role}.${name}`))],seen=new Set<string>();
 for(const pointer of manifest.boundaryEvidence){
  const loaded=readJson(store,pointer),op=body(loaded.value);if(op.kind!=='campaign-probe'||op.targetHash!==targetHash||op.evidenceKind!=='live'||op.status!=='PASS'||op.actualAttempt!==true||!loaded.artifact.actionId||op.role!==(String(op.probeId).startsWith('verifier.')?'verifier':'worker'))return false;
  const results=rowsForAction(rows,loaded.artifact.actionId,'CAMPAIGN_RESULT'),dispatches=rowsForAction(rows,loaded.artifact.actionId,'CAMPAIGN_DISPATCH');
  if(results.length!==1||dispatches.length!==1||results[0]!.targetHash!==targetHash||dispatches[0]!.targetHash!==targetHash)return false;
  const usage=body(body(results[0]!.payload).usage),action=body(body(dispatches[0]!.payload).action),record=store.loadAction(loaded.artifact.actionId);
  if(usage.status!=='PASS'||usage.evidenceKind!=='live'||action.launchHash!==op.launchHash||action.probeId!==op.probeId||!record.ok||record.value.state!=='OBSERVED'||record.value.outcome?.status!=='SUCCEEDED'||!record.value.outcome.evidenceIds.includes(pointer.id)||!Array.isArray(usage.evidence)||!usage.evidence.some(item=>body(item).id===pointer.id&&body(item).sha256===pointer.sha256))return false;
  const cleanup=typeof action.cleanupId==='string'?rowsForAction(rows,action.cleanupId,'CAMPAIGN_RESULT'):[];if(cleanup.length!==1||body(body(cleanup[0]!.payload).usage).status!=='PASS')return false;
  seen.add(String(op.probeId));refs.push(pointer);
 }
 refs.push(manifest.managedConflict);return required.every(id=>seen.has(id));
}
export type StartupBlockerDecision = Readonly<{ id: typeof STARTUP_BLOCKER_IDS[number]; state: 'OPEN'|'CLOSED'; ruleVersion: typeof STARTUP_RULE_VERSION; reasonCode: string; scope: 'headless-local-stdio-new-thread'; artifacts: readonly StartupArtifactRef[] }>;
function policyMatches(proof: StartupSessionProof, manifest: StartupCoverageManifest) { if (!proof.policy) return false; const { observedAt: _at, ...policy } = proof.policy; return fingerprint(policy) === fingerprint(manifest.expectedPolicy) && proof.policy.environmentHash === proof.intent.environmentHash; }
function covers(loaded: LoadedReview, required: readonly string[]): boolean {
 const { manifest, proofs } = loaded;
 if(!manifest)return false;
 return required.every(path => STARTUP_SOURCES.every(source => ['bootstrap','thread-start'].every(lifecycle => {
  const route = manifest.routes.find(item => item.path === path && item.source === source && item.lifecycle === lifecycle); if (!route) return false;
  return proofs.some(({ proof }) => {
   if(!proof.initialized||!policyMatches(proof,manifest)||lifecycle==='thread-start'&&!proof.threadStarted)return false;
   if(route.enforcement==='inapplicable'){const scope=loaded.scope;return ['browser-native','browser-cdp','computer'].includes(path)&&!!scope&&scope.client.dynamicTools==='none'&&scope.client.selectedCapabilityRoots==='none'&&scope.client.remoteEnvironments==='none';}
   if (route.enforcement === 'persistent-restriction') return true;
   const monitor = proof.monitors?.find(item => item.path === path);
   return !!monitor && !!route.registrationHash && monitor.registrationHash === route.registrationHash && !!route.monitorHash && monitor.monitorHash === route.monitorHash &&
    !!monitor.registrationEvidence && !!monitor.baselineHash && monitor.baselineHash === monitor.finalHash && monitor.activationCount === 0 && monitor.armedAt <= proof.ownership.capturedAt && monitor.observedThrough >= terminalTime(proof);
  });
 })));
}
function strict(loaded: LoadedReview): boolean {
 const positive = loaded.proofs.filter(item => item.proof.strict?.phase === 'positive'), negative = loaded.proofs.filter(item => item.proof.strict?.phase === 'negative');
 if (positive.length !== 1 || negative.length !== 1) return false;
 const p = positive[0]!.proof, n = negative[0]!.proof, ps = p.strict!, ns = n.strict!;
 const natural=(proof:StartupSessionProof)=>'rootExitCause' in proof.drain?proof.drain.rootExitCause==='natural':proof.drain.reason==='root_exit'&&proof.drain.requestAcknowledged===false;
 const baseline=(i:StartupSessionProof['intent'])=>{const {requestId:_request,argumentsHash:_arguments,dispatchHash:_dispatch,owner,dispatchAuthorization:authorization,...target}=i;const {actionId:_action,...ownerScope}=owner;return {...target,owner:ownerScope,authorization:{kind:authorization.kind,fixtureRoots:authorization.kind==='qualification'?authorization.fixtureRoots:undefined}};};
 return p.intent.owner.actionId !== n.intent.owner.actionId && p.intent.dispatchAuthorization.kind==='qualification'&&n.intent.dispatchAuthorization.kind==='qualification'&&p.intent.dispatchAuthorization.probeId==='auxiliary.strict-positive'&&n.intent.dispatchAuthorization.probeId==='auxiliary.strict-negative'&&
  p.initialized && !n.initialized && ps.classification === 'initialized' && ns.classification === 'unknown-field-foo' && ps.baselineHash === ns.baselineHash && ps.baselineHash===fingerprint(baseline(p.intent))&&ps.baselineHash===fingerprint(baseline(n.intent))&&
  ps.termination === 'natural' && ns.termination === 'natural' && natural(p)&&natural(n)&&ps.exitCode === 0 && ns.exitCode !== 0 && ns.rpcCount === 0 && p.drain.rootExitCode === ps.exitCode && n.drain.rootExitCode === ns.exitCode;
}
function reviewsFor(target: QualificationTarget, evidence?: AcceptedStartupEvidence):readonly LoadedReview[] {
 if(!evidence||evidence.targetHash!==fingerprint(target))return [];const loaded=validated.get(evidence);if(!loaded)return [];
 try{const current=loaded.store.listQualifications();if(!current.ok||fingerprint(current.value)!==loaded.historyHash)return [];
  // Recheck accepted bytes at every evaluation, including changed source bytes.
  for(const review of loaded.reviews)for(const pointer of review.refs)readArtifact(loaded.store,pointer,8388608);
  return loaded.reviews;
 }catch{return [];}
}
export function evaluateStartupBlockers(target: QualificationTarget, evidence?: AcceptedStartupEvidence): StartupBlockerDecision[] {
 const reviews = reviewsFor(target, evidence);
 return STARTUP_BLOCKER_IDS.map(id => {
  const accepted = reviews.find(loaded => loaded.review.acceptedClaims.includes(id) && (id === 'PLUGIN_STARTUP_UNPROVEN' ? covers(loaded, ['plugins','plugin-contributions']) :
   id === 'BROWSER_COMPUTER_STARTUP_UNPROVEN' ? covers(loaded, ['browser-native','browser-cdp','computer']) : id === 'MCP_INVENTORY_UNPROVEN' ? covers(loaded, ['mcp-ordinary','mcp-managed-cloud','mcp-plugin']) :
   id === 'STRICT_CONFIG_RUNTIME_UNVERIFIED' ? strict(loaded) : loaded.managedAccepted));
  return Object.freeze({ id, state: accepted ? 'CLOSED' : 'OPEN', ruleVersion: STARTUP_RULE_VERSION, reasonCode: accepted ? 'ACCEPTED_EXACT_TARGET_EVIDENCE' : id === 'MANAGED_REQUIREMENTS_UNVERIFIED' ? 'MANAGED_CONFLICT_AND_BOUNDARY_EVIDENCE_REQUIRED' : 'ACCEPTED_EVIDENCE_REQUIRED', scope: 'headless-local-stdio-new-thread', artifacts: Object.freeze(accepted ? accepted.refs : []) }) as StartupBlockerDecision;
 });
}
export function evaluateStartupSupportingRequirements(target: QualificationTarget, evidence?: AcceptedStartupEvidence) {
 const reviews = reviewsFor(target, evidence);
 return STARTUP_SUPPORTING_IDS.map(id => ({ id, state: reviews.some(loaded => loaded.manifest&&loaded.review.acceptedClaims.includes(id) && (id === 'environment' ? loaded.proofs.some(({ proof }) => policyMatches(proof, loaded.manifest!)) : covers(loaded, id === 'remote-control' ? ['remote-control'] : id === 'hooks-notify' ? ['hooks','legacy-notify'] : ['apps','web']))) ? 'CLOSED' as const : 'OPEN' as const }));
}
