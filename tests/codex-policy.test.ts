import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { denyServerRequest, projectConfig, projectRequirements, checkControls, checkMetadataControls, subscriptionSourceAssessment, codexPermissionProfileHash, codexRequestedPermissionsHash, codexRequestedEnvironmentHash, compareCodexControlHashes, codexObservedPermissionsHash, codexObservedEnvironmentHash, isInformationalCodexNotification } from '../src/providers/codex/policy.ts';

const serdeControls=JSON.parse(readFileSync(new URL('./fixtures/codex/config-read-controls-0.162.1.json',import.meta.url),'utf8'));
const requestedPermissions=()=>({filesystem:{':minimal':'read','C:\\PRIVATE_WORK':'write','C:\\PRIVATE_DENIED':'deny'},network:{enabled:false,allow_local_binding:false,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains:{}}});
const requestedEnvironment=()=>({inherit:'none',ignore_default_excludes:false,exclude:[],set:{SystemRoot:'C:\\Windows',SystemDrive:'C:',WINDIR:'C:\\Windows',TEMP:'C:\\temp',TMP:'C:\\temp',USERPROFILE:'C:\\user',APPDATA:'C:\\appdata',LOCALAPPDATA:'C:\\local'},include_only:['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'],experimental_use_profile:false});
function observedPermissions(){const requested=requestedPermissions();return {...structuredClone(serdeControls.profile),filesystem:{...serdeControls.profile.filesystem,...requested.filesystem},network:{...serdeControls.profile.network,...requested.network}};}
describe('pinned expected control serialization',()=>{
  it('matches independent serde-shaped profile and shell observations without mutating requests',()=>{
    const profile=requestedPermissions(),environment=requestedEnvironment();const before=JSON.stringify({profile,environment});const observed=observedPermissions();
    expect(codexPermissionProfileHash(observed)).not.toBe(codexPermissionProfileHash(profile));expect(codexRequestedPermissionsHash(profile)).toBe(codexObservedPermissionsHash(observed));expect(codexRequestedEnvironmentHash(environment)).toBe(codexObservedEnvironmentHash({...serdeControls.shellEnvironmentPolicy,...environment}));expect(JSON.stringify({profile,environment})).toBe(before);expect(observed.filesystem['C:\\PRIVATE_DENIED']).toBe('deny');
  });
  it.each(['unknown-null','extends','workspace-roots','glob-depth','extra-root','access','removed-denial','missing-minimal','missing-network-restriction','network-enabled','domain','proxy','socket','socks','mitm','network-mode'])('retains observed permission difference %s',fault=>{
    const observed=observedPermissions();if(fault==='unknown-null')observed.future=null;if(fault==='extends')observed.extends='PRIVATE_PARENT';if(fault==='workspace-roots')observed.workspace_roots={'C:\\PRIVATE_EXTRA':true};if(fault==='description')observed.description='PRIVATE_DESCRIPTION';if(fault==='glob-depth')observed.filesystem.glob_scan_max_depth=5;if(fault==='extra-root')observed.filesystem['C:\\PRIVATE_EXTRA']='write';if(fault==='access')observed.filesystem['C:\\PRIVATE_DENIED']='read';if(fault==='removed-denial')delete observed.filesystem['C:\\PRIVATE_DENIED'];if(fault==='missing-minimal')delete observed.filesystem[':minimal'];if(fault==='missing-network-restriction')delete observed.network.allow_local_binding;if(fault==='network-enabled')observed.network.enabled=true;if(fault==='domain')observed.network.domains={'PRIVATE.example':'allow'};if(fault==='proxy')observed.network.proxy_url='https://PRIVATE.example';if(fault==='socket')observed.network.unix_sockets={'/PRIVATE':'allow'};if(fault==='socks')observed.network.enable_socks5=true;if(fault==='mitm')observed.network.mitm={};if(fault==='network-mode')observed.network.mode='full';
    const assessment=compareCodexControlHashes(codexRequestedPermissionsHash(requestedPermissions()),codexObservedPermissionsHash(observed));expect(assessment.result).not.toBe('MATCH');expect(JSON.stringify(assessment)).not.toContain('PRIVATE');
  });
  it.each(['unknown-null','filter','extra-set','missing-exclude','inherit','include','profile','default-excludes'])('retains observed environment difference %s',fault=>{
    const observed:any={...structuredClone(serdeControls.shellEnvironmentPolicy),...requestedEnvironment()};if(fault==='unknown-null')observed.future=null;if(fault==='filter')observed.filters={};if(fault==='extra-set')observed.set.NODE_OPTIONS='PRIVATE_PRELOAD';if(fault==='missing-exclude')delete observed.exclude;if(fault==='inherit')observed.inherit='all';if(fault==='include')observed.include_only.push('PRIVATE_EXTRA');if(fault==='profile')observed.experimental_use_profile=true;if(fault==='default-excludes')observed.ignore_default_excludes=true;
    const assessment=compareCodexControlHashes(codexRequestedEnvironmentHash(requestedEnvironment()),codexObservedEnvironmentHash(observed));expect(assessment.result).not.toBe('MATCH');expect(JSON.stringify(assessment)).not.toContain('PRIVATE');
  });
  it.each([undefined,null,{},[],{filesystem:{}},{...requestedPermissions(),future:null},{...requestedPermissions(),filesystem:{':minimal':'read','relative':'write'}},{...requestedPermissions(),network:{enabled:false}},{...requestedPermissions(),network:{...requestedPermissions().network,enabled:true}}])('invalid requested profile cannot equal an unavailable observed hash (%j)',profile=>{expect(codexRequestedPermissionsHash(profile)).toBeUndefined();expect(compareCodexControlHashes(codexRequestedPermissionsHash(profile),undefined).result).toBe('EXPECTED_INVALID');});
  it.each([undefined,null,{},[],{...requestedEnvironment(),filters:null},{...requestedEnvironment(),inherit:'all'},{...requestedEnvironment(),set:null},{...requestedEnvironment(),include_only:[]}])('invalid requested environment cannot equal an unavailable observed hash (%j)',environment=>{expect(codexRequestedEnvironmentHash(environment)).toBeUndefined();expect(compareCodexControlHashes(codexRequestedEnvironmentHash(environment),undefined).result).toBe('EXPECTED_INVALID');});
  it('requires valid expected and observed digests for a match',()=>{expect(compareCodexControlHashes(undefined,undefined).result).toBe('EXPECTED_INVALID');expect(compareCodexControlHashes('a'.repeat(64),undefined).result).toBe('OBSERVED_UNAVAILABLE');expect(compareCodexControlHashes('a'.repeat(64),'PRIVATE').result).toBe('OBSERVED_UNAVAILABLE');expect(compareCodexControlHashes('a'.repeat(64),'a'.repeat(64)).result).toBe('MATCH');});
});

