import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { Result } from '../../contracts/common.ts';
import type { RequestId } from './protocol/0.162.1/typescript/RequestId.js';
import type { CommandExecutionRequestApprovalResponse } from './protocol/0.162.1/typescript/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './protocol/0.162.1/typescript/v2/FileChangeRequestApprovalResponse.js';
import type { PermissionsRequestApprovalResponse } from './protocol/0.162.1/typescript/v2/PermissionsRequestApprovalResponse.js';
import type { ExecCommandApprovalResponse } from './protocol/0.162.1/typescript/ExecCommandApprovalResponse.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** The pinned server reports remote-control status after every initialize.
 * Identity strings are intentionally excluded from the safe projection. */
export function codexRemoteControlState(value:unknown):'disabled'|'unsafe'{
  const p=record(value);
  return p.status==='disabled'&&typeof p.serverName==='string'&&typeof p.installationId==='string'&&(p.environmentId===null||typeof p.environmentId==='string')?'disabled':'unsafe';
}
/** Only passive protocol surfaces are additive. Unknown tools, policy changes,
 * approval requests and server requests never enter this informational lane. */
export function isInformationalCodexNotification(method:string,params:unknown):boolean {
  if(!params||typeof params!=='object'||Array.isArray(params)||Buffer.byteLength(JSON.stringify(params))>16384)return false;
  const p=record(params),text=(value:unknown)=>typeof value==='string'&&value.length<=16384;
  if(method==='deprecationNotice')return text(p.summary)&&(p.details===undefined||p.details===null||text(p.details));
  if(!text(p.threadId)||!text(p.turnId))return false;
  if(method==='thread/tokenUsage/updated')return !!p.tokenUsage&&typeof p.tokenUsage==='object'&&!Array.isArray(p.tokenUsage);
  if(method==='turn/plan/updated')return Array.isArray(p.plan)&&p.plan.length<=128&&p.plan.every(step=>text(record(step).step)&&['pending','inProgress','completed'].includes(String(record(step).status)));
  if(method==='turn/diff/updated')return text(p.diff);
  if(method==='item/reasoning/summaryPartAdded')return text(p.itemId)&&Number.isSafeInteger(p.summaryIndex)&&Number(p.summaryIndex)>=0;
  return ['item/agentMessage/delta','item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/commandExecution/outputDelta','item/fileChange/outputDelta'].includes(method)&&text(p.itemId)&&text(p.delta);
}

export function authPresent(value: unknown): boolean {
  if(value!==undefined&&value!==null&&(typeof value!=='object'||Array.isArray(value)))return true;
  const providers=record(value);
  return Object.values(providers).some(value => {
    const provider=record(value);
    return ['api_key','base_url','wire_api','requires_openai_auth','env_key','experimental_bearer_token','http_headers','env_http_headers','auth'].some(key =>
      Object.hasOwn(provider,key) && provider[key] !== null);
  });
}
/** Codex 0.162.1 config/defaults.toml at pinned commit
 * 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d. Compare bytes; never normalize URLs. */
export const CODEX_PACKAGED_CHATGPT_BASE_URL='https://chatgpt.com/backend-api/';
export type ChatgptEndpointCategory='absent'|'null'|'packaged-default'|'rejected';
export function chatgptEndpointCategory(value:unknown):ChatgptEndpointCategory{
  return value===undefined?'absent':value===null?'null':value===CODEX_PACKAGED_CHATGPT_BASE_URL?'packaged-default':'rejected';
}
export type SubscriptionSourceReason='CONFIG_PROVIDER_UNKNOWN'|'CONFIG_PROVIDER_UNEXPECTED'|'CONFIG_PROVIDER_DEFINITION'|'CONFIG_LOGIN_METHOD'|'CONFIG_CHATGPT_ENDPOINT'|'CONFIG_AUTH_UNKNOWN'|'REQUIREMENTS_PROVIDER_DEFINITION'|'REQUIREMENTS_CHATGPT_ENDPOINT'|'REQUIREMENTS_AUTH_UNKNOWN'|'REQUIREMENTS_PROVIDER'|'REQUIREMENTS_LOGIN_METHODS';
export type SubscriptionSourceAssessment={configEndpoint:ChatgptEndpointCategory|'unobserved';requirementsEndpoint:ChatgptEndpointCategory|'unobserved';rejections:readonly SubscriptionSourceReason[]};
export type SafeConfig = {
  provider: 'openai' | 'unexpected' | 'unknown'; profile: 'expected' | 'unexpected' | 'unknown';
  mxc: boolean; appsDisabled: boolean; hooksDisabled: boolean; webDisabled: boolean;
  mcpDisabled: boolean; disallowedAuth: boolean; optionalConflict:boolean; notifyDisabled:boolean;
  states: Record<string, 'disabled' | 'enabled' | 'unknown'>;
  /** Exact selected merged TOML table when config/read exposes it; no inference
   * from the requested override or legacy sandbox metadata. */
  selectedPermissionsHash?:string;
  shellEnvironmentPolicyHash?:string;
  sqliteHomeHash?:string;
  subscription?:{endpoint:ChatgptEndpointCategory;providerDefinitions:boolean;forcedLogin:boolean};
};
export type SafeRequirements = {
  pluginsDisabled: boolean; browserDisabled: boolean; computerDisabled: boolean;
  disallowedAuth: boolean; providerSafe: boolean; loginSafe: boolean; approvalSafe:boolean;
  states: Record<string, 'disabled' | 'enabled' | 'unknown'>;
  subscription?:{endpoint:ChatgptEndpointCategory;providerDefinitions:boolean};
};
/** Finite diagnostic projection shared by worker and verifier. It retains no
 * provider IDs, URLs, login values, headers, or credential material. */
