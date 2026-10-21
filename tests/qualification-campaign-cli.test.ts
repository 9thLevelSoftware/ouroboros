import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {main} from '../src/cli/main.ts';
import {createCampaignExecutionCli,createCampaignCliPlan,type CampaignCliHumanGrant} from '../src/qualification/campaign-cli.ts';
import {createCampaignExecutionPlan,buildCampaignExecutionProposal} from '../src/qualification/campaign-execution.ts';
import * as executionModule from '../src/qualification/campaign-execution.ts';
import {QualificationCampaign} from '../src/qualification/campaign.ts';
import {createFixedDriverManifestV2} from '../src/qualification/fixed-driver-backend.ts';
import {restrictedCodexOverrides,CODEX_CONFIG_SCHEMA} from '../src/providers/codex/launch-config.ts';
import {REQUIRED_CODEX_WINDOWS_PROBES,fingerprint} from '../src/qualification/probes.ts';
import {targetFingerprint} from '../src/qualification/ledger.ts';
import {STARTUP_SOURCES,startupTargetHash} from '../src/qualification/codex-startup-authority.ts';
import {INACTIVITY_PATHS} from '../src/qualification/session-drivers.ts';
import {approval,startupContext} from './helpers/codex-admission.ts';
const h='a'.repeat(64),jsonHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const must=(result:any):any=>{if(!result.ok)throw Error(result.error.code);return result.value;};
function fixture(){
 const runId=randomUUID(),root='D:\\disposable\\campaign',node=startupContext.node,env={TEMP:'D:\\private\\temp',SystemRoot:'C:\\Windows'};
 const target:any={schemaVersion:1,provider:'codex',environment:'windows',runtime:{path:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:h},adapter:{version:'1',sha256:startupContext.adapterHash},helper:{...startupContext.helper,version:'1'},verifier:{path:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:h,wrapperHash:startupContext.verifierHash},os:{platform:'win32',architecture:'x64',release:'fixture',sha256:startupContext.osCapabilitiesHash},policyHash:h,startupConfigHash:startupContext.configHash,model:'fixture-model',effort:'high'};
 const targetHash=targetFingerprint(target),pin=(path:string)=>({path,sha256:h});
 const resources={boundaryDriver:pin(root+'\\trusted-driver\\campaign-boundary-driver.mjs'),endpoint:pin(root+'\\trusted-driver\\controlled-endpoint.mjs'),activityDriver:pin(root+'\\trusted-driver\\session-activity.mjs')};
 const networkPlan:any={schemaVersion:1,proxy:{url:'http://127.0.0.1:18473',source:'documented-sandbox-managed',policyHash:h,provenanceHash:h},directTcp:{host:'192.0.2.1',port:18474}};
 const manifest=createFixedDriverManifestV2({fixtureRoot:root,targetHash,node:{path:node.path,sha256:node.sha256},driver:resources.boundaryDriver,endpoint:resources.endpoint,wrapperHash:target.verifier.wrapperHash,networkPlan});
 const profiles:any={networkDenied:{filesystem:{':minimal':'read',[root+'\\workspace']:'write'},network:{enabled:false,allow_local_binding:false,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains:{}}},networkBoundary:{filesystem:{':minimal':'read',[root+'\\workspace']:'write'},network:{enabled:true,allow_local_binding:true,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains:{localhost:'allow','127.0.0.1':'deny'},proxy_url:networkPlan.proxy.url,enable_socks5:false,enable_socks5_udp:false}}};
 const prepared:any={schemaVersion:2,fixtureRoot:root,targetHash,manifest,roots:{workspace:root+'\\workspace',source:root+'\\source',controllerSentinel:root+'\\controller-sentinel',sibling:root+'\\sibling',fakeCredential:root+'\\fake-credential',driver:root+'\\trusted-driver',registrations:root+'\\registrations',canaries:root+'\\canaries',state:root+'\\runtime-state'},resources,protectedFiles:{source:root+'\\source\\sentinel.txt'},protectedInputs:{source:h},escapeLinks:{},startupAssets:INACTIVITY_PATHS.map(path=>({path,sentinel:root+`\\canaries\\${path}.log`,baselineHash:h,activation:{executable:node.path,argv:[]}})),profiles,probeProfiles:Object.fromEntries(REQUIRED_CODEX_WINDOWS_PROBES.map(probe=>[probe.id,['allowed_proxy_network','denied_network','denied_direct_tcp'].some(suffix=>probe.id.endsWith(`.${suffix}`))?'networkBoundary':'networkDenied'])),preparation:{processesStarted:0,servicesStarted:false,hostCredentialsRead:false,linksCreatedOutsideSandbox:true}};
 const owner:any={schemaVersion:1,repoId:randomUUID(),runId,generation:1,nonce:randomUUID()},identity:any={schemaVersion:2,id:randomUUID(),owner,target,targetHash,controllerHash:startupContext.controllerHash,protocolHash:startupContext.protocolHash,driverHash:h,lineage:{storeRootHash:h,historyHash:h,rootId:randomUUID()}};
 const snapshot:any={identity,target,targetHash,executionLimits:{campaignLimits:{actions:1024,activeMs:86400000,outputBytes:1073741824},batchLimits:{topLevelActions:4,activeMs:600000,outputBytes:67108864,approvalTtlMs:600000},maxUnsuccessfulCorrections:8},consumed:{actions:41,activeMs:338561,outputBytes:558780},reserved:{actions:0,activeMs:0,outputBytes:0},remaining:{actions:983,activeMs:86061439,outputBytes:1073183044},historicalFailures:[],continuedFailureIds:[],outstandingFailureIds:[],targetHash,fenced:false,superseded:false,reconciliationRequired:false,accountingPending:false,correctionRequired:false,correctionUsage:0,unsuccessfulCorrections:0,accountingAdjustmentIds:[]};
 const launches:any=Object.fromEntries((['worker','verifier'] as const).map(role=>[role,Object.fromEntries((['networkDenied','networkBoundary'] as const).map(profile=>[profile,{entryPoint:role,schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name:`ouroboros_${role}`},overrides:restrictedCodexOverrides({profileName:`ouroboros_${role}`,profile:profiles[profile],defaultPermissions:role==='worker',model:target.model,effort:target.effort,networkProxy:profile==='networkBoundary'})}}]))]));
 const source={commit:'1'.repeat(40),path:'codex-rs/source.rs',blobHash:h,artifact:{id:randomUUID(),sha256:h},consumer:'source::consumer'};
 const coverage:any={schemaVersion:1,ruleVersion:'startup-closure-v1',kind:'startup-coverage',targetHash,scope:'headless-local-stdio-new-thread',controllerHash:identity.controllerHash,protocolHash:identity.protocolHash,controlHash:startupContext.controlHash,environmentHash:jsonHash(env),fixtureHash:h,expectedPolicy:{configurationHash:h,requirementsHash:h,permissionsHash:h,environmentHash:jsonHash(env),shellEnvironmentPolicyHash:h,account:'chatgpt',provider:'openai'},routes:INACTIVITY_PATHS.flatMap(path=>STARTUP_SOURCES.flatMap(sourceName=>(['bootstrap','thread-start'] as const).map(lifecycle=>({path,source:sourceName,lifecycle,enforcement:'persistent-restriction',sourceEvidence:[source]})))),exclusions:['thread-resume','reload','desktop-client','remote-client'],boundaryEvidence:[]};
 const input:CampaignExecutionPlanInput={snapshot,prepared,node,env,boundaryHash:h,controlHash:startupContext.controlHash,fixtureHash:h,endpointHash:h,launches,startup:{coverage,canaries:[]},observer:{entryPoint:pin('D:\\repo\\tests\\fixtures\\boundary\\disposable-controller.mjs'),module:pin('D:\\repo\\src\\qualification\\disposable-controller.ts'),dependencies:['src/runtime/supervisor.ts','src/runtime/qualification-observer.ts','src/contracts/execution.ts','src/contracts/qualification-observation.ts','src/contracts/common.ts','package.json','package-lock.json'].map(path=>pin('D:\\repo\\'+path.replaceAll('/','\\')))},bounds:{sessionLifetimeMs:60000,activeMs:30000,sessionOutputBytes:262144,resourceLifetimeMs:60000,resourceOutputBytes:262144,observerOutputBytes:131072,cleanupMs:15000,cleanupOutputBytes:16384}};
 const admit:any=(phase:any,intent:any,owned:any,observationHash:any)=>{const value=approval({intent,ownership:owned,observationHash},phase);for(const control of value.controls)control.lifecycle=['bootstrap','thread-start','thread-resume','verifier'];return value;};
 const context=()=>({snapshot,now:1000,batchId:randomUUID(),controllerExecutionId:randomUUID(),currentAdmission:admit});
 return {input,snapshot,admit,context};
}

