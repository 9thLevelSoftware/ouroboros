import {fixtureCodexControls} from './helpers/codex-controls.ts';
import {expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {projectConfig,projectRequirements} from '../src/providers/codex/policy.ts';
import {fingerprint} from '../src/qualification/probes.ts';
import {STARTUP_MONITOR_PATHS,type StartupSessionProof,type StartupLocalScope} from '../src/qualification/startup-evidence.ts';
import {STARTUP_SOURCES} from '../src/qualification/codex-startup-authority.ts';
import {startupContext} from './helpers/codex-admission.ts';
const loaded=await import('../src/qualification/startup-source-map.ts').catch(()=>({})) as any;
function fixture(){
 const h='a'.repeat(64),actionId=randomUUID(),runId=randomUUID(),sqliteHome='C:\\fixture\\runtime-state';
 const configuration=projectConfig({config:{model_provider:'openai',default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{plugins:false,hooks:false,apps:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:false,remote_control:false},notify:[],web_search:'disabled',mcp_servers:{},...fixtureCodexControls(),sqlite_home:sqliteHome}}),requirements=projectRequirements({requirements:null});
 const intent:any={schemaVersion:2,phase:'PRE_PROCESS',...startupContext,runtime:{path:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:h},requestId:randomUUID(),owner:{runId,generation:1,actionId,role:'startup-metadata'},workspace:'C:\\fixture\\workspace',configAncestry:['C:\\','C:\\fixture','C:\\fixture\\workspace'],environmentHash:h,boundaryHash:h,argumentsHash:h,profile:'ouroboros_worker',sandbox:'mxc',environmentKeys:[],issuedAt:1000,expiresAt:3000,authMode:'managed-chatgpt',action:'metadata',dispatchAuthorization:{kind:'qualification',requestId:randomUUID(),probeId:'auxiliary.metadata',fixtureRoots:['C:\\fixture']},dispatchHash:h,model:'fixture-model',effort:'high'};
 const ownership:any={schemaVersion:1,...intent.owner,environment:'windows',pid:10,creationIdentity:'root',helperPid:11,helperCreationIdentity:'helper',jobIdentity:'job',boundaryHash:h,assignedBeforeResume:true,capturedAt:1001};
 const proof:StartupSessionProof={schemaVersion:1,kind:'startup-session-proof',evidenceKind:'live',intent,status:'PASS',initialized:true,threadStarted:false,ownership,drain:{schemaVersion:1,...intent.owner,reason:'finished',requestAcknowledged:true,requestedAt:1010,acknowledgedAt:1010,rootExited:true,rootExitedAt:1010,membershipEmpty:true,membershipObservedAt:1010,activeProcesses:0,unresolvedExecutions:[],outputComplete:true,unresolvedOutputStreams:[],outputCompletedAt:1010,childRanBeforeAssignment:false,completedAt:1010},dispatches:[],policy:{configurationHash:fingerprint(configuration),requirementsHash:fingerprint(requirements),permissionsHash:configuration.selectedPermissionsHash!,shellEnvironmentPolicyHash:configuration.shellEnvironmentPolicyHash!,environmentHash:h,account:'chatgpt',provider:'openai',observedAt:1002}};
 const target:any={schemaVersion:1,provider:'codex',environment:'windows',runtime:intent.runtime,adapter:{version:'1',sha256:intent.adapterHash},helper:{...intent.helper,version:'1'},verifier:{...intent.runtime,wrapperHash:intent.verifierHash},os:{platform:'win32',architecture:'x64',release:'fixture',sha256:intent.osCapabilitiesHash},policyHash:h,startupConfigHash:intent.configHash,model:intent.model,effort:intent.effort};
 const scope:StartupLocalScope={schemaVersion:1,kind:'current-controller-reviewed-local-stdio-scope',targetHash:fingerprint(target),controllerHash:intent.controllerHash,protocolHash:intent.protocolHash,fixtureHash:h,environmentHash:h,controlHash:intent.controlHash,intentHash:fingerprint(intent),configuration,preparation:{actionId:randomUUID(),runId,generation:1,observedAt:1000,operation:'atomic-new-empty-directory',sqliteHomeHash:configuration.sqliteHomeHash!,initialEntries:[]},client:{name:`ouroboros-qualification-${actionId}`,transport:'stdio',environment:'local',threadMode:'new-only',reconfiguration:'none',remoteStartup:'resolve-persisted',allowedMethods:['initialize','initialized','account/read','config/read','configRequirements/read']}};
 const manifest=JSON.parse(readFileSync('.superpowers/sdd/2026-10-17-blocker-completion/upstream-source/manifest.json','utf8'));
 const sources=manifest.files.map((file:any)=>({path:file.path,blobHash:file.sha256,artifact:{id:randomUUID(),sha256:file.sha256}}));
 return {commit:manifest.commit,sources,proof,target,fixtureHash:h,scope,scopeEvidence:{id:randomUUID(),sha256:createHash('sha256').update(JSON.stringify(scope)).digest('hex')}};
}
it('builds exactly208 reviewable candidate routes from the pinned source gates without canaries or acceptance',()=>{
 expect(typeof loaded.buildPinnedStartupSourceMap).toBe('function');const input=fixture(),result=loaded.buildPinnedStartupSourceMap(input),manifest=result.manifest;
 expect(manifest.routes).toHaveLength(208);expect(manifest.requirementsSources).toHaveLength(8);expect(manifest.scopeEvidence).toEqual(input.scopeEvidence);expect(result.scope).toEqual(input.scope);
 expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThanOrEqual(262144);
 for(const path of STARTUP_MONITOR_PATHS)for(const source of STARTUP_SOURCES)for(const lifecycle of ['bootstrap','thread-start'])expect(manifest.routes.filter((route:any)=>route.path===path&&route.source===source&&route.lifecycle===lifecycle)).toHaveLength(1);
 expect(manifest.routes.filter((route:any)=>['browser-native','browser-cdp','computer'].includes(route.path)).every((route:any)=>route.enforcement==='inapplicable')).toBe(true);expect(manifest.routes.filter((route:any)=>!['browser-native','browser-cdp','computer'].includes(route.path)).every((route:any)=>route.enforcement==='persistent-restriction')).toBe(true);
 expect(JSON.stringify(result)).not.toContain('registered-canary');expect(result).not.toHaveProperty('acceptedClaims');expect(JSON.stringify(result)).not.toContain('CLOSED');
});
it.each(['commit','source','missing-source','scope','client','freshness','sqlite','simulation','artifact'])('refuses %s substitution without producing candidate closure claims',fault=>{
 expect(typeof loaded.buildPinnedStartupSourceMap).toBe('function');const input:any=fixture();if(fault==='commit')input.commit='0'.repeat(40);if(fault==='source')input.sources[0].blobHash='0'.repeat(64);if(fault==='missing-source')input.sources=input.sources.filter((source:any)=>source.path!=='codex-rs/hooks/src/engine/mod.rs');if(fault==='scope')input.scope.fixtureHash='0'.repeat(64);if(fault==='client')input.scope.client.allowedMethods.push('remoteControl/enable');if(fault==='freshness')input.scope.preparation.initialEntries.push('existing-state.sqlite');if(fault==='sqlite')input.scope.preparation.sqliteHomeHash='0'.repeat(64);if(fault==='simulation')input.proof.evidenceKind='simulation';if(fault==='artifact')input.sources[0].artifact.sha256='0'.repeat(64);
 expect(()=>loaded.buildPinnedStartupSourceMap(input)).toThrow();
});
it('pins actual retained Git bytes rather than relying on invented source names',()=>{
 expect(loaded.PINNED_STARTUP_SOURCE_COMMIT).toBe('092d3acd6bec3e3a14bdc7e7a2810ab628ab759d');for(const [path,sha] of Object.entries(loaded.PINNED_STARTUP_SOURCE_HASHES)){const bytes=readFileSync(join('.superpowers/sdd/2026-10-17-blocker-completion/upstream-source',path));expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);}
});