export function subscriptionSourceAssessment(config:SafeConfig,requirements:SafeRequirements):SubscriptionSourceAssessment{
  const rejections:SubscriptionSourceReason[]=[];
  if(config.provider!=='openai')rejections.push(config.provider==='unknown'?'CONFIG_PROVIDER_UNKNOWN':'CONFIG_PROVIDER_UNEXPECTED');
  if(config.disallowedAuth){
    const start=rejections.length;
    if(config.subscription?.providerDefinitions)rejections.push('CONFIG_PROVIDER_DEFINITION');
    if(config.subscription?.forcedLogin)rejections.push('CONFIG_LOGIN_METHOD');
    if(config.subscription?.endpoint==='rejected')rejections.push('CONFIG_CHATGPT_ENDPOINT');
    if(start===rejections.length)rejections.push('CONFIG_AUTH_UNKNOWN');
  }
  if(requirements.disallowedAuth){
    const start=rejections.length;
    if(requirements.subscription?.providerDefinitions)rejections.push('REQUIREMENTS_PROVIDER_DEFINITION');
    if(requirements.subscription?.endpoint==='rejected')rejections.push('REQUIREMENTS_CHATGPT_ENDPOINT');
    if(start===rejections.length)rejections.push('REQUIREMENTS_AUTH_UNKNOWN');
  }
  if(!requirements.providerSafe)rejections.push('REQUIREMENTS_PROVIDER');
  if(!requirements.loginSafe)rejections.push('REQUIREMENTS_LOGIN_METHODS');
  return Object.freeze({configEndpoint:config.subscription?.endpoint??'unobserved',requirementsEndpoint:requirements.subscription?.endpoint??'unobserved',rejections:Object.freeze(rejections)});
}
function state(value:unknown):'disabled'|'enabled'|'unknown'{return value === false?'disabled':value === true?'enabled':'unknown';}
/** Generic bounded canonical digest; security comparisons use the explicit
 * requested and observed projections below. No raw paths reach diagnostics. */
export function codexPermissionProfileHash(value:unknown):string|undefined {
  try{
    let nodes=0;
    const canonical=(item:unknown,depth:number):unknown=>{
      if(++nodes>4096||depth>12)throw Error('Profile complexity');
      if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return item;
      if(Array.isArray(item))return item.map(child=>canonical(child,depth+1));
      if(item&&typeof item==='object')return Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical((item as Record<string,unknown>)[key],depth+1)]));
      throw Error('Invalid profile value');
    };
    if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
    const serialized=JSON.stringify(canonical(value,0));if(Buffer.byteLength(serialized)>65536)return undefined;
    return createHash('sha256').update(serialized).digest('hex');
  }catch{return undefined;}
}
const plainTable=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[null,Object.prototype].includes(Object.getPrototypeOf(value));
const exactKeys=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const requestedNetworkKeys=['enabled','allow_local_binding','allow_upstream_proxy','dangerously_allow_all_unix_sockets','dangerously_allow_non_loopback_proxy','domains'] as const;
/** Hash only the controller's closed security recipe, independent of vendor
 * serialization defaults. Effective observations must project the same controls. */
