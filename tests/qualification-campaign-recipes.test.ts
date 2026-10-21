import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { buildCampaignRecipe,CAMPAIGN_PROBE_ROUTES,type CampaignRecipeInput } from '../src/qualification/campaign-recipes.ts';
import { campaignRecipeHash } from '../src/qualification/campaign-runner.ts';
import { createFixedDriverManifestV2,createFixedVerifierBackend } from '../src/qualification/fixed-driver-backend.ts';
import { CODEX_CONFIG_SCHEMA,restrictedCodexOverrides } from '../src/providers/codex/launch-config.ts';
import { REQUIRED_CODEX_WINDOWS_PROBES,fingerprint } from '../src/qualification/probes.ts';
import { targetFingerprint,type QualificationTarget } from '../src/qualification/ledger.ts';
import { startupContext } from './helpers/codex-admission.ts';

const h='a'.repeat(64);
function input(probeId:string):CampaignRecipeInput{
 const verifier=probeId.startsWith('verifier.'),role=verifier?'verifier':'worker';
 const target:QualificationTarget={schemaVersion:1,provider:'codex',environment:'windows',runtime:{path:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:h},adapter:{version:'1',sha256:startupContext.adapterHash},helper:{...startupContext.helper,version:'1'},verifier:{path:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:h,wrapperHash:startupContext.verifierHash},os:{platform:'win32',architecture:'x64',release:'fixture',sha256:startupContext.osCapabilitiesHash},policyHash:h,startupConfigHash:startupContext.configHash,model:'fixture-model',effort:'high'};
 const requestId=randomUUID(),actionId=randomUUID();
 const profile={filesystem:{':minimal':'read','C:\\fixture\\workspace':'write','C:\\fixture\\source':'deny'},network:{enabled:false,allow_local_binding:false,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains:{}}};
 const manifest=createFixedDriverManifestV2({fixtureRoot:'C:\\fixture',targetHash:targetFingerprint(target),node:{path:startupContext.node.path,sha256:startupContext.node.sha256},driver:{path:'C:\\fixture\\driver\\campaign-boundary-driver.mjs',sha256:h},endpoint:{path:'C:\\fixture\\driver\\controlled-endpoint.mjs',sha256:h},wrapperHash:target.verifier.wrapperHash,networkPlan:{schemaVersion:1,proxy:{url:'http://127.0.0.1:18473',source:'documented-sandbox-managed',policyHash:h,provenanceHash:h},directTcp:{host:'192.0.2.1',port:18474}}});
 return {target,manifest,launch:{entryPoint:role,schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name:role==='worker'?'ouroboros_worker':'ouroboros_verifier'},overrides:restrictedCodexOverrides({profileName:role==='worker'?'ouroboros_worker':'ouroboros_verifier',profile,defaultPermissions:!verifier})}},request:{argv:[],admissions:{},protectedInputs:{source:h},unrelatedActionId:randomUUID(),pendingActionId:randomUUID(),intent:{schemaVersion:2,phase:'PRE_PROCESS',...startupContext,owner:{runId:randomUUID(),generation:1,actionId,role},requestId,workspace:'C:\\fixture\\workspace',configAncestry:['C:\\','C:\\fixture','C:\\fixture\\workspace'],runtime:target.runtime as CampaignRecipeInput['request']['intent']['runtime'],environmentHash:h,boundaryHash:h,argumentsHash:h,profile:role==='worker'?'ouroboros_worker':'ouroboros_verifier',sandbox:'mxc',environmentKeys:['SystemRoot'],issuedAt:1000,expiresAt:3000,authMode:'managed-chatgpt',action:verifier?'verifier':'worker-start',dispatchAuthorization:{kind:'qualification',requestId,probeId,fixtureRoots:['C:\\fixture']},dispatchHash:h,model:target.model,effort:target.effort}}};
}
const build=(probeId:string,options=input(probeId))=>{const result=buildCampaignRecipe(probeId,options);expect(result.ok,JSON.stringify(result)).toBe(true);if(!result.ok)throw Error(result.error.code);return result.value;};

it('maps exactly 32 independent production routes and their correct roles',()=>{
 expect(CAMPAIGN_PROBE_ROUTES).toHaveLength(32);
 expect(new Set(CAMPAIGN_PROBE_ROUTES.map(route=>route.probeId)).size).toBe(32);
 expect(CAMPAIGN_PROBE_ROUTES.map(route=>({id:route.probeId,role:route.role})).sort((a,b)=>a.id.localeCompare(b.id))).toEqual(REQUIRED_CODEX_WINDOWS_PROBES.map(probe=>({id:probe.id,role:probe.role})).sort((a,b)=>a.id.localeCompare(b.id)));
 for(const definition of REQUIRED_CODEX_WINDOWS_PROBES){const recipe=build(definition.id);expect(recipe.request.intent.dispatchHash).toBe(campaignRecipeHash(recipe));expect(recipe.request.admissions).toEqual({});expect(recipe.actionId).toBe(recipe.request.intent.owner.actionId);}
});
it('constructs the exact concrete verifier backend argv including its neutral channel',()=>{
 const options=input('verifier.allowed_command'),recipe=build('verifier.allowed_command',options);if(recipe.kind!=='fixed')throw Error('fixed expected');
 const separator=recipe.request.argv.indexOf('--'),intent=recipe.request.intent;
 const backend=createFixedVerifierBackend({manifest:options.manifest!,request:recipe.boundary,supervisorFor:()=>{throw Error('must not launch');},readResource:async()=>{throw Error('must not read');},launch:{...intent.owner,executable:intent.runtime.path,argvPrefix:recipe.request.argv.slice(0,separator+1),cwd:intent.workspace,env:{},boundaryHash:intent.boundaryHash,authorization:intent.dispatchAuthorization,leaseTtlMs:1000,deadline:intent.expiresAt}});
 expect(backend.argv).toEqual(recipe.request.argv);expect(recipe.channel).toEqual({resourceHash:options.manifest!.driver.sha256});
});
it.each(['target','role','manifest','rehashed-command','model','command','legacy','unrelated','pending'] as const)('refuses %s substitution without changing the caller input',fault=>{
 const probeId=fault==='pending'?'controller.pending_dispatch_cancel':fault==='unrelated'?'controller.foreground_cancel':'verifier.allowed_command',options=input(probeId);
 if(fault==='target')options.target.helper.sha256='0'.repeat(64);
 if(fault==='role')options.request.intent.owner.role='worker';
 if(fault==='manifest')options.manifest={...options.manifest!,driver:{...options.manifest!.driver,sha256:'0'.repeat(64)}};
 if(fault==='rehashed-command'){options.manifest=structuredClone(options.manifest!);options.manifest.commands[0].argvPrefix=['C:\\untrusted.mjs'];const {identityHash:_old,...body}=options.manifest;options.manifest.identityHash=fingerprint(body);}
 if(fault==='model')options.launch.baseline.overrides=[...options.launch.baseline.overrides,{key:'model',value:'wrong-model'}];
 if(fault==='command')options.launch.verifier={cwd:'C:\\fixture',command:['untrusted']};
 if(fault==='unrelated')delete options.request.unrelatedActionId;
 if(fault==='pending')options.request.pendingActionId=options.request.intent.owner.actionId;
 const before=fingerprint(options);expect(buildCampaignRecipe(fault==='legacy'?'verifier.not_supported':probeId,options).ok).toBe(false);expect(fingerprint(options)).toBe(before);
});
