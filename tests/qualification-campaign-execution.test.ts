import {createHash,randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import * as runtimeModule from '../src/qualification/campaign-runtime.ts';
import {createCampaignExecutionPlan,buildCampaignExecutionProposal,executeCampaignPlan,executeCampaignUnit,campaignExecutionLaunches,CAMPAIGN_EXECUTION_PROBE_ORDER,campaignExecutionDeficits,type CampaignExecutionPlanInput} from '../src/qualification/campaign-execution.ts';
import {composeCampaignRuntime} from '../src/qualification/campaign-runtime.ts';
import {campaignRecipeHash,cleanupRecipeHash} from '../src/qualification/campaign-runner.ts';
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

it('materializes all32 and both startup units into the concrete inert native constructors',()=>{
 const f=fixture(),before=fingerprint(f.input),plan=must(createCampaignExecutionPlan(f.input)),proposals:any[]=[],effects:string[]=[];
 expect(plan.units).toHaveLength(34);expect(plan.units.filter((unit:any)=>unit.kind==='probe').map((unit:any)=>unit.probeId)).toEqual(CAMPAIGN_EXECUTION_PROBE_ORDER);expect(new Set(CAMPAIGN_EXECUTION_PROBE_ORDER)).toEqual(new Set(REQUIRED_CODEX_WINDOWS_PROBES.map(probe=>probe.id)));
 for(const unit of plan.units){
  const proposal=must(buildCampaignExecutionProposal(plan,unit.id,f.context()));proposals.push(proposal);
  expect(proposal.deficits).toEqual([]);
  for(const recipe of proposal.recipes){const action=proposal.runtime.batch.actions.find((action:any)=>action.id===recipe.actionId);expect(action.launchHash).toBe(campaignRecipeHash(recipe));const cleanup=proposal.runtime.batch.actions.find((value:any)=>value.id===action.cleanupId);expect(cleanup.launchHash).toBe(cleanupRecipeHash(proposal.runtime.batch.id,action));if('request' in recipe){expect(recipe.request.intent.dispatchHash).toBe(action.launchHash);expect(recipe.request.admissions.BOOTSTRAP.intentHash).toBe(startupTargetHash(recipe.request.intent));expect(recipe.request.intent.environmentHash).toBe(jsonHash(f.input.env));}}
  const native=composeCampaignRuntime(proposal.runtime,{runner:{campaign:{store:{},snapshot:()=>({ok:true,value:f.snapshot})}} as any,currentAdmission:f.admit,authorizeLaunch:async()=>{effects.push('authorize');return false;},supervisorFactory:()=>{effects.push('supervisor');throw Error('must be inert');},fs:{readFile:async()=>{effects.push('read');throw Error('must be inert');},realpath:async(path:string)=>path,writeFile:async()=>{},appendFile:async()=>{}},pendingCharge:async()=>{effects.push('pending');throw Error('must be inert');}});
  expect(native.ok,`${unit.id}: ${JSON.stringify(native)}`).toBe(true);
 }
 const actual=proposals.flatMap(proposal=>proposal.runtime.batch.actions).reduce((value:any,action:any)=>({actions:value.actions+1,activeMs:value.activeMs+action.maxMs,outputBytes:value.outputBytes+action.maxOutputBytes}),{actions:0,activeMs:0,outputBytes:0});
 expect(plan.cost).toEqual(actual);expect(actual).toEqual({actions:120,activeMs:9010000,outputBytes:15400960});expect(effects).toEqual([]);expect(fingerprint(f.input)).toBe(before);
});
it('uses distinct strict actions, identical approved baseline, exactfoo negative argv hash, and separate cleanup',()=>{
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input)),proposal=must(buildCampaignExecutionProposal(plan,'strict-pair',f.context())),step=proposal.runtime.steps[0];
 expect(step.kind).toBe('strict');expect(step.positive.request.argv).toEqual(step.negative.request.argv);expect(step.negative.request.intent.argumentsHash).toBe(jsonHash([...step.negative.request.argv,'-c','foo="bar"']));expect(step.positive.actionId).not.toBe(step.negative.actionId);expect(proposal.runtime.batch.actions.filter((action:any)=>action.kind==='cleanup')).toHaveLength(2);
});
it.each(['controller.foreground_cancel','controller.detached_descendant_cancel','controller.controller_death','controller.helper_death','controller.pending_dispatch_cancel'])('generates complete charged observer/unrelated topology for %s',probeId=>{
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input)),proposal=must(buildCampaignExecutionProposal(plan,probeId,f.context())),unrelated=proposal.runtime.steps[0],observation=unrelated.steps[0];
 expect(unrelated.kind).toBe('unrelated');expect(observation.kind).toBe('observation');expect(observation.step.recipe.request.unrelatedActionId).toBe(unrelated.recipe.actionId);expect(observation.guardian.bindingHash).toBe(observation.controller.bindingHash);expect(proposal.runtime.batch.actions).toHaveLength(8);expect(proposal.cost.activeMs).toBe(482000);
 if(probeId==='controller.pending_dispatch_cancel'){const pending=observation.step.session.pending;expect(pending.actionId).toBe(observation.step.recipe.request.pendingActionId);expect(pending.parentActionId).toBe(observation.step.recipe.actionId);expect(pending.launchHash).toBe(fingerprint(pending.launch));expect(pending.launch.argv).toContain('foreground');}
});
it('reports original allowance deficits without erasing retained history or shortening any bound',()=>{
 const f=fixture();f.snapshot.executionLimits={campaignLimits:{actions:96,activeMs:2400000,outputBytes:10485760},batchLimits:{topLevelActions:4,activeMs:150000,outputBytes:262144,approvalTtlMs:600000},maxUnsuccessfulCorrections:2};f.snapshot.remaining={actions:55,activeMs:2061439,outputBytes:9926980};
 const plan=must(createCampaignExecutionPlan(f.input)),proposal=must(buildCampaignExecutionProposal(plan,'controller.foreground_cancel',f.context()));
 expect(campaignExecutionDeficits(plan.cost,f.snapshot.remaining)).toEqual([{scope:'campaign',resource:'actions',required:120,available:55,deficit:65},{scope:'campaign',resource:'activeMs',required:9010000,available:2061439,deficit:6948561},{scope:'campaign',resource:'outputBytes',required:15400960,available:9926980,deficit:5473980}]);
 expect(proposal.deficits).toContainEqual({scope:'batch',resource:'activeMs',required:482000,available:150000,deficit:332000});expect(plan.input.bounds.sessionLifetimeMs).toBe(60000);expect(plan.input.snapshot.consumed).toEqual(f.snapshot.consumed);
});
it.each(['missing-admission','wrong-owner','changed-target','changed-plan','coverage-missing','coverage-wrong-target'] as const)('fails closed for %s before native composition',fault=>{
 const f=fixture();if(fault==='coverage-missing')delete f.input.startup;const plan=must(createCampaignExecutionPlan(f.input)),context=f.context();
 if(fault==='missing-admission')context.currentAdmission=()=>undefined;if(fault==='wrong-owner')context.currentAdmission=(phase:any,intent:any)=>({...f.admit(phase,intent),owner:{...intent.owner,actionId:randomUUID()}});if(fault==='changed-target')context.snapshot={...f.snapshot,targetHash:'f'.repeat(64)};if(fault==='changed-plan'){const changed=structuredClone(plan);changed.cost.actions--;expect(buildCampaignExecutionProposal(changed,'metadata',context).ok).toBe(false);return;}if(fault==='coverage-wrong-target')context.startup={...f.input.startup!,coverage:{...f.input.startup!.coverage,targetHash:'0'.repeat(64)}};
 expect(buildCampaignExecutionProposal(plan,fault.startsWith('coverage')?'worker.unapproved_config_inactive':'metadata',context).ok).toBe(false);
});
it('leaves the durable store and native constructors untouched when external batch authority refuses',async()=>{
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input)),calls:string[]=[];
 const report=await executeCampaignPlan(plan,{campaign:{snapshot:()=>({ok:true,value:f.snapshot}),approve:()=>{calls.push('approve');return {ok:true,value:undefined};}} as any,currentAdmission:f.admit,authorizeLaunch:async()=>{calls.push('launch');return true;},authorizeBatch:async proposal=>{expect(Object.isFrozen(proposal)).toBe(true);calls.push('review');return false;},now:()=>1000,current:()=>({fixtureHash:h,endpointHash:h,targetHash:f.snapshot.targetHash}),pendingCharge:async()=>{throw Error('must not dispatch');}});
 expect(report).toMatchObject({status:'REFUSED',reason:'EXECUTION_BATCH_AUTHORITY_REFUSED',qualificationAccepted:false,completedUnits:[],probesExecuted:[]});expect(calls).toEqual(['review']);
});
it('does not bypass missing pending charged-dispatch authority or unknown accounting liabilities',async()=>{
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input)),calls:string[]=[];
 const options:any={campaign:{snapshot:()=>({ok:true,value:f.snapshot})},currentAdmission:f.admit,authorizeLaunch:async()=>true,authorizeBatch:async()=>{calls.push('review');return true;},now:()=>1000,current:()=>({fixtureHash:h,endpointHash:h,targetHash:f.snapshot.targetHash})};
 expect(await executeCampaignPlan(plan,options)).toMatchObject({status:'REFUSED',reason:'EXECUTION_EXTERNAL_AUTHORITY_REQUIRED'});
 f.snapshot.accountingPending=true;options.pendingCharge=async()=>{throw Error('must not dispatch');};expect(await executeCampaignPlan(plan,options)).toMatchObject({status:'REFUSED',reason:'CURRENT_TERMINAL_CAMPAIGN_REQUIRED'});expect(calls).toEqual([]);
});
it('stops immediately after a non-PASS native dispatch without catalog credit, retry, or acceptance',async()=>{
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input)),calls:string[]=[];
 const composed=vi.spyOn(runtimeModule,'composeCampaignRuntime').mockImplementation(()=>({ok:true,value:{steps:[],dispatch:async()=>{const first=calls.filter(call=>call==='dispatch').length===0;calls.push('dispatch');return {status:first?'PASS':'STOPPED',results:[{status:first?'PASS':'UNTESTED',reason:'SYNTHETIC_NATIVE_RESULT',unknown:!first,actualAttempt:first,catalogProbe:false,evidenceKind:'fixture',evidence:[]}]};}}}));
 try{
  const report=await executeCampaignPlan(plan,{campaign:{snapshot:()=>({ok:true,value:f.snapshot}),approve:()=>{calls.push('approve');return {ok:true,value:undefined};}} as any,currentAdmission:f.admit,authorizeLaunch:async()=>true,authorizeBatch:async proposal=>{calls.push(`review:${proposal.unit.id}`);return true;},now:()=>1000,current:()=>({fixtureHash:h,endpointHash:h,targetHash:f.snapshot.targetHash}),pendingCharge:async()=>{throw Error('must not dispatch');}});
  expect(report).toMatchObject({status:'STOPPED',reason:'EXECUTION_UNIT_STOPPED',completedUnits:['metadata'],probesExecuted:[],qualificationAccepted:false});expect(report.batches.map(batch=>batch.unitId)).toEqual(['metadata','strict-pair']);expect(calls).toEqual(['review:metadata','approve','dispatch','review:strict-pair','approve','dispatch']);
 }finally{composed.mockRestore();}
});
it('uses the reviewed prerequisite, verifier, worker, cancellation, boundary, and injection order',()=>{
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input)),ids=plan.units.map((unit:any)=>unit.id);
 expect(ids.slice(0,4)).toEqual(['metadata','strict-pair','verifier.allowed_command','verifier.denied_source_write']);
 expect(ids.slice(13,16)).toEqual(['worker.unapproved_config_inactive','worker.subscription_request','worker.correlated_lifecycle']);
 expect(ids.slice(16,21)).toEqual(['controller.foreground_cancel','controller.detached_descendant_cancel','controller.controller_death','controller.helper_death','controller.pending_dispatch_cancel']);
 expect(ids[21]).toBe('worker.allowed_edit');expect(ids.slice(-2)).toEqual(['controller.auth_stop','controller.quota_stop']);
});
it('materializes finite60second2MiB explicitly admitted sessions without changing policy allowances',()=>{
 const f=fixture();f.input.bounds.activeMs=60000;f.input.bounds.sessionOutputBytes=2097152;f.input.bounds.resourceOutputBytes=2097152;
 const plan=must(createCampaignExecutionPlan(f.input)),proposal=must(buildCampaignExecutionProposal(plan,'controller.foreground_cancel',f.context()));
 expect(plan.cost).toEqual({actions:120,activeMs:9010000,outputBytes:107151360});expect(proposal.deficits).toEqual([]);
 for(const recipe of proposal.recipes)if('request' in recipe){expect(recipe.request.intent.budget).toEqual({activeMs:60000,outputBytes:2097152,cleanupMs:15000});expect(recipe.request.admissions.BOOTSTRAP.budget).toEqual(recipe.request.intent.budget);}
 expect(f.snapshot.executionLimits.campaignLimits.outputBytes).toBe(1073741824);
});
it.each(['active-cap','output-cap','wrong-budget'] as const)('rejects %s at the actual qualification intent/admission schema',fault=>{
 const f=fixture();if(fault==='active-cap')f.input.bounds.activeMs=60001;if(fault==='output-cap')f.input.bounds.sessionOutputBytes=2097153;
 const plan=must(createCampaignExecutionPlan(f.input)),context=f.context();if(fault==='wrong-budget')context.currentAdmission=(phase:any,intent:any)=>({...f.admit(phase,intent),budget:{...intent.budget,outputBytes:intent.budget.outputBytes-1}});
 expect(buildCampaignExecutionProposal(plan,'metadata',context).ok).toBe(false);
});
it('lists exact strictnegative, endpoint, observer, unrelated, and contingent pending launch grants',()=>{
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input));
 const strict=must(buildCampaignExecutionProposal(plan,'strict-pair',f.context())),strictLaunches=must(campaignExecutionLaunches(strict));expect(strictLaunches.map((value:any)=>value.kind)).toEqual(['strict-positive','strict-negative']);expect(strictLaunches[1].spec.argv).toEqual([...strictLaunches[0].spec.argv,'-c','foo="bar"']);
 const network=must(buildCampaignExecutionProposal(plan,'verifier.denied_direct_tcp',f.context())),networkLaunches=must(campaignExecutionLaunches(network));expect(networkLaunches.map((value:any)=>value.kind)).toEqual(['endpoint','session']);expect(networkLaunches[0].spec).toEqual(network.runtime.steps[0].recipe.launch);
 const pending=must(buildCampaignExecutionProposal(plan,'controller.pending_dispatch_cancel',f.context())),launches=must(campaignExecutionLaunches(pending));expect(launches.map((value:any)=>value.kind)).toEqual(['metadata','guardian','controller','session','pending']);expect(launches.filter((value:any)=>value.contingent).map((value:any)=>value.kind)).toEqual(['pending']);
 const changed=structuredClone(strict);changed.runtime.steps[0].negative.request.intent.argumentsHash=h;expect(campaignExecutionLaunches(changed).ok).toBe(false);
});
it('executes one explicit terminal unit for review without rerunning earlier units or accepting caller PASS claims',async()=>{
 const f=fixture(),plan=must(createCampaignExecutionPlan(f.input)),calls:string[]=[];
 const composed=vi.spyOn(runtimeModule,'composeCampaignRuntime').mockImplementation(()=>({ok:true,value:{steps:[],dispatch:async()=>({status:'PASS',results:[{status:'PASS',reason:'SYNTHETIC_NATIVE_RESULT',unknown:false,actualAttempt:true,catalogProbe:false,evidenceKind:'fixture',evidence:[]}]})}}));
 try{
  const report=await executeCampaignUnit(plan,'strict-pair',{campaign:{snapshot:()=>({ok:true,value:f.snapshot}),approve:()=>{calls.push('approve');return {ok:true,value:undefined};}} as any,currentAdmission:f.admit,authorizeLaunch:async()=>true,authorizeBatch:async proposal=>{calls.push(`review:${proposal.unit.id}`);return true;},now:()=>1000,current:()=>({fixtureHash:h,endpointHash:h,targetHash:f.snapshot.targetHash})});
  expect(report).toMatchObject({status:'UNIT_EXECUTED',completedUnits:['strict-pair'],probesExecuted:[],qualificationAccepted:false});expect(calls).toEqual(['review:strict-pair','approve']);
 }finally{composed.mockRestore();}
});