export function codexRequestedPermissionsHash(value:unknown):string|undefined{
  if(!plainTable(value)||!exactKeys(value,['filesystem','network'])||!plainTable(value.filesystem)||!plainTable(value.network))return undefined;
  const fs=value.filesystem,network=value.network;
  if(fs[':minimal']!=='read'||Object.keys(fs).length<2||Object.entries(fs).some(([path,mode])=>!['read','write','deny'].includes(mode as string)||path!==':minimal'&&(!win32.isAbsolute(path)||path.startsWith('\\\\')||/[\x00-\x1f\x7f]/.test(path)||path.split(/[\\/]/).some(part=>part==='.'||part==='..'))))return undefined;
  if(!exactKeys(network,requestedNetworkKeys)||requestedNetworkKeys.filter(key=>key!=='domains').some(key=>network[key]!==false)||!plainTable(network.domains)||Object.keys(network.domains).length!==0)return undefined;
  return codexPermissionProfileHash({filesystem:fs,network});
}
export function codexRequestedEnvironmentHash(value:unknown):string|undefined{
  const keys=['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'];
  if(!plainTable(value)||!exactKeys(value,['inherit','ignore_default_excludes','exclude','set','include_only','experimental_use_profile'])||value.inherit!=='none'||value.ignore_default_excludes!==false||value.experimental_use_profile!==false||!Array.isArray(value.exclude)||value.exclude.length!==0||!Array.isArray(value.include_only)||value.include_only.length!==keys.length||new Set(value.include_only).size!==keys.length||!keys.every(key=>(value.include_only as unknown[]).includes(key))||!plainTable(value.set)||!exactKeys(value.set,keys)||Object.values(value.set).some(item=>typeof item!=='string'))return undefined;
  return codexPermissionProfileHash(value);
}
/** Project explicit enforcement settings, independent of Rust's serialized
 * Option/default layout. Unknown permission/environment semantics fail closed;
 * only a description is known to be informational. Missing restrictions cannot
 * be inferred from a requested override. */
export function codexObservedPermissionsHash(value:unknown):string|undefined {
  if(!plainTable(value)||Object.keys(value).some(key=>!['description','extends','workspace_roots','filesystem','network'].includes(key))||value.description!==undefined&&value.description!==null&&typeof value.description!=='string'||value.extends!==undefined&&value.extends!==null||value.workspace_roots!==undefined&&value.workspace_roots!==null||!plainTable(value.filesystem)||!plainTable(value.network))return undefined;
  const filesystem={...value.filesystem},network={...value.network};
  if(filesystem.glob_scan_max_depth!==undefined&&filesystem.glob_scan_max_depth!==null)return undefined;
  delete filesystem.glob_scan_max_depth;
  const optional=['proxy_url','enable_socks5','socks_url','enable_socks5_udp','mode','unix_sockets','mitm'];
  if(Object.keys(network).some(key=>![...requestedNetworkKeys,...optional].includes(key)))return undefined;
  const proxy=network.proxy_url;delete network.proxy_url;
  for(const key of optional.filter(key=>key!=='proxy_url')){const item=network[key];if(item!==undefined&&item!==null&&!((key==='enable_socks5'||key==='enable_socks5_udp')&&item===false))return undefined;delete network[key];}
  // A qualification profile may deliberately allow controlled network access.
  // It must expose the same explicit managed-loopback contract accepted by the
  // launch validator. Ordinary task requests retain their no-network contract.
  if(filesystem[':minimal']!=='read'||Object.keys(filesystem).length<2||Object.entries(filesystem).some(([path,mode])=>!['read','write','deny'].includes(mode as string)||path!==':minimal'&&(!win32.isAbsolute(path)||path.startsWith('\\\\')||/[\x00-\x1f\x7f]/.test(path)||path.split(/[\\/]/).some(part=>part==='.'||part==='..'))))return undefined;
  if(!exactKeys(network,requestedNetworkKeys)||typeof network.enabled!=='boolean'||typeof network.allow_local_binding!=='boolean'||['allow_upstream_proxy','dangerously_allow_all_unix_sockets','dangerously_allow_non_loopback_proxy'].some(key=>network[key]!==false)||!plainTable(network.domains)||Object.entries(network.domains).some(([domain,mode])=>!domain||/[\x00-\x20\x7f]/.test(domain)||!['allow','deny'].includes(mode as string)))return undefined;
  if(network.enabled){
    if(network.allow_local_binding!==true||typeof proxy!=='string'||!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/.test(proxy))return undefined;
    try{const url=new URL(proxy);if(Number(url.port)<1||Number(url.port)>65535||url.username||url.password)return undefined;}catch{return undefined;}
    return codexPermissionProfileHash({filesystem,network:{...network,proxy_url:proxy}});
  }
  if(network.allow_local_binding!==false||proxy!==undefined&&proxy!==null||Object.values(network.domains).some(mode=>mode==='allow'))return undefined;
  return codexPermissionProfileHash({filesystem,network});
}
export function codexObservedEnvironmentHash(value:unknown):string|undefined {
  if(!plainTable(value)||Object.keys(value).some(key=>!['inherit','ignore_default_excludes','exclude','set','include_only','experimental_use_profile','filters'].includes(key))||value.filters!==undefined&&value.filters!==null)return undefined;
  const policy={...value};delete policy.filters;return codexRequestedEnvironmentHash(policy);
}
export type EffectiveControlHashComparison={result:'MATCH'|'EXPECTED_INVALID'|'OBSERVED_UNAVAILABLE'|'DIFFERENT';expectedHash?:string;observedHash?:string};
export type EffectivePolicyAssessment={permissions:EffectiveControlHashComparison;environment:EffectiveControlHashComparison;state?:EffectiveControlHashComparison};
export function compareCodexControlHashes(expected:unknown,observed:unknown):EffectiveControlHashComparison{
  const valid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  return {result:!valid(expected)?'EXPECTED_INVALID':!valid(observed)?'OBSERVED_UNAVAILABLE':expected===observed?'MATCH':'DIFFERENT',...(valid(expected)?{expectedHash:expected}:{}),...(valid(observed)?{observedHash:observed}:{})};
}
/** Deliberately drops all layers, origins, arbitrary fields, identifiers and credential values.
 * A requested override never substitutes for an observed effective setting. */
