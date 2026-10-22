const boundaryOrder=['denied_source_write','denied_controller_write','denied_sibling_write','denied_sensitive_read','allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback','link_escape','broker_escape'] as const;
/** Task7's reviewed dependency order, independent of registry presentation. */
export const CAMPAIGN_EXECUTION_PROBE_ORDER:readonly string[]=Object.freeze([
 'verifier.allowed_command',...boundaryOrder.map(operation=>`verifier.${operation}`),
 'worker.unapproved_config_inactive','worker.subscription_request','worker.correlated_lifecycle',
 'controller.foreground_cancel','controller.detached_descendant_cancel','controller.controller_death','controller.helper_death','controller.pending_dispatch_cancel',
 'worker.allowed_edit',...boundaryOrder.map(operation=>`worker.${operation}`),'controller.auth_stop','controller.quota_stop',
]);
