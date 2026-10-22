import {administrativeFixture} from './helpers/administrative-evidence.ts';
import {afterEach,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,type RunStore} from '../src/store/database.ts';
import {publishArtifact} from '../src/store/artifacts.ts';
import {QualificationCampaign,CampaignExecutionPolicySchema,BatchApprovalSchema} from '../src/qualification/campaign.ts';
import {remainingAllowance,exceedsAllowance} from '../src/qualification/campaign-policy.ts';
import {CampaignAuthorizationJournal,CampaignAuthorizationSchema} from '../src/qualification/campaign-authorization.ts';
import {targetFingerprint} from '../src/qualification/ledger.ts';
import {CAMPAIGN_EXECUTION_PROBE_ORDER,campaignExecutionDeficits} from '../src/qualification/campaign-execution.ts';
import {REQUIRED_CODEX_WINDOWS_PROBES,fingerprint} from '../src/qualification/probes.ts';
import {RuntimeSourceCatalogSchema,validateRuntimeSourceCatalog} from '../src/qualification/runtime-source-catalog.ts';
import {STARTUP_SOURCES} from '../src/qualification/codex-startup-authority.ts';
import {STARTUP_MONITOR_PATHS} from '../src/qualification/startup-evidence.ts';

const h='a'.repeat(64),stores:RunStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();});
const must=(r:any):any=>{if(!r.ok)throw Error(r.error.code);return r.value;};
async function fixture(bounded=false){
 const store=openStore(mkdtempSync(join(tmpdir(),'task7-successor-')));stores.push(store);
 const runId=randomUUID(),repoId=randomUUID();must(store.createRun(repoId,{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));
 const owner=must(store.claim(repoId,runId));let now=1000,accepted=true;
 const campaign=new QualificationCampaign(store,{now:()=>now,authorizeCurrent:()=>true,authorizeExecutionPolicy:()=>true,authorizeAccounting:()=>true});
 const target:any={schemaVersion:1,provider:'codex',environment:'windows',runtime:{path:'C:\\pinned\\codex.exe',version:'0.163.0',sha256:h},adapter:{version:'1',sha256:h},helper:{path:'C:\\pinned\\helper.exe',version:'1',sha256:h},verifier:{path:'C:\\pinned\\codex.exe',version:'0.163.0',sha256:h,wrapperHash:h},os:{platform:'win32',architecture:'x64',release:'fixture',sha256:h},policyHash:h,startupConfigHash:h,model:'fixture-model',effort:'high'};
 const id=randomUUID(),lineage=must(campaign.lineage(id));
 const policy=CampaignExecutionPolicySchema.parse({schemaVersion:bounded?1:2,kind:'human-execution-allowance',id:randomUUID(),campaignId:id,owner,storeRootHash:lineage.storeRootHash,historyHash:lineage.historyHash,targetHash:targetFingerprint(target),approvalInstruction:'SIMULATION only; no live dispatch',limits:{campaignLimits:bounded?{actions:96,activeMs:2400000,outputBytes:10485760}:{mode:'unlimited'},batchLimits:{topLevelActions:4,activeMs:600000,outputBytes:bounded?10485760:67108864,approvalTtlMs:600000},maxUnsuccessfulCorrections:2}});
 async function* data(){yield Buffer.from(JSON.stringify(policy));}
 const ref=must(await publishArtifact(store,data(),{schemaVersion:1,id:randomUUID(),owner,actionId:null,mediaType:'application/json',secrets:[]}));
 const identity={schemaVersion:2,id,owner,target,targetHash:targetFingerprint(target),controllerHash:h,protocolHash:h,driverHash:h,lineage,executionPolicy:{id:ref.id,sha256:ref.sha256}};must(campaign.create(identity));
 const grant=CampaignAuthorizationSchema.parse({schemaVersion:1,administration:{schemaVersion:1,authorityHash:h,preparationInvocationIds:[randomUUID()],registrationInvocationId:randomUUID(),registrationProcessCount:1,unitWrapperProcessCount:2,settlementProcessCount:2},kind:'reviewed-campaign-authorization',id:randomUUID(),campaignId:id,owner,targetHash:identity.targetHash,identityHash:fingerprint(identity),sourceCatalogHash:h,fixtureHash:h,endpointHash:h,controlsHash:h,probeCatalogHash:fingerprint(REQUIRED_CODEX_WINDOWS_PROBES),unitOrder:['metadata','strict-pair',...CAMPAIGN_EXECUTION_PROBE_ORDER],executionPlanHash:h,resourceLimits:policy.limits,coordinatorEnvelope:{actions:2,activeMs:100,outputBytes:100},issuedAt:1000,expiresAt:100000,approvalInstruction:'SIMULATED reviewed grant'});
 const current={sourceCatalogHash:h,fixtureHash:h,endpointHash:h,controlsHash:h};
 const options={now:()=>now,authorizeGrant:()=>accepted,current:()=>current,validateProposal:()=>true,administrativeGate:context=>administrativeFixture(context).load()};
 const journal=new CampaignAuthorizationJournal(campaign,options);
 const batch=()=>{const cleanup=randomUUID();return BatchApprovalSchema.parse({schemaVersion:3,id:randomUUID(),campaignId:id,owner,targetHash:identity.targetHash,fixtureHash:h,endpointHash:h,approvedAt:now,expiresAt:now+10000,remaining:{mode:'unlimited'},actions:[{id:randomUUID(),kind:'preparation',topLevel:true,launchHash:h,admissionHash:h,maxMs:100,maxOutputBytes:100,cleanupId:cleanup},{id:cleanup,kind:'cleanup',topLevel:false,launchHash:h,admissionHash:h,maxMs:100,maxOutputBytes:100}]});};
 return {store,campaign,owner,identity,target,grant,journal,options,current,batch,setNow:(n:number)=>{now=n;},deny:()=>{accepted=false;}};
}

it('represents unlimited explicitly while retaining finite counters and independent finite batch limits',async()=>{
 expect(remainingAllowance({mode:'unlimited'},{actions:5000,activeMs:90000000,outputBytes:2000000000},{actions:2,activeMs:100,outputBytes:20})).toEqual({mode:'unlimited'});
 expect(exceedsAllowance({actions:5000,activeMs:90000000,outputBytes:2000000000},{mode:'unlimited'})).toBe(false);
 expect(()=>remainingAllowance({mode:'unlimited'},{actions:Infinity,activeMs:0,outputBytes:0},{actions:0,activeMs:0,outputBytes:0})).toThrow();
 expect(()=>remainingAllowance({mode:'unlimited'},{actions:Number.MAX_SAFE_INTEGER,activeMs:0,outputBytes:0},{actions:1,activeMs:0,outputBytes:0})).toThrow('CAMPAIGN_COUNTER_OVERFLOW');
 const f=await fixture();expect(must(f.campaign.snapshot(f.identity.id)).remaining).toEqual({mode:'unlimited'});
 const b=f.batch();b.actions[0].maxMs=600000;expect(f.campaign.approve(b).ok).toBe(false);
 expect(campaignExecutionDeficits({actions:100000,activeMs:999999999,outputBytes:999999999},{mode:'unlimited'})).toEqual([]);
 expect(campaignExecutionDeficits({actions:2,activeMs:1001,outputBytes:5},{actions:4,activeMs:1000,outputBytes:100},'batch')).toHaveLength(1);
 const valid=f.batch();must(f.campaign.approve(valid));expect(must(f.campaign.snapshot(f.identity.id)).reserved).toEqual({actions:2,activeMs:200,outputBytes:200});
});
it('keeps legacy policy and batch interpretation bounded and rejects unlimited disguised as legacy',async()=>{
 const f=await fixture(),p={schemaVersion:1,...f.grant};delete (p as any).kind;
 expect(CampaignExecutionPolicySchema.safeParse({schemaVersion:1,kind:'human-execution-allowance',id:randomUUID(),campaignId:f.identity.id,owner:f.owner,storeRootHash:h,historyHash:h,targetHash:h,approvalInstruction:'legacy',limits:{campaignLimits:{actions:96,activeMs:2400000,outputBytes:10485760},batchLimits:{topLevelActions:4,activeMs:150000,outputBytes:262144,approvalTtlMs:600000},maxUnsuccessfulCorrections:2}}).success).toBe(true);
 const b=f.batch();expect(BatchApprovalSchema.safeParse({...b,schemaVersion:2}).success).toBe(false);
 expect(BatchApprovalSchema.safeParse({...b,schemaVersion:2,remaining:{actions:96,activeMs:2400000,outputBytes:10485760}}).success).toBe(true);
});
it('persists operation intent and refuses restart, replay, stale grants and changed identities before continuation',async()=>{
 const f=await fixture();f.journal.register(f.grant);const operation=f.journal.beginNext(f.grant);
 expect(operation.unitId).toBe('metadata');expect(must(f.store.listQualifications()).filter((r:any)=>r.kind==='CAMPAIGN_OPERATION')).toHaveLength(1);
 const restarted=new CampaignAuthorizationJournal(f.campaign,f.options);expect(()=>restarted.beginNext(f.grant)).toThrow('CAMPAIGN_INCOMPLETE_OPERATION');
 expect(()=>f.journal.register(f.grant)).toThrow('CAMPAIGN_GRANT_REPLAY');
 expect(()=>f.journal.settle(f.grant,{operationId:operation.operationId,batchId:randomUUID(),accountingId:randomUUID()})).toThrow('CAMPAIGN_SETTLEMENT_REQUIRES_NEW_ACCOUNTING');
 f.current.sourceCatalogHash='b'.repeat(64);expect(()=>restarted.beginNext(f.grant)).toThrow('CAMPAIGN_GRANT_CHANGED_OR_EXPIRED');f.current.sourceCatalogHash=h;
 f.setNow(f.grant.expiresAt);expect(()=>restarted.beginNext(f.grant)).toThrow('CAMPAIGN_GRANT_CHANGED_OR_EXPIRED');
});
it('refuses pending actions, untrusted grants and noncanonical order',async()=>{
 const f=await fixture();f.deny();expect(()=>f.journal.register(f.grant)).toThrow('CAMPAIGN_GRANT_CHANGED_OR_EXPIRED');
 const g=await fixture();must(g.store.intent(g.owner,{schemaVersion:1,id:randomUUID(),runId:g.owner.runId,kind:'PENDING_EXECUTION',payload:{}}));expect(()=>g.journal.register(g.grant)).toThrow('CAMPAIGN_CONTINUATION_NOT_TERMINAL');
 expect(CampaignAuthorizationSchema.safeParse({...g.grant,unitOrder:[...g.grant.unitOrder].reverse()}).success).toBe(false);
});
it('derives fresh exact-ledger authorization and invalidates it on history changes and expiry',async()=>{
 const f=await fixture();f.journal.register(f.grant);const o=f.journal.beginNext(f.grant),batch=f.batch();
 const proposal:any={unit:{id:'metadata'},planHash:h,runtime:{batch},deficits:[]};
 const derived=f.journal.derive(f.grant,o.operationId,proposal);expect(f.journal.authorizeDerived(f.grant,derived,proposal)).toBe(true);
 expect(f.journal.authorizeDerived(f.grant,derived,{...proposal,planHash:'b'.repeat(64)})).toBe(false);
 f.setNow(derived.expiresAt);expect(f.journal.authorizeDerived(f.grant,derived,proposal)).toBe(false);f.setNow(1000);
 must(f.campaign.approve(batch));expect(f.journal.authorizeDerived(f.grant,derived,proposal)).toBe(false);
});
it('continues only after the exact terminal batch and independently charged coordinator observation settle',async()=>{
 const f=await fixture(),before=must(f.campaign.snapshot(f.identity.id)).consumed;f.journal.register(f.grant);const o=f.journal.beginNext(f.grant),batch=f.batch();batch.actions[0].maxOutputBytes=10000;
 const proposal:any={unit:{id:'metadata'},planHash:h,runtime:{batch},deficits:[]};
 const derived=f.journal.derive(f.grant,o.operationId,proposal);expect(f.journal.authorizeDerived(f.grant,derived,proposal)).toBe(true);
 expect(()=>f.journal.derive(f.grant,o.operationId,proposal)).toThrow('CAMPAIGN_BATCH_AUTHORIZATION_REPLAY');
 must(f.campaign.approve(batch));
 async function pub(value:unknown,actionId:string|null=null){async function* data(){yield Buffer.from(JSON.stringify(value));}const ref=must(await publishArtifact(f.store,data(),{schemaVersion:1,id:randomUUID(),owner:f.owner,actionId,mediaType:'application/json',secrets:[]}));return {id:ref.id,sha256:ref.sha256};}
 const action=batch.actions[0],owner={runId:f.owner.runId,generation:f.owner.generation,actionId:action.id,role:'controller'},ownership={schemaVersion:1,...owner,environment:'windows',pid:100,creationIdentity:'root100',helperPid:101,helperCreationIdentity:'helper101',jobIdentity:'job',boundaryHash:h,assignedBeforeResume:true,capturedAt:1000};
 const drain={schemaVersion:1,...owner,reason:'finished',requestAcknowledged:true,requestedAt:1000,acknowledgedAt:1000,rootExited:true,rootExitedAt:1000,membershipEmpty:true,membershipObservedAt:1000,activeProcesses:0,unresolvedExecutions:[],outputComplete:true,unresolvedOutputStreams:[],outputCompletedAt:1000,childRanBeforeAssignment:false,completedAt:1000};
 const bound={fixtureHash:h,endpointHash:h,targetHash:f.identity.targetHash};must(f.campaign.dispatch(batch.id,action,bound));
 const terminal=await pub({schemaVersion:1,kind:'campaign-terminal-observation',targetHash:batch.targetHash,batchId:batch.id,actionId:action.id,launchHash:action.launchHash,resource:{kind:'owned-execution',ownership,drain,brokerInventory:{inventoryComplete:true,active:[],unresolved:[]}},processMeters:[{kind:'root',identity:{pid:100,creationIdentity:'root100'},activeMs:1},{kind:'helper',identity:{pid:101,creationIdentity:'helper101'},activeMs:1}],primaryOutputBytes:0,cleanupOutputBytes:0,rawOutputBytes:0,streamCounters:[],observedAt:1000},action.id);
 const primaryBytes=must(f.store.loadArtifact(terminal.id)).rawBytes;
 must(f.campaign.finish(batch.id,action.id,{elapsedMs:10,outputBytes:primaryBytes,status:'PASS',evidenceKind:'fixture',evidence:[{...terminal,category:'terminal-observation'}]}));
 const cleanup=batch.actions[1];must(f.campaign.dispatch(batch.id,cleanup,bound));must(f.campaign.finish(batch.id,cleanup.id,{elapsedMs:10,outputBytes:10,status:'PASS',evidenceKind:'fixture'}));
 const source=await pub({simulation:true}),observation=await pub({schemaVersion:2,kind:'campaign-preparation-observation',operationId:o.operationId,storeRootHash:fingerprint(f.store.root),category:'auxiliary-execution',scope:'SIMULATED complete exited outer coordinator',classificationEvidence:source,sourceEvidence:[source],exclusions:[],processes:[{createdAt:1000,completedAt:1050}],processTreeComplete:true,rawOutputBytes:20,outputComplete:true});
 const receipt={schemaVersion:2,kind:'campaign-accounting',id:randomUUID(),campaignId:f.identity.id,owner:f.owner,storeRootHash:fingerprint(f.store.root),historyHash:fingerprint(must(f.store.listQualifications())),targetHash:f.identity.targetHash,repairs:[],preparation:[observation],preparationComplete:true};
 const receiptRef=await pub(receipt);must(f.campaign.reconcileAccounting(f.identity.id,{owner:f.owner,evidence:receiptRef}));
 f.journal.settle(f.grant,{operationId:o.operationId,batchId:batch.id,accountingId:receipt.id});
 expect(f.journal.beginNext(f.grant).unitId).toBe('strict-pair');
 expect(must(f.campaign.snapshot(f.identity.id)).consumed).toEqual({actions:before.actions+3,activeMs:before.activeMs+70,outputBytes:before.outputBytes+primaryBytes+30});
});
it('requires canonical proposal authority and still counts the coordinator toward finite batch ceilings',async()=>{
 const f=await fixture();f.journal.register(f.grant);const o=f.journal.beginNext(f.grant),batch=f.batch(),proposal:any={unit:{id:'metadata'},planHash:h,runtime:{batch},deficits:[]};
 f.options.validateProposal=()=>false;expect(()=>f.journal.derive(f.grant,o.operationId,proposal)).toThrow('CAMPAIGN_PROPOSAL_NOT_CANONICAL');
 f.options.validateProposal=()=>true;batch.actions[0].maxMs=599850;expect(()=>f.journal.derive(f.grant,o.operationId,proposal)).toThrow('CAMPAIGN_DERIVATION_BATCH_LIMIT');
});
it('activates explicit qualification-only aggregate accounting while ordinary runs and artifact caps stay finite',async()=>{
 const f=await fixture();
 for(let i=0;i<110;i++)expect(must(f.store.reserveOutput(f.owner,null,1000000)).limit).toBe(null);
 expect(must(f.store.loadRun(f.owner.runId)).cumulativeBudgets.outputBytes).toBeGreaterThan(104857600);
 expect(f.store.intent(f.owner,{schemaVersion:1,id:randomUUID(),runId:f.owner.runId,kind:'WORKER_EXECUTION',payload:{}})).toMatchObject({ok:false,error:{code:'QUALIFICATION_ONLY_RUN_REQUIRED'}});
 const tooLarge=must(f.store.reserveOutput(f.owner,null,10485761));expect(tooLarge.acceptedBytes).toBe(10485760);expect(tooLarge.limit).toBe('ACTION_OUTPUT_LIMIT');
 const store=openStore(mkdtempSync(join(tmpdir(),'task7-ordinary-')));stores.push(store);const runId=randomUUID(),repoId=randomUUID();must(store.createRun(repoId,{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));const owner=must(store.claim(repoId,runId));
 expect(store.activateUnlimitedQualification(owner,randomUUID())).toMatchObject({ok:false,error:{code:'QUALIFICATION_POLICY_REQUIRED'}});
 expect(must(store.reserveOutput(owner,null,104857601)).limit).toBe('RUN_OUTPUT_LIMIT');
});

function catalogFixture(){
 const artifacts=new Map<string,Buffer>();const artifact=(value:string)=>{const b=Buffer.from(value),sha256=createHash('sha256').update(b).digest('hex'),id=randomUUID();artifacts.set(id,b);return {id,sha256};};
 const upstreamCommit='1'.repeat(40),runtime={path:'C:\\pinned\\codex.exe',version:'0.163.0',sha256:h};
 const source={commit:upstreamCommit,path:'codex-rs/source.rs',blobHash:'',artifact:artifact('actual stored source bytes'),consumer:'actual_consumer'};source.blobHash=source.artifact.sha256;
 const c=RuntimeSourceCatalogSchema.parse({schemaVersion:1,kind:'runtime-startup-source-catalog',runtime,observedVersion:'0.163.0',upstreamCommit,
  provenance:{repository:'https://github.com/openai/codex',releaseTag:'rust-v0.163.0',releaseUrl:'https://github.com/openai/codex/releases/tag/rust-v0.163.0',tagUrl:'https://api.github.com/repos/openai/codex/git/tags/'+'2'.repeat(40),releaseEvidence:artifact(JSON.stringify({tag_name:'rust-v0.163.0',html_url:'https://github.com/openai/codex/releases/tag/rust-v0.163.0',assets:[{name:'codex.exe.zip',digest:'sha256:'+h,size:100,browser_download_url:'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex.exe.zip'}]})),tagEvidence:artifact(JSON.stringify({object:{type:'commit',sha:upstreamCommit}})),archiveEvidence:artifact(JSON.stringify({schemaVersion:1,kind:'official-release-executable-comparison',releaseTag:'rust-v0.163.0',assetName:'codex.exe.zip',assetUrl:'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex.exe.zip',archiveSha256:h,archiveBytes:100,entry:'codex.exe',executableBytes:200,executableSha256:h,installedExecutableSha256:h,installedMatches:true})),archiveExecutableHash:h,versionEvidence:artifact('codex-cli 0.163.0\n')},sources:[source],
  routes:STARTUP_MONITOR_PATHS.flatMap(path=>STARTUP_SOURCES.flatMap(s=>(['bootstrap','thread-start'] as const).map(lifecycle=>({path,source:s,lifecycle,enforcement:'persistent-restriction',sourceEvidence:[source]})))),requirementsSources:STARTUP_SOURCES.map(s=>({source:s,sourceEvidence:[source]})),interpretations:STARTUP_MONITOR_PATHS.map(path=>({path,semantics:'SIMULATION of independently reviewed route semantics; no production acceptance.',sources:[source]}))});
 const target:any={schemaVersion:1,provider:'codex',environment:'windows',runtime,adapter:{version:'1',sha256:h},helper:{path:'C:\\pinned\\helper.exe',version:'1',sha256:h},verifier:{...runtime,wrapperHash:h},os:{platform:'win32',architecture:'x64',release:'fixture',sha256:h},policyHash:h,startupConfigHash:h,model:'fixture-model',effort:'high'};
 const input=()=>({catalog:c,target,acceptance:{schemaVersion:1 as const,kind:'accepted-runtime-source-catalog' as const,catalogHash:fingerprint(c),reviewDigest:h,accepted:true as const},readArtifact:(r:{id:string})=>{const b=artifacts.get(r.id);if(!b)throw Error('MISSING');return b;},authorizeReview:()=>true});
 return {c,artifacts,input};
}
it('requires explicit independent catalog acceptance, real byte hashes, complete routes and matching release provenance',()=>{
 const f=catalogFixture();expect(validateRuntimeSourceCatalog(f.input()).runtime.version).toBe('0.163.0');
 expect(()=>validateRuntimeSourceCatalog({...f.input(),authorizeReview:()=>false})).toThrow('RUNTIME_SOURCE_CATALOG_NOT_ACCEPTED');
 const bytes=f.artifacts.get(f.c.sources[0].artifact.id)!;f.artifacts.set(f.c.sources[0].artifact.id,Buffer.from('changed'));expect(()=>validateRuntimeSourceCatalog(f.input())).toThrow('RUNTIME_SOURCE_BYTES_CHANGED');f.artifacts.set(f.c.sources[0].artifact.id,bytes);
 f.c.routes.pop();expect(()=>validateRuntimeSourceCatalog(f.input())).toThrow('SOURCE_ROUTES_INCOMPLETE');
 const g=catalogFixture();g.c.upstreamCommit='3'.repeat(40);expect(()=>validateRuntimeSourceCatalog(g.input())).toThrow('RUNTIME_RELEASE_PROVENANCE_UNPROVEN');
 const fabricated=catalogFixture();const archive=fabricated.c.provenance.archiveEvidence,archiveBytes=JSON.parse(fabricated.artifacts.get(archive.id)!.toString('utf8'));archiveBytes.archiveSha256='b'.repeat(64);const fabricatedBytes=Buffer.from(JSON.stringify(archiveBytes));archive.sha256=createHash('sha256').update(fabricatedBytes).digest('hex');fabricated.artifacts.set(archive.id,fabricatedBytes);expect(()=>validateRuntimeSourceCatalog(fabricated.input())).toThrow('RUNTIME_ARCHIVE_COMPARISON_UNPROVEN');
 const j=catalogFixture();j.c.interpretations[0].semantics='UNREVIEWED copied historical semantics';expect(()=>validateRuntimeSourceCatalog(j.input())).toThrow('SOURCE_INTERPRETATION_UNREVIEWED');
});

it('preserves bounded legacy campaign authorization without the successor administrative gate',async()=>{
 const f=await fixture(true),journal=new CampaignAuthorizationJournal(f.campaign,{...f.options,administrativeGate:undefined});
 const {administration:_administration,...legacy}=f.grant;journal.register(legacy);expect(journal.beginNext(legacy).unitId).toBe('metadata');
});

it('refuses coordinator process-count mismatches and reserves coordinators within the top-level batch ceiling',async()=>{
 const f=await fixture();expect(CampaignAuthorizationSchema.safeParse({...f.grant,coordinatorEnvelope:{...f.grant.coordinatorEnvelope,actions:1}}).success).toBe(false);
 f.journal.register(f.grant);const o=f.journal.beginNext(f.grant),batch=f.batch();
 // Three live top-level actions plus the two coordinator processes exceed4.
 batch.actions.push(...Array.from({length:2},()=>({...batch.actions[0],id:randomUUID()})));
 const proposal:any={unit:{id:'metadata'},planHash:h,runtime:{batch},deficits:[]};
 expect(()=>f.journal.derive(f.grant,o.operationId,proposal)).toThrow('CAMPAIGN_DERIVATION_BATCH_LIMIT');
});
