import {fixtureCodexControls} from './helpers/codex-controls.ts';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type RunStore, type QualificationEnvelope } from '../src/store/database.ts';
import { publishArtifact } from '../src/store/artifacts.ts';
import type { Result } from '../src/contracts/common.ts';
import type { QualificationTarget } from '../src/qualification/ledger.ts';
import { evaluateStartupBlockers, evaluateStartupSupportingRequirements, loadStartupEvidence, StartupSessionProofSchema, createManagedPolicyConflictProjection, bindManagedPolicyConflictEvidence, buildStartupCoverageManifest, validateStartupCoverageForPreparation, sourceCoveredStartupPaths, STARTUP_BLOCKER_IDS, type StartupCoverageManifest, type StartupSessionProof, type StartupAcceptance, type StartupArtifactRef } from '../src/qualification/startup-evidence.ts';
import { STARTUP_SOURCES, type StartupIntent } from '../src/qualification/codex-startup-authority.ts';
import { fingerprint } from '../src/qualification/probes.ts';
import { projectConfig, projectRequirements } from '../src/providers/codex/policy.ts';
import { startupContext } from './helpers/codex-admission.ts';

const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const h = 'a'.repeat(64);
const target: QualificationTarget = { schemaVersion: 1, provider: 'codex', environment: 'windows', runtime: { path: 'C:\\pinned\\codex.exe', version: '0.162.1', sha256: h }, adapter: { version: '1', sha256: h }, helper: { path: 'C:\\pinned\\helper.exe', version: '1', sha256: h }, verifier: { path: 'C:\\pinned\\codex.exe', version: '0.162.1', sha256: h, wrapperHash: h }, os: { platform: 'win32', architecture: 'x64', release: 'fixture', sha256: h }, policyHash: h, startupConfigHash: h, model: 'fixture-model', effort: 'high' };
it('returns every separate blocker OPEN without accepted durable evidence', () => {
 const store = openStore(mkdtempSync(join(tmpdir(), 'startup-evidence-'))); stores.push(store);
 const evidence = loadStartupEvidence(store, target);
 const decisions = evaluateStartupBlockers(target, evidence);
 expect(decisions).toHaveLength(5);
 expect(decisions.every(d => d.state === 'OPEN' && d.artifacts.length === 0)).toBe(true);
 expect(new Set(decisions.map(d => d.id)).size).toBe(5);
});
it('does not accept caller booleans, copied bundles or a stale target', () => {
 const store = openStore(mkdtempSync(join(tmpdir(), 'startup-evidence-'))); stores.push(store);
 const evidence = loadStartupEvidence(store, target);
 for (const input of [{ allRequiredSurfacesInactive: true }, structuredClone(evidence)]) {
  expect(evaluateStartupBlockers(target, input as typeof evidence).every(d => d.state === 'OPEN')).toBe(true);
 }
 expect(evaluateStartupBlockers({ ...target, startupConfigHash: 'b'.repeat(64) }, evidence).every(d => d.state === 'OPEN')).toBe(true);
});
it('refuses untyped process output masquerading as typed safe proof', () => {
 expect(StartupSessionProofSchema.safeParse({ status: 'PASS', stderr: 'secret', allRequiredSurfacesInactive: true }).success).toBe(false);
});

const must=<T>(result:Result<T>):T=>{if(!result.ok)throw Error(result.error.code);return result.value;};
/** Deliberately synthetic durable history. Its LIVE labels exercise rejection
 * and acceptance logic only; none of these artifacts qualify a real runtime. */
