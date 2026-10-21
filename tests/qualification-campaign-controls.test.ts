import {afterEach,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,type RunStore} from '../src/store/database.ts';
import {QualificationCampaign,type BatchApproval} from '../src/qualification/campaign.ts';
import {campaignRecipeHash,cleanupRecipeHash,type MetadataRecipe} from '../src/qualification/campaign-runner.ts';
import {createCampaignControls,createCampaignPhaseAdmission,type CampaignControlGrant,type ReviewedCampaignControls} from '../src/qualification/campaign-controls.ts';
import {CODEX_CONFIG_SCHEMA,buildCodexLaunchConfig,restrictedCodexOverrides,prevalidateCodexLaunchArgv} from '../src/providers/codex/launch-config.ts';
import {projectConfig,projectRequirements} from '../src/providers/codex/policy.ts';
import {assessPhaseAdmission,StartupIntentSchema,type StartupIntent} from '../src/qualification/codex-startup-authority.ts';
import {fingerprint} from '../src/qualification/probes.ts';
import {targetFingerprint,type QualificationTarget} from '../src/qualification/ledger.ts';
import {approval,startupContext} from './helpers/codex-admission.ts';
const stores:RunStore[]=[];afterEach(()=>{for(const store of stores.splice(0))store.close();});
const must=(r:any):any=>{if(!r.ok)throw Error(r.error.code);return r.value;};
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function fixture(worker=false){
 const store=openStore(mkdtempSync(join(tmpdir(),'ouroboros-campaign-controls-')));stores.push(store);const repoId=randomUUID(),runId=randomUUID();must(store.createRun(repoId,{schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));const owner=must(store.claim(repoId,runId));
 let now=1001,active:CampaignControlGrant|undefined,controlsApi:ReturnType<typeof createCampaignControls>|undefined;
 const pins=new Map<string,Buffer>([['C:\\pinned\\codex.exe',Buffer.from('runtime')],[startupContext.helper.path,Buffer.from('helper')],[startupContext.node.path,Buffer.from('node')]]);
 const target:QualificationTarget={schemaVersion:1,provider:'codex',environment:'windows',runtime:{path:'C:\\pinned\\codex.exe',version:'0.162.1',sha256:sha(pins.get('C:\\pinned\\codex.exe')!)},adapter:{version:'1',sha256:startupContext.adapterHash},helper:{...startupContext.helper,version:'1',sha256:sha(pins.get(startupContext.helper.path)!)},verifier:{path:'C:\\pinned\\codex.exe',version:'0.162.1',sha256:sha(pins.get('C:\\pinned\\codex.exe')!),wrapperHash:startupContext.verifierHash},os:{platform:'win32',architecture:'x64',release:'test',sha256:startupContext.osCapabilitiesHash},policyHash:'a'.repeat(64),startupConfigHash:startupContext.configHash,model:'fixture-model',effort:'high'};
 const campaign=new QualificationCampaign(store,{now:()=>now,authorizeCurrent:(batch,action)=>controlsApi?.authorizeCurrent(batch,action)??false}),campaignId=randomUUID();must(campaign.create({schemaVersion:2,id:campaignId,owner,target,targetHash:targetFingerprint(target),controllerHash:startupContext.controllerHash,protocolHash:startupContext.protocolHash,driverHash:'a'.repeat(64),lineage:must(campaign.lineage(campaignId))}));
 const batch:BatchApproval={schemaVersion:2,id:randomUUID(),campaignId,owner,targetHash:targetFingerprint(target),fixtureHash:'b'.repeat(64),endpointHash:'c'.repeat(64),approvedAt:1000,expiresAt:30000,remaining:must(campaign.snapshot(campaignId)).remaining,actions:[]};
 const config=must(buildCodexLaunchConfig({entryPoint:worker?'worker':'metadata',schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name:'ouroboros_worker'},overrides:restrictedCodexOverrides({profileName:'ouroboros_worker',profile:{filesystem:{':minimal':'read','C:\\fixture\\workspace':'write'},network:{enabled:false,allow_local_binding:false,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains:{}}},defaultPermissions:true,model:target.model,effort:target.effort})}}));
 const actionId=randomUUID(),cleanupId=randomUUID();const intent:StartupIntent={schemaVersion:2,phase:'PRE_PROCESS',...startupContext,runtime:target.runtime as StartupIntent['runtime'],node:{...startupContext.node,sha256:sha(pins.get(startupContext.node.path)!)},helper:{path:target.helper.path,sha256:target.helper.sha256},environmentHash:sha('{}'),boundaryHash:'d'.repeat(64),argumentsHash:sha(JSON.stringify(config.argv)),profile:'ouroboros_worker',sandbox:'mxc',environmentKeys:[],issuedAt:1000,expiresAt:3000,owner:{runId,generation:owner.generation,actionId,role:'startup-metadata'},requestId:batch.id,workspace:'C:\\fixture\\workspace',configAncestry:['C:\\','C:\\fixture','C:\\fixture\\workspace'],authMode:'managed-chatgpt',action:'metadata',dispatchAuthorization:{kind:'qualification',requestId:batch.id,probeId:'auxiliary.metadata',fixtureRoots:['C:\\fixture']},dispatchHash:'e'.repeat(64),model:target.model,effort:target.effort,budget:{activeMs:2000,outputBytes:50000,cleanupMs:1000}};
 if(worker){intent.owner.role='worker';intent.action='worker-start';if(intent.dispatchAuthorization.kind==='qualification')intent.dispatchAuthorization.probeId='worker.subscription_request';}
 const recipe:any={kind:worker?'session':'metadata',actionId,...(worker?{probeId:'worker.subscription_request'}:{}),request:{intent,argv:config.argv,admissions:{},protectedInputs:{}}};intent.dispatchHash=campaignRecipeHash(recipe);
 const controls:ReviewedCampaignControls={schemaVersion:1,controlHash:intent.controlHash,boundaryHash:intent.boundaryHash,fixtureRoots:['C:\\fixture'],controls:(approval({intent},'BOOTSTRAP') as any).controls,pins:[...pins].map(([path,bytes])=>({path,sha256:sha(bytes)}))};
 const bootstrap=createCampaignPhaseAdmission(intent,controls,'BOOTSTRAP',now);const action={id:actionId,kind:worker?'probe' as const:'metadata' as const,...(worker?{probeId:'worker.subscription_request'}:{}),topLevel:true,launchHash:intent.dispatchHash,admissionHash:fingerprint(bootstrap),maxMs:4000,maxOutputBytes:50000,cleanupId};batch.actions.push(action,{id:cleanupId,kind:'cleanup',topLevel:false,launchHash:cleanupRecipeHash(batch.id,action),admissionHash:'f'.repeat(64),maxMs:1000,maxOutputBytes:10000});
 const launches=[{...intent.owner,executable:intent.runtime.path,argv:config.argv,cwd:intent.workspace,env:{},boundaryHash:intent.boundaryHash,authorization:intent.dispatchAuthorization,stdin:'pipe' as const,leaseTtlMs:10000,deadline:intent.expiresAt}];
 const grant:CampaignControlGrant={schemaVersion:1,batchHash:fingerprint(batch),controlsHash:fingerprint(controls),recipesHash:fingerprint([recipe]),launchesHash:fingerprint(launches),targetHash:batch.targetHash,fixtureHash:batch.fixtureHash,endpointHash:batch.endpointHash,issuedAt:1000,expiresAt:30000,limits:{actions:2,activeMs:5000,outputBytes:60000}};
 let current={targetHash:batch.targetHash,fixtureHash:batch.fixtureHash,endpointHash:batch.endpointHash};active=grant;
 const options={campaign,batch,controls,recipes:[recipe],launches,grant,currentGrant:()=>active,currentInputs:()=>current,now:()=>now,readPin:(path:string)=>pins.get(path)!};
 const api=()=>controlsApi??(controlsApi=createCampaignControls(options));
 return {store,owner,campaign,batch,recipe,intent,controls,options,grant,pins,launch:launches[0]!,bootstrap,api,approve:()=>must(campaign.approve(batch)),advance:(ms:number)=>now+=ms,revoke:()=>active=undefined,changeInputs:()=>current={...current,fixtureHash:'0'.repeat(64)},dispatch:()=>must(campaign.dispatch(batch.id,action,{...current,phase:{intent,admission:bootstrap}})),now:()=>now};
}
it('is inert and grants only the exact approved metadata launch and bootstrap',async()=>{
 const f=fixture(),api=f.api();expect(api.currentAdmission('BOOTSTRAP',f.intent,undefined,undefined)).toBeUndefined();f.approve();expect(api.currentAdmission('BOOTSTRAP',f.intent,undefined,undefined)).toEqual(f.bootstrap);expect(await api.authorizeLaunch(f.launch)).toBe(false);f.dispatch();expect(await api.authorizeLaunch(f.launch)).toBe(true);expect(await api.authorizeLaunch({...f.launch,argv:[...f.launch.argv,'--unreviewed']})).toBe(false);
});
it.each(['grant','inputs','pin','expiry','owner','intent','budget'])('refuses changed %s on the actual callback',async fault=>{
 const f=fixture(),api=f.api();f.approve();f.dispatch();let intent=f.intent;
 if(fault==='grant')f.revoke();if(fault==='inputs')f.changeInputs();if(fault==='pin')f.pins.set(f.intent.runtime.path,Buffer.from('changed'));if(fault==='expiry')f.advance(30000);if(fault==='owner')intent={...intent,owner:{...intent.owner,generation:intent.owner.generation+1}};if(fault==='intent')intent={...intent,controlHash:'0'.repeat(64)};if(fault==='budget')intent={...intent,budget:{...intent.budget,outputBytes:1}};
 expect(api.currentAdmission('BOOTSTRAP',intent,undefined,undefined)).toBeUndefined();if(!['owner','intent','budget'].includes(fault))expect(await api.authorizeLaunch(f.launch)).toBe(false);
});
it('binds later worker phases to dispatched ownership and fresh observations without granting verifier scope',()=>{
 const f=fixture(true),api=f.api();f.approve();const owned:any={schemaVersion:1,...f.intent.owner,environment:'windows',pid:10,creationIdentity:'root',helperPid:11,helperCreationIdentity:'helper',jobIdentity:'job',boundaryHash:f.intent.boundaryHash,assignedBeforeResume:true,capturedAt:1001};
 expect(api.currentAdmission('PRE_THREAD',f.intent,owned,'a'.repeat(64))).toBeUndefined();f.dispatch();const thread=api.currentAdmission('PRE_THREAD',f.intent,owned,'a'.repeat(64));expect(thread).toBeDefined();expect(assessPhaseAdmission(f.intent,thread,f.now(),'PRE_THREAD',owned,'a'.repeat(64))).toEqual({authorized:true});f.advance(1);
 const turn=api.currentAdmission('TURN',f.intent,owned,'b'.repeat(64));expect(turn).toMatchObject({issuedAt:f.now(),observationHash:'b'.repeat(64)});expect(api.currentAdmission('TURN',f.intent,{...owned,boundaryHash:'0'.repeat(64)},'b'.repeat(64))).toBeUndefined();expect(api.currentAdmission('TURN',f.intent,owned,undefined)).toBeUndefined();expect(api.currentAdmission('VERIFIER',f.intent,owned,'a'.repeat(64))).toBeUndefined();
});
it('rejects an unbound review package or raised numeric limits before permission callbacks exist',()=>{
 const f=fixture();expect(()=>createCampaignControls({...f.options,controls:{...f.controls,boundaryHash:'0'.repeat(64)}})).toThrow('EXACT_CONTROLLER_GRANT_REQUIRED');expect(()=>createCampaignControls({...f.options,grant:{...f.grant,limits:{...f.grant.limits,actions:1}}})).toThrow('CONTROLLER_LIMIT_OR_PIN_INVALID');
});
it('preserves its exact immutable review when the caller later mutates its package',()=>{
 const f=fixture(),api=f.api();f.approve();f.controls.controls[0]!.controlHash='0'.repeat(64);expect(api.currentAdmission('BOOTSTRAP',f.intent,undefined,undefined)).toEqual(f.bootstrap);
});
it('accepts a schema-normalized equivalent intent without changing its pinned bootstrap hash',()=>{
 const f=fixture(),api=f.api();f.approve();const intent=StartupIntentSchema.parse(f.intent);expect(api.currentAdmission('BOOTSTRAP',intent,undefined,undefined)).toBeDefined();
});
it('checks the current managed requirements through the production policy consumer',()=>{
 const f=fixture(true),requested=must(prevalidateCodexLaunchArgv({entryPoint:'worker',schema:CODEX_CONFIG_SCHEMA,argv:f.recipe.request.argv}));
 let policy={configuration:projectConfig({config:{...requested.configuration,mcp_servers:{}}}),requirements:projectRequirements({requirements:null})};const api=createCampaignControls({...f.options,currentPolicy:()=>policy});f.approve();expect(api.currentAdmission('BOOTSTRAP',f.intent,undefined,undefined)).toBeDefined();policy={...policy,requirements:{...policy.requirements,loginSafe:false}};expect(api.currentAdmission('BOOTSTRAP',f.intent,undefined,undefined)).toBeUndefined();
});
it('accepts reviewed persistent restrictions and refuses missing containment facts without inventing them',()=>{
 const f=fixture();for(const control of f.controls.controls){control.route='supported-restriction';control.evidenceHash='1'.repeat(64);control.persistent=true;}
 const bootstrap=createCampaignPhaseAdmission(f.intent,f.controls,'BOOTSTRAP',f.now());f.batch.actions[0]!.admissionHash=fingerprint(bootstrap);f.grant.controlsHash=fingerprint(f.controls);f.grant.batchHash=fingerprint(f.batch);const api=createCampaignControls(f.options);f.approve();expect(api.currentAdmission('BOOTSTRAP',f.intent,undefined,undefined)).toEqual(bootstrap);
 const broken=structuredClone(f.controls);broken.controls[0]!.route='contained-qualification';delete broken.controls[0]!.hostAccessBounded;expect(()=>createCampaignPhaseAdmission(f.intent,broken,'BOOTSTRAP',f.now())).toThrow('CONTROL_PHASE_REFUSED');
});
