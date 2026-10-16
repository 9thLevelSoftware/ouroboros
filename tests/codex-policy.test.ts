import { describe, expect, it } from 'vitest';
import { denyServerRequest, projectConfig, projectRequirements, checkControls } from '../src/providers/codex/policy.ts';

describe('Codex permission and credential policy', () => {
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