const sourceConfig=():Record<string,unknown>=>({model_provider:'openai',forced_login_method:'chatgpt',chatgpt_base_url:'https://chatgpt.com/backend-api/',model_providers:{},default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{apps:false,hooks:false,plugins:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:false,remote_control:false},web_search:'disabled',mcp_servers:{}});
function assessSource(config:Record<string,unknown>,requirements:Record<string,unknown>){const c=projectConfig({config}),r=projectRequirements({requirements});return {config:c,requirements:r,assessment:subscriptionSourceAssessment(c,r),result:checkControls(c,r,'ouroboros_worker')};}
describe('pinned subscription endpoint projection',()=>{
  it.each([undefined,null,'https://chatgpt.com/backend-api/'])('allows only supported endpoint category %j in config and managed requirements',endpoint=>{
    const result=assessSource({...sourceConfig(),chatgpt_base_url:endpoint},{chatgptBaseUrl:endpoint,allowedLoginMethods:['chatgpt']});expect(result.result.ok).toBe(true);expect(result.assessment.rejections).toEqual([]);expect(result.assessment.configEndpoint).toBe(endpoint===undefined?'absent':endpoint===null?'null':'packaged-default');expect(result.assessment.requirementsEndpoint).toBe(result.assessment.configEndpoint);
  });
  it.each(['https://chatgpt.com/backend-api','http://chatgpt.com/backend-api/','https://chatgpt.com/backend-api/?PRIVATE_QUERY','https://chatgpt.com/backend-api/#PRIVATE_FRAGMENT','https://PRIVATE_USER@chatgpt.com/backend-api/','https://chatgpt.com.PRIVATE/backend-api/','https://PRIVATE.chatgpt.com/backend-api/','https://CHATGPT.com/backend-api/','https://chatgpt.com:443/backend-api/','https://chatgpt.com/backend-api/%2e','https://PRIVATE.example/','',false,42,{},[]])('rejects endpoint aliases and malformed values without retaining them (%j)',endpoint=>{
    for(const scope of ['config','requirements']){
      const result=assessSource({...sourceConfig(),...(scope==='config'?{chatgpt_base_url:endpoint}:{})},scope==='requirements'?{chatgptBaseUrl:endpoint}:{});expect(result.result).toMatchObject({ok:false,error:{code:'SUBSCRIPTION_SOURCE_UNSAFE'}});expect(result.assessment.rejections).toEqual([scope==='config'?'CONFIG_CHATGPT_ENDPOINT':'REQUIREMENTS_CHATGPT_ENDPOINT']);expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  });
  it.each(['api_key','base_url','wire_api','requires_openai_auth','env_key','experimental_bearer_token','http_headers','env_http_headers','auth'])('preserves configured and managed provider-definition refusal for %s',key=>{
    for(const scope of ['config','requirements']){
      const definition={openai:{[key]:key==='requires_openai_auth'?false:'PRIVATE_CREDENTIAL'}};const result=assessSource({...sourceConfig(),...(scope==='config'?{model_providers:definition}:{})},scope==='requirements'?{modelProviders:definition}:{});expect(result.result.ok).toBe(false);expect(result.assessment.rejections).toEqual([scope==='config'?'CONFIG_PROVIDER_DEFINITION':'REQUIREMENTS_PROVIDER_DEFINITION']);expect(JSON.stringify(result)).not.toContain('PRIVATE_CREDENTIAL');
    }
  });
  it.each([['config-provider',{model_provider:'PRIVATE_PROVIDER'},{},'CONFIG_PROVIDER_UNEXPECTED'],['unknown-provider',{model_provider:null},{},'CONFIG_PROVIDER_UNKNOWN'],['forced-api',{forced_login_method:'api'},{},'CONFIG_LOGIN_METHOD'],['managed-provider',{}, {modelProvider:'PRIVATE_PROVIDER'},'REQUIREMENTS_PROVIDER'],['api-only',{}, {allowedLoginMethods:['api']},'REQUIREMENTS_LOGIN_METHODS'],['duplicate-login',{}, {allowedLoginMethods:['chatgpt','chatgpt']},'REQUIREMENTS_LOGIN_METHODS'],['malformed-login',{}, {allowedLoginMethods:'PRIVATE_LOGIN'},'REQUIREMENTS_LOGIN_METHODS']])('preserves %s rejection with a finite reason',(_name,config,requirements,reason)=>{
    const result=assessSource({...sourceConfig(),...config as Record<string,unknown>},requirements as Record<string,unknown>);expect(result.result.ok).toBe(false);expect(result.assessment.rejections).toEqual([reason]);expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('Codex permission and credential policy', () => {
  it('accepts the exact serialized packaged ChatGPT endpoint default',()=>{
    const raw={model_provider:'openai',forced_login_method:'chatgpt',chatgpt_base_url:'https://chatgpt.com/backend-api/',model_providers:{},default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{apps:false,hooks:false,plugins:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:false,remote_control:false},web_search:'disabled',mcp_servers:{}};
    expect(checkControls(projectConfig({config:raw}),projectRequirements({requirements:{allowedLoginMethods:['chatgpt']}}),'ouroboros_worker')).toEqual({ok:true,value:undefined});
  });
  it('projects an order-independent exact effective profile hash without retaining permission paths',()=>{
    const profile=requestedPermissions();
    const project=(selected:unknown)=>projectConfig({config:{default_permissions:'ouroboros_worker',permissions:{ouroboros_worker:selected}}});
    const first=project(profile),second=project({network:{...profile.network},filesystem:Object.fromEntries(Object.entries(profile.filesystem).reverse())});
    expect(first.selectedPermissionsHash).toMatch(/^[a-f0-9]{64}$/);expect(first.selectedPermissionsHash).toBe(second.selectedPermissionsHash);
    expect(project({...profile,extends:'inherited'}).selectedPermissionsHash).not.toBe(first.selectedPermissionsHash);
    expect(project({...profile,filesystem:{...profile.filesystem,'C:\\extra':'write'}}).selectedPermissionsHash).not.toBe(first.selectedPermissionsHash);
    expect(projectConfig({config:{default_permissions:'ouroboros_worker'}}).selectedPermissionsHash).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain('PRIVATE');
  });
  it('honors managed approval-policy restrictions before opening a thread',()=>{
    const safe=projectConfig({config:{model_provider:'openai',default_permissions:'ouroboros_worker',approval_policy:'on-request',windows:{sandbox:'mxc'},features:{apps:false,hooks:false,plugins:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:false,remote_control:false},web_search:'disabled',mcp_servers:{}}});
    expect(checkControls(safe,projectRequirements({requirements:{allowedApprovalPolicies:['never']}}),'ouroboros_worker').ok).toBe(false);
    expect(checkControls(safe,projectRequirements({requirements:{allowedApprovalPolicies:['on-request']}}),'ouroboros_worker').ok).toBe(true);
  });
  it('rejects provider endpoint overrides and unknown managed login methods without retaining secrets',()=>{
    const overridden=projectConfig({config:{model_provider:'openai',model_providers:{openai:{base_url:'https://PRIVATE',requires_openai_auth:false}}}});
    expect(overridden.disallowedAuth).toBe(true);expect(JSON.stringify(overridden)).not.toContain('PRIVATE');
    expect(projectRequirements({requirements:{allowedLoginMethods:['chatgpt','futureMode']}}).loginSafe).toBe(false);
  });
  it('denies_unscoped_approval', () => {
    for (const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval']) {
      const approval = denyServerRequest({ id: 1, method, params: { threadId:'foreign', turnId:'foreign' } });
      expect(approval.decision).toBe('deny');
      expect(approval.response).toEqual({ id:1, result:{decision:'decline'} });
    }
    expect(denyServerRequest({id:2,method:'item/permissions/requestApproval',params:{}}).response)
      .toEqual({id:2,result:{permissions:{},scope:'turn'}});
    expect(denyServerRequest({id:3,method:'execCommandApproval',params:{}}).response)
      .toEqual({id:3,result:{decision:{denied:{rejection:'Controller policy denies escalation'}}}});
  });
  it('unknown_method_does_not_expand_permissions', () => {
    const approval=denyServerRequest({id:4,method:'new/permission/grant',params:{secret:'SENTINEL'}});
    expect(approval.decision).toBe('deny');
    expect(approval.response).toEqual({id:4,error:{code:-32601,message:'Unsupported server request'}});
    expect(JSON.stringify(approval)).not.toContain('SENTINEL');
  });
  it('projects_only_safe_metadata_without_retaining_nested_secrets', () => {
    const raw={config:{model_provider:'openai',default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{apps:false,hooks:false},web_search:'disabled',mcp_servers:{a:{enabled:false,env:{TOKEN:'SENTINEL'}}},model_providers:{openai:{experimental_bearer_token:'SENTINEL'}},instructions:'SENTINEL'},layers:[{config:{secret:'SENTINEL'}}],origins:{secret:'SENTINEL'}};
    const safe=projectConfig(raw);
    expect(safe.disallowedAuth).toBe(true);
    expect(safe.mcpDisabled).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
    const req=projectRequirements({requirements:{featureRequirements:{plugins:false,computer_use:false,browser_use:false},modelProviders:{openai:{http_headers:{Authorization:'SENTINEL'}}},additionalDeveloperInstructions:'SENTINEL'}});
    expect(req.disallowedAuth).toBe(true);expect(JSON.stringify(req)).not.toContain('SENTINEL');
    raw.config.features.apps=true;expect(safe.appsDisabled).toBe(true);
  });
  it('missing_managed_controls_or_enabled_mcp_fail_closed', () => {
    expect(checkControls(projectConfig({config:{}}),projectRequirements({requirements:null}),'ouroboros_worker').ok).toBe(false);
    const safe=projectConfig({config:{model_provider:'openai',default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{apps:false,hooks:false},web_search:'disabled',mcp_servers:{a:{enabled:true}}}});
    expect(checkControls(safe,projectRequirements({requirements:{featureRequirements:{plugins:false,browser_use:false,computer_use:false}}}),'ouroboros_worker').ok).toBe(false);
  });
  it('unknown_enabled_and_disabled_states_are_distinct_in_safe_fingerprints',()=>{
    const unknown=projectConfig({config:{}}),enabled=projectConfig({config:{features:{apps:true}}}),disabled=projectConfig({config:{features:{apps:false}}});
    expect(unknown.states.apps).toBe('unknown');expect(enabled.states.apps).toBe('enabled');expect(disabled.states.apps).toBe('disabled');expect(JSON.stringify(unknown)).not.toBe(JSON.stringify(disabled));
  });
});
describe('terminal metadata phase controls',()=>{
 const base=()=>({model_provider:'openai',default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{plugins:false,apps:false,hooks:false},web_search:'disabled',mcp_servers:{},notify:[]});
 it.each([undefined,null,true])('retains unknown desktop state and accepts metadata with browser permission %j while refusing workers',permission=>{
  const config=projectConfig({config:base()}),requirements=projectRequirements({requirements:{allowBrowserAndComputerUse:permission,allowRemoteControl:true}});
  expect(config.states.browser).toBe('unknown');expect(config.states.computer).toBe('unknown');expect(requirements.states.browserComputer).toBe(permission===true?'enabled':'unknown');
  expect(checkMetadataControls(config,requirements,'ouroboros_worker').ok).toBe(true);expect(checkControls(config,requirements,'ouroboros_worker').ok).toBe(false);
 });
 it.each(['plugins','managed-plugins','provider','notify','mcp','missing-plugins','profile','auth'])('still rejects the actual early metadata conflict %s',fault=>{
  const config:any=base(),requirements:any={};if(fault==='plugins')config.features.plugins=true;if(fault==='managed-plugins')requirements.featureRequirements={plugins:true};if(fault==='provider')config.model_provider='custom';if(fault==='notify')config.notify=['unapproved'];if(fault==='mcp')config.mcp_servers={unapproved:{enabled:true}};if(fault==='missing-plugins')delete config.features.plugins;if(fault==='profile')config.default_permissions='other';if(fault==='auth')config.model_providers={openai:{base_url:'https://unapproved.example'}};
  expect(checkMetadataControls(projectConfig({config}),projectRequirements({requirements}),'ouroboros_worker').ok).toBe(false);
 });
});

it('compares explicit controls across omitted Option fields and informational description additions',()=>{
  const requested=requestedPermissions();const compact={...requested,description:'future informational metadata'};
  expect(codexObservedPermissionsHash(compact)).toBe(codexRequestedPermissionsHash(requested));expect(codexObservedEnvironmentHash(requestedEnvironment())).toBe(codexRequestedEnvironmentHash(requestedEnvironment()));
  expect(codexObservedPermissionsHash({...compact,futurePermission:null})).toBeUndefined();expect(codexObservedPermissionsHash({...compact,extends:'unsafe-parent'})).toBeUndefined();
});
it.each([{},null,[],{requirements:[]},{requirements:42}])('missing or malformed requirements %j cannot become an empty safe observation',value=>{expect(()=>projectRequirements(value)).toThrow();});

it('informational notification classification is finite, structural, and bounded',()=>{expect(isInformationalCodexNotification('deprecationNotice',{summary:'safe',future:1})).toBe(true);expect(isInformationalCodexNotification('deprecationNotice',{summary:42})).toBe(false);expect(isInformationalCodexNotification('unknown/completed',{summary:'safe'})).toBe(false);expect(isInformationalCodexNotification('deprecationNotice',{summary:'x'.repeat(16385)})).toBe(false);});

function controlledNetworkProfile():Record<string,any>{
  const profile=requestedPermissions();return {...profile,network:{...profile.network,enabled:true,allow_local_binding:true,proxy_url:'http://127.0.0.1:18473',enable_socks5:false,enable_socks5_udp:false,domains:{localhost:'allow','127.0.0.1':'deny'}}};
}
it('projects an explicit controlled network profile without admitting it as an ordinary task request',()=>{
  const profile=controlledNetworkProfile(),observed=codexObservedPermissionsHash(profile);
  expect(observed).toMatch(/^[a-f0-9]{64}$/);expect(codexRequestedPermissionsHash(profile)).toBeUndefined();expect(observed).not.toBe(codexRequestedPermissionsHash(requestedPermissions()));
  const projection=projectConfig({config:{default_permissions:'ouroboros_worker',permissions:{ouroboros_worker:profile}}});expect(projection.selectedPermissionsHash).toBe(observed);
  expect(codexObservedPermissionsHash({...profile,network:{...profile.network,proxy_url:'http://127.0.0.1:18474'}})).not.toBe(observed);
  expect(codexObservedPermissionsHash({...profile,network:{...profile.network,domains:{localhost:'deny','127.0.0.1':'deny'}}})).not.toBe(observed);
  expect(JSON.stringify(projection)).not.toContain('18473');
});
it.each(['unknown','socket','socks','socks-url','mode','mitm','upstream','non-loopback','local-binding','missing-flag','unsafe-proxy','inherited'])('retains refusal for controlled-network unknown or unsafe semantics %s',fault=>{
  const profile=controlledNetworkProfile(),network=profile.network;
  if(fault==='unknown')network.future=null;if(fault==='socket')network.unix_sockets={};if(fault==='socks')network.enable_socks5=true;if(fault==='socks-url')network.socks_url='socks5://127.0.0.1:18473';if(fault==='mode')network.mode='full';if(fault==='mitm')network.mitm={};if(fault==='upstream')network.allow_upstream_proxy=true;if(fault==='non-loopback')network.dangerously_allow_non_loopback_proxy=true;if(fault==='local-binding')network.allow_local_binding=false;if(fault==='missing-flag')delete network.dangerously_allow_all_unix_sockets;if(fault==='unsafe-proxy')network.proxy_url='http://unsafe.example:18473';if(fault==='inherited')profile.extends='parent';
  expect(codexObservedPermissionsHash(profile)).toBeUndefined();
});