function cliFixture(){
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input)),draft=must(buildCampaignExecutionProposal(plan,'metadata',f.context())),admission=draft.recipes[0].request.admissions.BOOTSTRAP;
 const grant:CampaignCliHumanGrant={schemaVersion:1,kind:'human-campaign-cli-grant',executionPlanHash:plan.planHash,campaignId:f.snapshot.identity.id,owner:f.snapshot.identity.owner,targetHash:f.snapshot.targetHash,fixtureHash:h,endpointHash:h,storeRoot:`D:\\absent-campaign-${randomUUID()}`,selectedUnitIds:['metadata','strict-pair'],issuedAt:1000,expiresAt:601000,limits:{actions:32,activeMs:1000000,outputBytes:16777216},coordinatorEnvelope:{actions:1,activeMs:180000,outputBytes:1048576},controls:{schemaVersion:1,controlHash:f.input.controlHash,boundaryHash:h,fixtureRoots:[plan.input.prepared.fixtureRoot],controls:admission.controls,pins:[{path:f.input.node.path,sha256:f.input.node.sha256},{path:f.snapshot.target.runtime.path,sha256:f.snapshot.target.runtime.sha256},{path:f.snapshot.target.helper.path,sha256:f.snapshot.target.helper.sha256}]}};
 const envelope=createCampaignCliPlan(plan,grant);return {...f,plan,grant,envelope};
}
it('default dryrun reads the actual selected JSON file without creating the absent store or launching',async()=>{
 const f=cliFixture(),directory=mkdtempSync(join(tmpdir(),'campaign-cli-dry-')),path=join(directory,'plan.json');writeFileSync(path,JSON.stringify(f.envelope));expect(existsSync(f.grant.storeRoot)).toBe(false);
 const report=await createCampaignExecutionCli({now:()=>1000})({planFile:path,unit:'metadata'});
 expect(report).toMatchObject({mode:'proposal',launched:false,approvalHash:f.envelope.approvalHash,unit:'metadata',qualificationAccepted:false,totalReservedCost:{actions:3,activeMs:345000,outputBytes:1327104}});expect(report.proposal?.runtime.steps[0].kind).toBe('metadata');expect(report.launches?.ok).toBe(true);expect(existsSync(f.grant.storeRoot)).toBe(false);
});
it('refuses an uninitialized existing SQLite file without creating migrations, ownership, or campaign records',async()=>{
 const f=cliFixture(),root=mkdtempSync(join(tmpdir(),'campaign-cli-uninitialized-'));mkdirSync(join(root,'artifacts'));mkdirSync(join(root,'temporary'));writeFileSync(join(root,'store.sqlite'),Buffer.alloc(0));
 const before=readFileSync(join(root,'store.sqlite')),envelope=createCampaignCliPlan(f.plan,{...f.grant,storeRoot:root});
 await expect(createCampaignExecutionCli({readPlanFile:()=>envelope,now:()=>1000})({planFile:'plan.json',unit:'metadata',approvePlan:envelope.approvalHash})).rejects.toThrow();expect(readFileSync(join(root,'store.sqlite'))).toEqual(before);
});
it.each(['approval-hash','changed-controls','changed-target','unselected-unit','expired-grant'] as const)('refuses %s before opening a store or dispatching',async fault=>{
 const f=cliFixture(),raw=structuredClone(f.envelope),open=vi.fn(()=>{throw Error('must not open');});let approve=f.envelope.approvalHash,unit='metadata',at=1000;
 if(fault==='approval-hash')approve='0'.repeat(64);if(fault==='changed-controls')raw.grant.controls.pins[0].sha256='f'.repeat(64);if(fault==='changed-target')raw.grant.targetHash='f'.repeat(64);if(fault==='unselected-unit')unit='worker.allowed_edit';if(fault==='expired-grant')at=raw.grant.expiresAt;
 await expect(createCampaignExecutionCli({readPlanFile:()=>raw,openExistingStore:open,now:()=>at})({planFile:'plan.json',unit,approvePlan:approve})).rejects.toThrow();expect(open).not.toHaveBeenCalled();
});
it('fences the exact preexisting owner and closes without claiming, releasing, or executing after stale ownership',async()=>{
 const f=cliFixture(),calls:string[]=[],store:any={reserveOutput:(owner:any,actionId:any,bytes:any)=>{calls.push('fence');expect(owner).toEqual(f.grant.owner);expect(actionId).toBeNull();expect(bytes).toBe(0);return {ok:false,error:{code:'STALE_OWNER',message:'stale',evidenceIds:[]}};},close:()=>calls.push('close')};
 await expect(createCampaignExecutionCli({readPlanFile:()=>f.envelope,openExistingStore:()=>store,now:()=>1000})({planFile:'plan.json',unit:'metadata',approvePlan:f.envelope.approvalHash})).rejects.toThrow('STALE_OWNER');expect(calls).toEqual(['fence','close']);
});
it('constructs exact production controls only after approved fresh proposal and reports externally pending coordinator accounting',async()=>{
 const f=cliFixture(),calls:string[]=[],usage:any[]=[];let loads=0;
 const snapshot=vi.spyOn(QualificationCampaign.prototype,'snapshot').mockReturnValue({ok:true,value:f.snapshot});
 const execute=vi.spyOn(executionModule,'executeCampaignUnit').mockImplementation(async(plan,unit,options)=>{
  expect(unit).toBe('metadata');const proposal=must(buildCampaignExecutionProposal(plan,unit,{snapshot:f.snapshot,now:1000,batchId:randomUUID(),controllerExecutionId:randomUUID(),currentAdmission:options.currentAdmission}));
  expect(await options.authorizeLaunch({} as any)).toBe(false);
  expect(await options.authorizeBatch({...proposal,planHash:'f'.repeat(64)})).toBe(false);
  expect(await options.authorizeBatch(proposal)).toBe(true);
  // Actual controls require durable approval and current source pins; neither
  // exists in this synthetic store, so they cannot grant a native launch.
  expect(options.currentAdmission('BOOTSTRAP',proposal.recipes[0].request.intent,undefined,undefined)).toBeUndefined();
  return {status:'UNIT_EXECUTED',planHash:plan.planHash,completedUnits:[unit],probesExecuted:[],batches:[{unitId:unit,batchId:proposal.runtime.batch.id,status:'PASS',evidenceIds:[]}],reason:'SYNTHETIC_UNIT',deficits:[],qualificationAccepted:false};
 });
 try{
  const store:any={reserveOutput:()=>{calls.push('fence');return {ok:true,value:{acceptedBytes:0,limit:null,diagnosticBytes:0}};},loadRun:()=>({ok:false,error:{code:'MISSING'}}),listQualifications:()=>({ok:true,value:[]}),close:()=>calls.push('close')};
  const report=await createCampaignExecutionCli({readPlanFile:()=>{loads++;return f.envelope;},openExistingStore:()=>store,now:()=>1000,recordCoordinatorUsage:value=>{usage.push(value);}})({planFile:'plan.json',unit:'metadata',approvePlan:f.envelope.approvalHash});
  expect(report).toMatchObject({mode:'execution',launched:true,execution:{status:'UNIT_EXECUTED'},qualificationAccepted:false,coordinatorAccounting:{complete:false,externalMeasurementRequired:true,rawOutputBytes:null,exitObserved:false,requireAccountingBeforeNextUnit:true}});expect(usage).toHaveLength(1);expect(loads).toBeGreaterThan(3);expect(calls).toEqual(['fence','close']);
 }finally{execute.mockRestore();snapshot.mockRestore();}
});
it('rejects a changed grant after the hash was checked and before opening the existing store',async()=>{
 const f=cliFixture(),open=vi.fn(()=>{throw Error('must not open');});let loads=0;
 const cli=createCampaignExecutionCli({now:()=>1000,readPlanFile:()=>{if(++loads===1)return f.envelope;const changed=structuredClone(f.envelope);changed.grant.selectedUnitIds.push('worker.allowed_edit');return changed;},openExistingStore:open});
 await expect(cli({planFile:'plan.json',unit:'metadata',approvePlan:f.envelope.approvalHash})).rejects.toThrow('CAMPAIGN_CLI_PLAN_CHANGED');expect(open).not.toHaveBeenCalled();
});
it('main exposes an inert dryrun and passes only the explicit selected plan, unit, and optional hash',async()=>{
 const calls:any[]=[],stdout:string[]=[],doctor:any={inspectVersion:async()=>{throw Error('must not launch');}};
 const code=await main(['doctor','--qualify-campaign','--unit','metadata','--plan-file','D:\\reviewed\\plan.json'],{doctor,stdout:value=>stdout.push(value),stderr:()=>{},campaignExecution:async request=>{calls.push(request);return {mode:'proposal',launched:false} as any;}});
 expect(code).toBe(0);expect(calls).toEqual([{planFile:'D:\\reviewed\\plan.json',unit:'metadata',approvePlan:null}]);expect(JSON.parse(stdout[0]).launched).toBe(false);
});
it.each([['--plan-file','file.json'],['--unit','metadata'],['--plan-file','file.json','--unit','metadata','--unit','other'],['--plan-file','file.json','--unit','metadata','--approve-plan','bad'],['--plan-file','file.json','--unit','metadata','--extra','value']])('main rejects malformed selectedcampaign arguments %j',async args=>{
 const run=vi.fn();expect(await main(['doctor','--qualify-campaign',...args],{doctor:{} as any,stdout:()=>{},stderr:()=>{},campaignExecution:run})).toBe(2);expect(run).not.toHaveBeenCalled();
});