export function projectConfig(response: unknown): SafeConfig {
  if(!plainTable(response)||!plainTable(response.config))throw Error('MALFORMED_CONFIG_OBSERVATION');
  const config=response.config; const features=record(config.features);
  const profile=typeof config.default_permissions === 'string' ? config.default_permissions : null;
  const selectedPermissionsHash=profile===null?undefined:codexObservedPermissionsHash(record(config.permissions)[profile]);
  const shellEnvironmentPolicyHash=codexObservedEnvironmentHash(config.shell_environment_policy);
  const servers=config.mcp_servers;
  const subscription=Object.freeze({endpoint:chatgptEndpointCategory(config.chatgpt_base_url),providerDefinitions:authPresent(config.model_providers),forcedLogin:config.forced_login_method!==undefined&&config.forced_login_method!==null&&config.forced_login_method!=='chatgpt'});
  return Object.freeze({
    provider:config.model_provider === 'openai' ? 'openai' : config.model_provider === undefined || config.model_provider === null ? 'unknown' : 'unexpected',
    profile:profile === null ? 'unknown' : profile === 'ouroboros_worker' ? 'expected' : 'unexpected',
    mxc:record(config.windows).sandbox === 'mxc', appsDisabled:features.apps === false,
    hooksDisabled:features.hooks === false,webDisabled:config.web_search === 'disabled',
    mcpDisabled:servers !== null && typeof servers === 'object' && !Array.isArray(servers) && Object.values(record(servers)).every(server=>record(server).enabled === false),
    disallowedAuth:subscription.providerDefinitions||subscription.forcedLogin||subscription.endpoint==='rejected',subscription,
    optionalConflict:['plugins','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','remote_control'].some(key=>features[key]===true)||config.notify!==undefined&&config.notify!==null&&(!Array.isArray(config.notify)||config.notify.length>0),
    notifyDisabled:config.notify===undefined||config.notify===null||Array.isArray(config.notify)&&config.notify.length===0,
    states:Object.freeze({plugins:state(features.plugins),browser:state(features.browser_use),browserExternal:state(features.browser_use_external),browserCdp:state(features.browser_use_full_cdp_access),computer:state(features.computer_use),remoteControl:state(features.remote_control),apps:state(features.apps),hooks:state(features.hooks),mcp:servers === undefined || servers === null ? 'unknown' : Object.values(record(servers)).every(server=>record(server).enabled === false) ? 'disabled' : 'enabled'}),
    ...(selectedPermissionsHash?{selectedPermissionsHash}:{}),
    ...(shellEnvironmentPolicyHash?{shellEnvironmentPolicyHash}:{}),
    ...(typeof config.sqlite_home==='string'?{sqliteHomeHash:createHash('sha256').update(JSON.stringify(config.sqlite_home)).digest('hex')}:{ }),
  });
}
export function projectRequirements(response: unknown): SafeRequirements {
  if(!plainTable(response)||!Object.hasOwn(response,'requirements')||response.requirements!==null&&!plainTable(response.requirements))throw Error('MALFORMED_REQUIREMENTS_OBSERVATION');
  const req=record(response.requirements); const features=record(req.featureRequirements);
  const allowed=req.allowedLoginMethods;
  const approvals=req.allowedApprovalPolicies;
  const subscription=Object.freeze({endpoint:chatgptEndpointCategory(req.chatgptBaseUrl),providerDefinitions:authPresent(req.modelProviders)});
  return Object.freeze({pluginsDisabled:features.plugins === false,
    browserDisabled:features.browser_use === false && features.browser_use_external === false && features.browser_use_full_cdp_access === false || req.allowBrowserAndComputerUse === false,
    computerDisabled:features.computer_use === false || req.allowBrowserAndComputerUse === false,
    disallowedAuth:subscription.providerDefinitions||subscription.endpoint==='rejected',subscription,providerSafe:req.modelProvider === undefined || req.modelProvider === null || req.modelProvider === 'openai',
    loginSafe:allowed === undefined || allowed === null || Array.isArray(allowed) && allowed.includes('chatgpt') && allowed.every(value=>value==='chatgpt'||value==='api') && new Set(allowed).size===allowed.length,
    approvalSafe:approvals===undefined||approvals===null||Array.isArray(approvals)&&approvals.includes('on-request'),
    states:Object.freeze({plugins:state(features.plugins),browser:state(features.browser_use),browserExternal:state(features.browser_use_external),browserCdp:state(features.browser_use_full_cdp_access),computer:state(features.computer_use),browserComputer:state(req.allowBrowserAndComputerUse)}),
  });
}
export function checkControls(config: SafeConfig, requirements: SafeRequirements, profile: string): Result<void> {
  if (config.provider !== 'openai' || config.disallowedAuth || requirements.disallowedAuth || !requirements.providerSafe || !requirements.loginSafe)
    return {ok:false,error:{code:'SUBSCRIPTION_SOURCE_UNSAFE',message:'Unexpected or unknown provider/auth configuration',evidenceIds:[]}};
  if (profile !== 'ouroboros_worker' || config.profile !== 'expected' || !config.mxc || !config.appsDisabled || !config.hooksDisabled || !config.webDisabled || !config.mcpDisabled || config.optionalConflict || !requirements.approvalSafe ||
      !(requirements.pluginsDisabled||config.states.plugins==='disabled') || !(requirements.browserDisabled||['browser','browserExternal','browserCdp'].every(key=>config.states[key]==='disabled')) || !(requirements.computerDisabled||config.states.computer==='disabled') ||
      ['plugins','browser','browserExternal','browserCdp','computer'].some(key=>requirements.states[key]==='enabled'))
    return {ok:false,error:{code:'CAPABILITY_UNAVAILABLE',message:'Required effective optional-tool or MXC/profile controls are missing',evidenceIds:[]}};
  return {ok:true,value:undefined};
}
/** Only for the closed, terminal five-frame metadata action. Desktop/remote
 * availability is not activation; their observed unknown states stay unknown.
 * Early effects still require independent phase admission and a fresh client. */
