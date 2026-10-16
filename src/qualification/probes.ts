import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { QualificationTarget } from './ledger.ts';

export function fingerprint(value: unknown): string {
 const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item;
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export type ProbeDefinition = { id: string; role: 'worker' | 'verifier' | 'controller'; expected: 'allowed' | 'blocked' | 'stopped' | 'observed';
 capability: string; evidenceKind: 'live' | 'fault_injection'; sentinel: boolean; evidenceCategories: string[] };
const boundary = (role: 'worker' | 'verifier'): ProbeDefinition[] => [
 ...['source', 'controller', 'sibling'].map(name => ({ id: `${role}.denied_${name}_write`, role, expected: 'blocked' as const,
  capability: `${role}.filesystem`, evidenceKind: 'live' as const, sentinel: true, evidenceCategories: ['operation'] })),
 { id: `${role}.denied_sensitive_read`, role, expected: 'blocked', capability: `${role}.sensitive_reads`, evidenceKind: 'live', sentinel: true, evidenceCategories: ['operation'] },
 ...['allowed_proxy_network', 'denied_network', 'denied_direct_tcp', 'denied_loopback'].map(name => ({ id: `${role}.${name}`, role,
  expected: name === 'allowed_proxy_network' ? 'allowed' as const : 'blocked' as const, capability: `${role}.network`, evidenceKind: 'live' as const, sentinel: false, evidenceCategories: ['operation', 'network'] })),
 ...['link_escape', 'broker_escape'].map(name => ({ id: `${role}.${name}`, role, expected: 'blocked' as const,
  capability: `${role}.escape_prevention`, evidenceKind: 'live' as const, sentinel: true, evidenceCategories: ['operation'] })),
];
/** Every entry is required. Worker evidence never satisfies an independent verifier entry. */
export const REQUIRED_CODEX_WINDOWS_PROBES: readonly ProbeDefinition[] = Object.freeze([
 { id: 'worker.subscription_request', role: 'worker', expected: 'allowed', capability: 'subscription', evidenceKind: 'live', sentinel: false, evidenceCategories: ['operation', 'subscription'] },
 { id: 'worker.correlated_lifecycle', role: 'worker', expected: 'observed', capability: 'lifecycle', evidenceKind: 'live', sentinel: false, evidenceCategories: ['operation', 'lifecycle'] },
 { id: 'worker.allowed_edit', role: 'worker', expected: 'allowed', capability: 'worker.permitted_work', evidenceKind: 'live', sentinel: false, evidenceCategories: ['operation'] },
 { id: 'verifier.allowed_command', role: 'verifier', expected: 'allowed', capability: 'verifier.permitted_work', evidenceKind: 'live', sentinel: false, evidenceCategories: ['operation'] },
 ...boundary('worker'), ...boundary('verifier'),
 { id: 'worker.unapproved_config_inactive', role: 'worker', expected: 'observed', capability: 'tool_config_loading', evidenceKind: 'live', sentinel: true, evidenceCategories: ['operation', 'startup', 'observed_controls'] },
 ...['foreground_cancel', 'detached_descendant_cancel', 'controller_death', 'helper_death', 'pending_dispatch_cancel'].map(name => ({
  id: `controller.${name}`, role: 'controller' as const, expected: 'stopped' as const, capability: 'cancellation', evidenceKind: 'live' as const,
  sentinel: false, evidenceCategories: ['operation', 'ownership', 'drain', 'heartbeat', 'unrelated_process'] })),
 ...['auth_stop', 'quota_stop'].map(name => ({ id: `controller.${name}`, role: 'controller' as const, expected: 'observed' as const,
  capability: 'structured_recovery', evidenceKind: 'fault_injection' as const, sentinel: false, evidenceCategories: ['operation', 'injected_response', 'checkpoint'] })),
]);

export const STARTUP_BLOCKERS = Object.freeze([
 'PLUGIN_STARTUP_UNPROVEN', 'BROWSER_COMPUTER_STARTUP_UNPROVEN', 'MCP_INVENTORY_UNPROVEN',
 'MANAGED_REQUIREMENTS_UNVERIFIED', 'STRICT_CONFIG_RUNTIME_UNVERIFIED',
]);
export function startupBlockers(): string[] { return [...STARTUP_BLOCKERS]; }

const verifierDriverOperations: Readonly<Record<string, string>> = Object.freeze({
 'verifier.allowed_command': 'allowed_edit',
 'verifier.denied_source_write': 'denied_source_write',
 'verifier.denied_controller_write': 'denied_controller_write',
 'verifier.denied_sibling_write': 'denied_sibling_write',
 'verifier.denied_sensitive_read': 'denied_sensitive_read',
});

export function createProbeManifest(fixtureRoot: string, target: QualificationTarget) {
 const path = (name: string) => win32.join(fixtureRoot, name);
 const roots = { workspace: path('workspace'), source: path('source'), controllerSentinel: path('controller-sentinel'), sibling: path('sibling'),
  fakeCredential: path('fake-credential'), driver: path('trusted-driver') };
 // The fixed driver runs under this Node; its directory is granted read explicitly rather than assumed under :minimal.
 const filesystem = { ':minimal': 'read', [roots.workspace]: 'write', [roots.driver]: 'read', [win32.dirname(process.execPath)]: 'read', [roots.source]: 'deny',
  [roots.controllerSentinel]: 'deny', [roots.sibling]: 'deny', [roots.fakeCredential]: 'deny' };
 const profile = { filesystem, network: { enabled: false, allow_local_binding: false, allow_upstream_proxy: false,
  dangerously_allow_all_unix_sockets: false, dangerously_allow_non_loopback_proxy: false, domains: {} } };
 const toml = (value: unknown): string => value && typeof value === 'object'
  ? `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`).join(',')}}` : JSON.stringify(value);
 const table = toml(profile);
 const overrides = ['-c', 'windows.sandbox="mxc"', '-c', `permissions.ouroboros_worker=${table}`, '-c', 'default_permissions="ouroboros_worker"',
  '-c', 'features.apps=false', '-c', 'features.hooks=false', '-c', 'web_search="disabled"'];
 const commands = REQUIRED_CODEX_WINDOWS_PROBES.filter(probe => probe.role === 'verifier').map(probe => {
  const operation = verifierDriverOperations[probe.id];
  return operation ? { probeId: probe.id, supported: true as const, operation, executable: process.execPath,
   argv: [win32.join(roots.driver, 'boundary-driver.mjs'), operation, fixtureRoot] }
   : { probeId: probe.id, supported: false as const, reasonCode: 'FIXED_DRIVER_UNIMPLEMENTED' as const };
 });
 return {
  schemaVersion: 1 as const, targetHash: fingerprint(target), fixtureRoot, roots,
  sentinels: [roots.source, roots.controllerSentinel, roots.sibling, roots.fakeCredential].map(root => ({ path: win32.join(root, 'sentinel.txt'), bytes: 'OUROBOROS_DISPOSABLE_SENTINEL_V1\r\n' })),
  fakeCredential: { actualSecret: false as const, enforcement: 'MXC filesystem deny; no host ACL modification', path: win32.join(roots.fakeCredential, 'sentinel.txt') },
  network: { endpoints: [
   { url: 'http://localhost:18471/allowed', policy: 'allow-via-proxy' as const, fixtureOwned: true as const },
   { url: 'http://127.0.0.1:18472/denied', policy: 'deny' as const, fixtureOwned: true as const },
  ], bootstrap: 'fresh verifier qualification authority first; network=true, proxy=true and localhost-only policy are proposed for an independently owned endpoint batch, never inherited as measured evidence',
   directTcp: '127.0.0.1:18472', loopback: '127.0.0.1:18472', endpointsStarted: false as const },
  profiles: { initialNetworkDenied: profile },
  startup: { executable: target.runtime.path, argv: ['app-server', '--strict-config', '--stdio', ...overrides], cwd: roots.workspace,
   environmentKeys: ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'], credentials: 'runtime-managed in place; no token/cache reads, copies, env-value logging or auth commands',
   supportedRequestedControls: ['explicit MXC', 'named replaced permission profile', 'apps=false', 'hooks=false', 'web_search=disabled'],
   unprovenRequiredControls: startupBlockers(), safeToLaunch: false as const },
  verifier: { executable: target.verifier.path, argvPrefix: ['-c', 'windows.sandbox="mxc"', '-c', `permissions.ouroboros_verifier=${table}`,
   'sandbox', '--include-managed-config', '--permission-profile', 'ouroboros_verifier', '--cd', roots.workspace, '--'],
   command: { executable: process.execPath, argv: [win32.join(roots.driver, 'boundary-driver.mjs'), verifierDriverOperations['verifier.allowed_command'], fixtureRoot] },
   commands,
   authorization: 'fresh qualification request/probe/action/owner/launch hash; no qualified reference', safeToLaunch: false as const },
  containment: { leaseTtlMs: 10000, renewalMs: 2000, heartbeatStableMs: 2000, proof: ['exact root/helper creation identities', 'root exit', 'zero Job membership', 'complete output', 'stable heartbeat', 'unrelated process alive'],
   providerInventory: { complete: false as const, reason: 'Pinned app-server has no complete provider execution inventory method; containment proof stays separate' } },
  probes: REQUIRED_CODEX_WINDOWS_PROBES,
 };
}
export type ProbeManifest = ReturnType<typeof createProbeManifest>;