async function acceptedFixture(options:{simulation?:boolean;missingPluginRoute?:boolean;unaccepted?:boolean;selfReview?:boolean;managed?:boolean;managedWrongIntent?:boolean;strict?:boolean;forcedStrict?:boolean;wrongStrictBaseline?:boolean;nativeStrict?:boolean;nativeAcknowledged?:boolean;nativeWrongReason?:boolean;strictWithoutCoverage?:boolean;noBroker?:boolean;inapplicableBrowser?:boolean;scopedInapplicable?:boolean;localScope?:boolean;scopeWrongFixture?:boolean;sourceCatalog?:boolean}={}){
 const store=openStore(mkdtempSync(join(tmpdir(),'startup-evidence-acceptance-')));stores.push(store);
 const runId=randomUUID(),repoId=randomUUID();must(store.createRun(repoId,{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));
 const owner=must(store.claim(repoId,runId)),campaignId=randomUUID(),batchId=randomUUID(),metadataId=randomUUID();
 const t:QualificationTarget={...target,adapter:{...target.adapter,sha256:startupContext.adapterHash},helper:{...target.helper,...startupContext.helper},verifier:{...target.verifier,wrapperHash:startupContext.verifierHash},os:{...target.os,sha256:startupContext.osCapabilitiesHash},startupConfigHash:startupContext.configHash};
 const targetHash=fingerprint(t);
 function intentAction(id:string,launchHash:string){must(store.intent(owner,{schemaVersion:1,id,runId,kind:'CAMPAIGN_ACTION',payload:{campaignId,batchId,launchHash,admissionHash:h}}));must(store.dispatch(owner,id));}
 intentAction(metadataId,h);
 function append(kind:QualificationEnvelope['kind'],actionId:string,payload:unknown){must(store.appendQualification(owner,{schemaVersion:1,id:randomUUID(),runId,generation:owner.generation,actionId,requestId:campaignId,targetHash,kind,payload:JSON.parse(JSON.stringify(payload))},must(store.listQualifications(runId)).length));}
 async function artifact(value:unknown,actionId=metadataId):Promise<StartupArtifactRef>{async function* bytes(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value));}const a=must(await publishArtifact(store,bytes(),{schemaVersion:1,id:randomUUID(),owner,actionId,mediaType:'application/json',secrets:[]}));return {id:a.id,sha256:a.sha256};}
 const source=await artifact('synthetic pinned enforcement consumer');
 const sourceEvidence=[{commit:'a'.repeat(40),path:'codex-rs/core/consumer.rs',blobHash:source.sha256,artifact:source,consumer:'load_effective_config'}];
 const rawConfig={config:{model_provider:'openai',default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{apps:false,hooks:false,plugins:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:false,remote_control:false},web_search:'disabled',mcp_servers:{},...fixtureCodexControls(),...(options.localScope?{sqlite_home:'C:\\fixture\\runtime-state'}:{})}};
 const rawRequirements={requirements:{}};
 const config=projectConfig(rawConfig),requirements=projectRequirements(rawRequirements);
 const policy={configurationHash:fingerprint(config),requirementsHash:fingerprint(requirements),permissionsHash:config.selectedPermissionsHash!,environmentHash:h,shellEnvironmentPolicyHash:config.shellEnvironmentPolicyHash!,account:'chatgpt' as const,provider:'openai' as const};
 const paths=['plugins','plugin-contributions','browser-native','browser-cdp','computer','mcp-ordinary','mcp-managed-cloud','mcp-plugin','remote-control','hooks','legacy-notify','apps','web'] as const;
 const manifest:StartupCoverageManifest={schemaVersion:1,ruleVersion:'startup-closure-v1',kind:'startup-coverage',targetHash,scope:'headless-local-stdio-new-thread',controllerHash:startupContext.controllerHash,protocolHash:startupContext.protocolHash,controlHash:startupContext.controlHash,environmentHash:h,fixtureHash:h,expectedPolicy:policy,
 routes:paths.flatMap(path=>STARTUP_SOURCES.flatMap(source=>(['bootstrap','thread-start'] as const).map(lifecycle=>({path,source,lifecycle,enforcement:options.inapplicableBrowser&&['browser-native','browser-cdp','computer'].includes(path)?'inapplicable' as const:'persistent-restriction' as const,sourceEvidence})))).filter(route=>!(options.missingPluginRoute&&route.path==='plugins'&&route.source==='cloud'&&route.lifecycle==='bootstrap')),
 exclusions:['thread-resume','reload','desktop-client','remote-client'],boundaryEvidence:[],requirementsSources:STARTUP_SOURCES.map(source=>({source,sourceEvidence}))};
 const observations:StartupArtifactRef[]=[];
 const boundaryIds=['worker.allowed_edit','verifier.allowed_command',...(['worker','verifier'] as const).flatMap(role=>['denied_source_write','denied_sensitive_read','denied_network'].map(name=>`${role}.${name}`))];
 const planned=['worker.unapproved_config_inactive',...(options.strict?['auxiliary.strict-positive','auxiliary.strict-negative']:[]),...(options.managed?boundaryIds:[])].map(probeId=>{const id=randomUUID();return {id,kind:probeId.startsWith('auxiliary.strict')?probeId.slice('auxiliary.'.length):'probe',topLevel:true,probeId,launchHash:fingerprint({actionId:id}),admissionHash:h,maxMs:10000,maxOutputBytes:10000,cleanupId:randomUUID()};});
 append('CAMPAIGN',metadataId,{identity:{id:campaignId,target:t,targetHash,controllerHash:startupContext.controllerHash,protocolHash:startupContext.protocolHash}});
 append('BATCH_APPROVAL',metadataId,{schemaVersion:2,id:batchId,campaignId,owner,targetHash,fixtureHash:h,endpointHash:h,approvedAt:1000,expiresAt:4000,actions:planned});
 async function action(probeId:string,proofRequired:boolean,strictPhase?:'positive'|'negative'){
  const action=planned.find(item=>item.probeId===probeId)!;const {id:actionId,cleanupId,launchHash}=action;intentAction(actionId,launchHash);intentAction(cleanupId,h);
  const intent:StartupIntent={schemaVersion:2,phase:'PRE_PROCESS',...startupContext,runtime:{...t.runtime,version:'0.162.1'},environmentHash:h,boundaryHash:h,argumentsHash:h,profile:'ouroboros_worker',sandbox:'mxc',environmentKeys:['SystemRoot'],issuedAt:1000,expiresAt:4000,owner:{runId,generation:owner.generation,actionId,role:'worker'},requestId:batchId,workspace:'C:\\fixture',configAncestry:['C:\\','C:\\fixture'],authMode:'managed-chatgpt',action:'worker-start',dispatchAuthorization:{kind:'qualification',requestId:batchId,probeId,fixtureRoots:['C:\\fixture']},dispatchHash:launchHash,model:t.model,effort:t.effort};
  const ownership={schemaVersion:1 as const,...intent.owner,environment:'windows' as const,pid:10,creationIdentity:actionId,helperPid:11,helperCreationIdentity:`${actionId}-helper`,jobIdentity:`${actionId}-job`,boundaryHash:h,assignedBeforeResume:true as const,capturedAt:1001};
  const proof:StartupSessionProof={schemaVersion:1,kind:'startup-session-proof',evidenceKind:options.simulation?'simulation':'live',intent,status:'PASS',initialized:true,threadStarted:true,ownership,
   drain:{schemaVersion:1,...intent.owner,reason:'qualification-session-terminal',requestAcknowledged:true,requestedAt:2000,acknowledgedAt:2000,rootExited:true,rootExitedAt:2001,rootExitCode:0,membershipEmpty:true,membershipObservedAt:2002,activeProcesses:0,unresolvedExecutions:[],outputComplete:true,unresolvedOutputStreams:[],outputCompletedAt:2002,childRanBeforeAssignment:false,completedAt:2002},
   dispatches:[{dispatchId:fingerprint({actionId,kind:'launch'}),sequence:1,kind:'launch',launchHash:h},{dispatchId:fingerprint({actionId,kind:'initialize'}),sequence:2,kind:'initialize',launchHash:h},{dispatchId:fingerprint({actionId,kind:'drain'}),sequence:3,kind:'drain',launchHash:h}],policy:{...policy,observedAt:1500},broker:{inventoryScope:'campaign-owned-controlled-services',registryHash:h,activeCount:0,unresolvedCount:0}};
  if(options.noBroker)delete proof.broker;
  if(options.inapplicableBrowser&&!options.scopedInapplicable){delete proof.policy;delete proof.broker;proof.threadStarted=false;}
  if(strictPhase){
   const nativeDrain=proof.drain;
   proof.initialized=strictPhase==='positive';proof.threadStarted=false;
   if(strictPhase==='negative')intent.argumentsHash='b'.repeat(64);
   const description={schemaVersion:1 as const,...intent.owner,boundaryHash:h,observer:{pid:30,creationIdentity:'observer'},controller:{pid:31,creationIdentity:'controller'},root:{pid:10,creationIdentity:ownership.creationIdentity},helper:{pid:11,creationIdentity:ownership.helperCreationIdentity},outerJobIdentity:'outer-job',innerJobIdentity:ownership.jobIdentity,proofMethod:'windows-outer-superset-v1' as const,nestedSubsetEstablished:true as const,assignedBeforeResume:true as const,handoffBeforeResume:true as const,helperOwnsOnlyInnerJobHandle:true as const,capturedAt:1001,descendants:[]};
   proof.drain={schemaVersion:1,...intent.owner,description,processMeterError:false,rootLifetimeMs:1000,helperLifetimeMs:1000,
    processMeters:(['root','helper','controller','guardian'] as const).map(kind=>({kind,identity:description[kind==='guardian'?'observer':kind],createdAt:1001,exitedAt:kind==='guardian'?null:2001,activeMs:1000,outputBytes:0})),
    rootExited:true,rootExitCode:strictPhase==='positive'?0:1,rootExitCause:options.forcedStrict?'supervisor-drain':'natural',helperExited:true,controllerExited:true,outerActiveProcesses:0,outerMembershipEmpty:true,outerQueryError:null,proofMethod:'windows-outer-superset-v1',outputComplete:true,
    streams:(['root','controller'] as const).flatMap(source=>(['stdout','stderr'] as const).map(stream=>({source,stream,bytes:0,eofCount:1}))),totalRawBytes:0,overflow:false,readerFailure:false,emergencyTerminated:false,controllerRetiredAfterHelperExit:true,trigger:null,unrelated:null,observedAt:2002};
   const {requestId:_request,argumentsHash:_args,dispatchHash:_dispatch,owner:actionOwner,dispatchAuthorization:authorization,...rest}=intent;const {actionId:_action,...ownerScope}=actionOwner;
   proof.strict={phase:strictPhase,baselineHash:options.wrongStrictBaseline?h:fingerprint({...rest,owner:ownerScope,authorization:{kind:authorization.kind,fixtureRoots:authorization.kind==='qualification'?authorization.fixtureRoots:undefined}}),classification:strictPhase==='positive'?'initialized':'unknown-field-foo',exitCode:strictPhase==='positive'?0:1,rpcCount:0,termination:'natural'};
   if(options.nativeStrict&&'completedAt' in nativeDrain)proof.drain={...nativeDrain,reason:options.nativeWrongReason?'forced-stop':'root_exit',rootExitCode:strictPhase==='positive'?0:1,requestAcknowledged:options.nativeAcknowledged??false,acknowledgedAt:options.nativeAcknowledged?2000:null};
  }
  const operation=await artifact({schemaVersion:2,kind:'campaign-probe',targetHash,probeId,role:probeId.startsWith('verifier')?'verifier':'worker',launchHash,status:'PASS',actualAttempt:true,evidenceKind:'live'},actionId);
  const evidence=[{...operation,category:'operation'}];if(proofRequired){const pointer=await artifact(proof,actionId);observations.push(pointer);evidence.push({...pointer,category:'startup-proof'});}
  append('CAMPAIGN_DISPATCH',actionId,{batchId,action,startedAt:1001});append('CAMPAIGN_DISPATCH',cleanupId,{batchId,action:{id:cleanupId,kind:'cleanup',launchHash:h},startedAt:2000});
  must(store.outcome(owner,actionId,{schemaVersion:1,status:'SUCCEEDED',evidenceIds:evidence.map(item=>item.id)}));must(store.outcome(owner,cleanupId,{schemaVersion:1,status:'SUCCEEDED',evidenceIds:[]}));
  append('CAMPAIGN_RESULT',actionId,{batchId,actionId,usage:{status:'PASS',evidenceKind:'live',evidence}});append('CAMPAIGN_RESULT',cleanupId,{batchId,actionId:cleanupId,usage:{status:'PASS',evidenceKind:'live'}});
  return operation;
 }
 await action('worker.unapproved_config_inactive',true);
 if(options.localScope){const proof=StartupSessionProofSchema.parse(JSON.parse(readFileSync(join(store.root,'artifacts',observations[0]!.sha256),'utf8')));manifest.scopeEvidence=await artifact({schemaVersion:1,kind:'current-controller-reviewed-local-stdio-scope',targetHash,controllerHash:proof.intent.controllerHash,protocolHash:proof.intent.protocolHash,fixtureHash:options.scopeWrongFixture?'b'.repeat(64):h,environmentHash:h,controlHash:proof.intent.controlHash,intentHash:fingerprint(proof.intent),configuration:config,preparation:{actionId:metadataId,runId,generation:owner.generation,observedAt:1000,operation:'atomic-new-empty-directory',sqliteHomeHash:config.sqliteHomeHash,initialEntries:[]},client:{name:'ouroboros',transport:'stdio',environment:'local',threadMode:'new-only',reconfiguration:'none',remoteStartup:'resolve-persisted',dynamicTools:'none',selectedCapabilityRoots:'none',remoteEnvironments:'none',allowedMethods:['initialize','initialized','account/read','config/read','configRequirements/read','thread/start','turn/start','turn/interrupt']}});}
 if(options.strict){await action('auxiliary.strict-positive',true,'positive');await action('auxiliary.strict-negative',true,'negative');}
 if(options.managed){
  const actualProof=StartupSessionProofSchema.parse(JSON.parse(readFileSync(join(store.root,'artifacts',observations[0]!.sha256),'utf8'))),projection=createManagedPolicyConflictProjection({intentHash:options.managedWrongIntent?h:fingerprint(actualProof.intent),rawConfig,rawRequirements});
  manifest.managedConflict=await artifact(bindManagedPolicyConflictEvidence({targetHash,policyEvidence:observations[0]!,projection}));
  for(const probeId of boundaryIds)manifest.boundaryEvidence.push(await action(probeId,false));
 }
 if(options.sourceCatalog){const extra=await artifact('extra full consumer chain');manifest.sourceCatalog=[{...sourceEvidence[0]!,path:'codex-rs/extra.rs',blobHash:extra.sha256,artifact:extra}];}
 const coverage=await artifact(manifest),producerId=randomUUID();
 const review:StartupAcceptance={schemaVersion:1,ruleVersion:'startup-closure-v1',kind:'startup-independent-review',targetHash,reviewerId:options.selfReview?producerId:randomUUID(),producerId,reviewedAt:3000,...(options.strictWithoutCoverage?{strictSources:sourceEvidence}:{coverage}),observations:options.strictWithoutCoverage?observations.slice(1):observations,acceptedClaims:options.strictWithoutCoverage?['STRICT_CONFIG_RUNTIME_UNVERIFIED']:[...STARTUP_BLOCKER_IDS,'remote-control','hooks-notify','apps-web','environment'],unresolvedClaims:[]};
 const reviewRef=await artifact(review);must(store.outcome(owner,metadataId,{schemaVersion:1,status:'SUCCEEDED',evidenceIds:[]}));
 const acceptance={reviews:[reviewRef],acceptedReviewHashes:options.unaccepted?[]:[reviewRef.sha256]};
 return {store,target:t,load:()=>loadStartupEvidence(store,t,acceptance),reviewRef,coverage,source,manifest,observations,append,metadataId};
}
it('closes only the three reviewed startup paths and supporting scope with valid immutable live proof',async()=>{
 const f=await acceptedFixture(),evidence=f.load(),decisions=evaluateStartupBlockers(f.target,evidence);
 expect(evidence.issues).toEqual([]);
 expect(decisions.filter(d=>d.state==='CLOSED').map(d=>d.id)).toEqual(STARTUP_BLOCKER_IDS.slice(0,3));
 expect(evaluateStartupSupportingRequirements(f.target,evidence).every(d=>d.state==='CLOSED')).toBe(true);
 expect(evaluateStartupBlockers({...f.target,helper:{...f.target.helper,sha256:'c'.repeat(64)}},evidence).every(d=>d.state==='OPEN')).toBe(true);
});
it('closes managed requirements only with actual compatible policy, reviewed precedence, injected conflicts and both boundary roles',async()=>{
 const f=await acceptedFixture({managed:true}),evidence=f.load();expect(evidence.issues).toEqual([]);
 expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='MANAGED_REQUIREMENTS_UNVERIFIED')?.state).toBe('CLOSED');
 expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='STRICT_CONFIG_RUNTIME_UNVERIFIED')?.state).toBe('OPEN');
});
it('managed conflict binding rejects a projection from a different actual intent',async()=>{
 const f=await acceptedFixture({managed:true,managedWrongIntent:true});expect(evaluateStartupBlockers(f.target,f.load()).find(d=>d.id==='MANAGED_REQUIREMENTS_UNVERIFIED')?.state).toBe('OPEN');
});
it('retains and rechecks exact reviewed local scope bytes with accepted source evidence',async()=>{
 const f=await acceptedFixture({localScope:true}),evidence=f.load();expect(evidence.issues).toEqual([]);expect(evaluateStartupBlockers(f.target,evidence)[0]!.artifacts).toContainEqual(f.manifest.scopeEvidence);
 writeFileSync(join(f.store.root,'artifacts',f.manifest.scopeEvidence!.sha256),'changed scope');expect(evaluateStartupBlockers(f.target,evidence).every(item=>item.state==='OPEN')).toBe(true);
});
it('rejects a reviewed local scope for another exact fixture',async()=>{
 const f=await acceptedFixture({localScope:true,scopeWrongFixture:true}),evidence=f.load();expect(evidence.issues).toContain('LOCAL_SCOPE_BINDING_CHANGED');expect(evaluateStartupBlockers(f.target,evidence).every(item=>item.state==='OPEN')).toBe(true);
});
it('rechecks shared source catalog bytes for preparation and accepted decisions',async()=>{
 const f=await acceptedFixture({sourceCatalog:true}),evidence=f.load(),proof=StartupSessionProofSchema.parse(JSON.parse(readFileSync(join(f.store.root,'artifacts',f.observations[0]!.sha256),'utf8')));expect(evidence.issues).toEqual([]);
 expect(()=>validateStartupCoverageForPreparation(f.store,f.target,f.manifest.fixtureHash,proof.intent,f.manifest)).not.toThrow();const extra=f.manifest.sourceCatalog![0]!.artifact;writeFileSync(join(f.store.root,'artifacts',extra.sha256),'changed extra consumer');
 expect(()=>validateStartupCoverageForPreparation(f.store,f.target,f.manifest.fixtureHash,proof.intent,f.manifest)).toThrow('ARTIFACT_CHANGED');expect(evaluateStartupBlockers(f.target,evidence).every(item=>item.state==='OPEN')).toBe(true);
});
it.each([{simulation:true},{unaccepted:true},{selfReview:true}])('rejects simulated, unaccepted and self-reviewed records: %j',async options=>{
 const f=await acceptedFixture(options);expect(evaluateStartupBlockers(f.target,f.load()).every(d=>d.state==='OPEN')).toBe(true);
});
it('one missing source route reopens its own blocker without borrowing another surface',async()=>{
 const f=await acceptedFixture({missingPluginRoute:true}),decisions=evaluateStartupBlockers(f.target,f.load());
 expect(decisions.find(d=>d.id==='PLUGIN_STARTUP_UNPROVEN')?.state).toBe('OPEN');
 expect(decisions.find(d=>d.id==='MCP_INVENTORY_UNPROVEN')?.state).toBe('CLOSED');
});
it('rejects changed source artifacts even with a retained acceptance pin',async()=>{
 const f=await acceptedFixture();writeFileSync(join(f.store.root,'artifacts',f.source.sha256),'changed');
 expect(evaluateStartupBlockers(f.target,f.load()).every(d=>d.state==='OPEN')).toBe(true);
});
it('closes strict config only from the exact attributed positive/negative pair and natural drains',async()=>{
 const f=await acceptedFixture({strict:true}),evidence=f.load();expect(evidence.issues).toEqual([]);
 expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='STRICT_CONFIG_RUNTIME_UNVERIFIED')?.state).toBe('CLOSED');
 expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='MANAGED_REQUIREMENTS_UNVERIFIED')?.state).toBe('OPEN');
});
it.each([{forcedStrict:true},{wrongStrictBaseline:true}])('rejects forced termination and arbitrary strict baseline digests: %j',async fault=>{
 const f=await acceptedFixture({strict:true,...fault});expect(evaluateStartupBlockers(f.target,f.load()).find(d=>d.id==='STRICT_CONFIG_RUNTIME_UNVERIFIED')?.state).toBe('OPEN');
});
it('reopens a copied accepted snapshot when later history or unresolved failure is appended',async()=>{
 const f=await acceptedFixture(),before=f.load();expect(evaluateStartupBlockers(f.target,before)[0]?.state).toBe('CLOSED');
 f.append('CAMPAIGN_FENCE',f.metadataId,{unknownActionId:f.metadataId});
 expect(evaluateStartupBlockers(f.target,before).every(d=>d.state==='OPEN')).toBe(true);
 expect(evaluateStartupBlockers(f.target,f.load()).every(d=>d.state==='OPEN')).toBe(true);
});
it('accepts exact native natural strict receipts with complete ownership and drainage',async()=>{
 const f=await acceptedFixture({strict:true,nativeStrict:true}),evidence=f.load();expect(evidence.issues).toEqual([]);
 expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='STRICT_CONFIG_RUNTIME_UNVERIFIED')?.state).toBe('CLOSED');
});
it.each([{nativeAcknowledged:true},{nativeWrongReason:true}])('rejects an imposed native natural strict classification: %j',async fault=>{
 const f=await acceptedFixture({strict:true,nativeStrict:true,...fault});expect(evaluateStartupBlockers(f.target,f.load()).find(d=>d.id==='STRICT_CONFIG_RUNTIME_UNVERIFIED')?.state).toBe('OPEN');
});
it('strict-only closure verifies its own source bytes without an unrelated startup coverage manifest',async()=>{
 const f=await acceptedFixture({strict:true,nativeStrict:true,strictWithoutCoverage:true}),evidence=f.load();expect(evidence.issues).toEqual([]);
 expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='STRICT_CONFIG_RUNTIME_UNVERIFIED')?.state).toBe('CLOSED');expect(evaluateStartupBlockers(f.target,evidence).filter(d=>d.state==='CLOSED')).toHaveLength(1);
});
it('source-backed persistent restrictions do not require unrelated broker records or dummy monitors',async()=>{
 const f=await acceptedFixture({noBroker:true}),evidence=f.load();expect(evidence.issues).toEqual([]);expect(evaluateStartupBlockers(f.target,evidence).slice(0,3).every(d=>d.state==='CLOSED')).toBe(true);
});
it('metadata-only inapplicability cannot substitute for observed scoped thread-start and policy',async()=>{
 const f=await acceptedFixture({inapplicableBrowser:true}),evidence=f.load();expect(evidence.issues).toEqual([]);expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='BROWSER_COMPUTER_STARTUP_UNPROVEN')?.state).toBe('OPEN');expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='PLUGIN_STARTUP_UNPROVEN')?.state).toBe('OPEN');
});
it('builds source coverage from actual proof bindings and revalidates the trusted source bytes before preparation',async()=>{
 const f=await acceptedFixture(),proof=StartupSessionProofSchema.parse(JSON.parse(readFileSync(join(f.store.root,'artifacts',f.observations[0]!.sha256),'utf8')));
 const manifest=buildStartupCoverageManifest({target:f.target,proof,fixtureHash:h,routes:f.manifest.routes});
 expect(manifest.expectedPolicy).toEqual(f.manifest.expectedPolicy);expect(sourceCoveredStartupPaths(manifest)).toHaveLength(13);expect(validateStartupCoverageForPreparation(f.store,f.target,h,proof.intent,manifest)).toEqual(manifest);
 expect(()=>validateStartupCoverageForPreparation(f.store,f.target,'b'.repeat(64),proof.intent,manifest)).toThrow('STARTUP_COVERAGE_BINDING_CHANGED');
 expect(()=>buildStartupCoverageManifest({target:f.target,proof:{...proof,evidenceKind:'simulation'},fixtureHash:h,routes:f.manifest.routes})).toThrow('ACTUAL_COMPATIBLE_POLICY_REQUIRED');
});

it('accepts native inapplicability only with compatible policy and verified closed local thread scope',async()=>{
 const f=await acceptedFixture({inapplicableBrowser:true,scopedInapplicable:true,localScope:true}),evidence=f.load();expect(evidence.issues).toEqual([]);
 expect(evaluateStartupBlockers(f.target,evidence).find(d=>d.id==='BROWSER_COMPUTER_STARTUP_UNPROVEN')?.state).toBe('CLOSED');
});
