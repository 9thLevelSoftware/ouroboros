import type { Result } from '../../contracts/common.ts';
import type { RequestId } from './protocol/0.162.1/typescript/RequestId.js';
import type { CommandExecutionRequestApprovalResponse } from './protocol/0.162.1/typescript/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './protocol/0.162.1/typescript/v2/FileChangeRequestApprovalResponse.js';
import type { PermissionsRequestApprovalResponse } from './protocol/0.162.1/typescript/v2/PermissionsRequestApprovalResponse.js';
import type { ExecCommandApprovalResponse } from './protocol/0.162.1/typescript/ExecCommandApprovalResponse.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function authPresent(value: unknown): boolean {
  const providers=record(value);
  return Object.values(providers).some(value => {
    const provider=record(value);
    return ['env_key','experimental_bearer_token','http_headers','env_http_headers','auth'].some(key =>
      Object.hasOwn(provider,key) && provider[key] !== null);
  });
}
export type SafeConfig = {
  provider: 'openai' | 'unexpected' | 'unknown'; profile: 'expected' | 'unexpected' | 'unknown';
  mxc: boolean; appsDisabled: boolean; hooksDisabled: boolean; webDisabled: boolean;
  mcpDisabled: boolean; disallowedAuth: boolean;
  states: Record<string, 'disabled' | 'enabled' | 'unknown'>;
};
export type SafeRequirements = {
  pluginsDisabled: boolean; browserDisabled: boolean; computerDisabled: boolean;
  disallowedAuth: boolean; providerSafe: boolean; loginSafe: boolean;
  states: Record<string, 'disabled' | 'enabled' | 'unknown'>;
};
function state(value:unknown):'disabled'|'enabled'|'unknown'{return value === false?'disabled':value === true?'enabled':'unknown';}
/** Deliberately drops all layers, origins, arbitrary fields, identifiers and credential values.
 * A requested override never substitutes for an observed effective setting. */
export function projectConfig(response: unknown): SafeConfig {
  const config=record(record(response).config); const features=record(config.features);
  const profile=typeof config.default_permissions === 'string' ? config.default_permissions : null;
  const servers=config.mcp_servers;
  return Object.freeze({
    provider:config.model_provider === 'openai' ? 'openai' : config.model_provider === undefined || config.model_provider === null ? 'unknown' : 'unexpected',
    profile:profile === null ? 'unknown' : profile === 'ouroboros_worker' ? 'expected' : 'unexpected',
    mxc:record(config.windows).sandbox === 'mxc', appsDisabled:features.apps === false,
    hooksDisabled:features.hooks === false,webDisabled:config.web_search === 'disabled',
    mcpDisabled:servers !== null && typeof servers === 'object' && !Array.isArray(servers) && Object.values(record(servers)).every(server=>record(server).enabled === false),
    disallowedAuth:authPresent(config.model_providers),
    states:Object.freeze({apps:state(features.apps),hooks:state(features.hooks),mcp:servers === undefined || servers === null ? 'unknown' : Object.values(record(servers)).every(server=>record(server).enabled === false) ? 'disabled' : 'enabled'}),
  });
}
export function projectRequirements(response: unknown): SafeRequirements {
  const req=record(record(response).requirements); const features=record(req.featureRequirements);
  const allowed=req.allowedLoginMethods;
  return Object.freeze({pluginsDisabled:features.plugins === false,
    browserDisabled:features.browser_use === false && features.browser_use_external === false && features.browser_use_full_cdp_access === false || req.allowBrowserAndComputerUse === false,
    computerDisabled:features.computer_use === false || req.allowBrowserAndComputerUse === false,
    disallowedAuth:authPresent(req.modelProviders),providerSafe:req.modelProvider === undefined || req.modelProvider === null || req.modelProvider === 'openai',
    loginSafe:allowed === undefined || allowed === null || Array.isArray(allowed) && allowed.includes('chatgpt'),
    states:Object.freeze({plugins:state(features.plugins),browser:state(features.browser_use),browserExternal:state(features.browser_use_external),browserCdp:state(features.browser_use_full_cdp_access),computer:state(features.computer_use),browserComputer:state(req.allowBrowserAndComputerUse)}),
  });
}
export function checkControls(config: SafeConfig, requirements: SafeRequirements, profile: string): Result<void> {
  if (config.provider !== 'openai' || config.disallowedAuth || requirements.disallowedAuth || !requirements.providerSafe || !requirements.loginSafe)
    return {ok:false,error:{code:'SUBSCRIPTION_SOURCE_UNSAFE',message:'Unexpected or unknown provider/auth configuration',evidenceIds:[]}};
  if (profile !== 'ouroboros_worker' || config.profile !== 'expected' || !config.mxc || !config.appsDisabled || !config.hooksDisabled || !config.webDisabled || !config.mcpDisabled ||
      !requirements.pluginsDisabled || !requirements.browserDisabled || !requirements.computerDisabled ||
      ['browser','browserExternal','browserCdp','computer'].some(key=>requirements.states[key]==='enabled'))
    return {ok:false,error:{code:'CAPABILITY_UNAVAILABLE',message:'Required effective optional-tool or MXC/profile controls are missing',evidenceIds:[]}};
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