export function checkMetadataControls(config: SafeConfig, requirements: SafeRequirements, profile: string): Result<void> {
  if(config.provider!=='openai'||config.disallowedAuth||requirements.disallowedAuth||!requirements.providerSafe||!requirements.loginSafe)
    return {ok:false,error:{code:'SUBSCRIPTION_SOURCE_UNSAFE',message:'Unexpected or unknown provider/auth configuration',evidenceIds:[]}};
  if(profile!=='ouroboros_worker'||config.profile!=='expected'||!config.mxc||!config.appsDisabled||!config.hooksDisabled||!config.webDisabled||!config.mcpDisabled||!config.notifyDisabled||config.states.plugins!=='disabled'||requirements.states.plugins==='enabled')
    return {ok:false,error:{code:'CAPABILITY_UNAVAILABLE',message:'Required early metadata controls or MXC/profile are missing',evidenceIds:[]}};
  return {ok:true,value:undefined};
}
export function denyServerRequest(request: { id: RequestId; method: string; params?: unknown }): {
  decision: 'deny'; response: {id:RequestId;result?:unknown;error?:{code:number;message:string}};
} {
  let result: CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse | PermissionsRequestApprovalResponse | ExecCommandApprovalResponse;
  switch(request.method) {
    case 'item/commandExecution/requestApproval': case 'item/fileChange/requestApproval': result={decision:'decline'};break;
    case 'item/permissions/requestApproval':result={permissions:{},scope:'turn'};break;
    case 'execCommandApproval':case 'applyPatchApproval':result={decision:{denied:{rejection:'Controller policy denies escalation'}}};break;
    default:return {decision:'deny',response:{id:request.id,error:{code:-32601,message:'Unsupported server request'}}};
  }
  return {decision:'deny',response:{id:request.id,result}};
}
