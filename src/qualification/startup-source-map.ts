import { z } from 'zod';
import { fingerprint } from './probes.ts';
import { HashSchema, IdSchema } from '../contracts/common.ts';
import type { QualificationTarget } from './ledger.ts';
import { STARTUP_SOURCES } from './codex-startup-authority.ts';
import { buildStartupCoverageManifest, STARTUP_MONITOR_PATHS, validateStartupLocalScope, type StartupArtifactRef, type StartupCoverageManifest, type StartupLocalScope, type StartupSessionProof } from './startup-evidence.ts';

export const PINNED_STARTUP_SOURCE_COMMIT='092d3acd6bec3e3a14bdc7e7a2810ab628ab759d';
/** Exact Git object bytes, independently readable before candidate acceptance. */
export const PINNED_STARTUP_SOURCE_HASHES=Object.freeze({
 'codex-rs/app-server/src/lib.rs':'b4c6b019d3ed6e5511abc997a725f466a0377c055ea09d2db8535f9275697c47',
 'codex-rs/app-server/src/message_processor.rs':'5e17343f7c7129dc09a77300771dcd93119192c5cb39a3f4d1e29a547fec34ed',
 'codex-rs/app-server/src/request_processors/thread_processor.rs':'2c40a6db590c9823a6775b28c2e125544583246318ce038166d28fb57a10ab29',
 'codex-rs/core-plugins/src/manager.rs':'5d401e52976cd1d9dc84a65ea1d007bab13b2d3d4c8e8da96981f20b012c0343',
 'codex-rs/core/src/config/mod.rs':'32babb117ff4bf0dc08050c4a755f5996f57f51fcebb82595c81648420394259',
 'codex-rs/core/src/session/session.rs':'0179bec86da0526042f5f9a26fcc6f03b018833aa7fc26f56ec83ccd51fdc9a9',
 'codex-rs/core/src/session/mcp_runtime.rs':'898d29b95f91ed137e5d41671be8c182768328355099bc757a16fe8de6cee56f',
 'codex-rs/core/src/session/mod.rs':'5e94b4e8fc9fea7314169e7e29e88a96acbe7f9d0ec5e50a6a60de2d7ffc88df',
 'codex-rs/config/src/loader/mod.rs':'1d02081520b4164aba4b6928844a2b0ae12d3fae3540b0c4cee3c3de541a64c9',
 'codex-rs/config/src/loader/managed_requirements.rs':'00595b2320674364053537213638735da20739a8864c92947bd4acb869fcf448',
 'codex-rs/config/src/requirements_layers/stack.rs':'62f841d8c89e27476d93adca8816e0808e12d570c8c4cbe5621d5a74f7b7824f',
 'codex-rs/config/src/strict_config.rs':'db94dd50d072e5045524403796761ff494835213df624249eacd0e606fd5ef4a',
 'codex-rs/app-server-transport/src/transport/remote_control/controller.rs':'eca8afee2ab912bedef8813d4c3972ee0f01cf5e4fdf5ef99856d516838767c3',
 'codex-rs/app-server-transport/src/transport/remote_control/desired_state.rs':'deab11fc661453cfc19bfc347264600d3dffd3d80e1de5ef18da612d60c92059',
 'codex-rs/app-server-transport/src/transport/remote_control/websocket.rs':'43b6cec814b594337594e6f25e0bc7dd77bb5688a392bc03145dbb78986c072d',
 'codex-rs/rollout/src/state_db.rs':'22bb1352fffb26b1ca2e2183a7521b7aa1bc458d4fa8054dfa94f385c91a6ad5',
 'codex-rs/state/src/runtime/remote_control.rs':'68e4c6f65e35436027676c4462bec5a1413e069a2720399b716c6d4d93df6345',
 'codex-rs/hooks/src/registry.rs':'793ce20b5eb5129c15baa138f9f4496427118b6db3120174b72bfc5071fa6ac3',
 'codex-rs/hooks/src/legacy_notify.rs':'e710e4c7d4806bbe3dfb32967db5f0715634b9ace700d24362e853fe1fe715b5',
 'codex-rs/codex-mcp/src/lib.rs':'c0b35eae40711ca4c282d8fec9acc1946c29283915f2f71878937d96b094f1af',
 'codex-rs/codex-mcp/src/mcp/mod.rs':'e40161e22b55a8a81961be567396aefff212c20644e59403f1aeda3366ca72c7',
 'codex-rs/codex-mcp/src/connection_manager.rs':'b613feaa50239af2417aa768bd66ee2313392e58a7687d32cf7127aa8858fd1f',
 'codex-rs/codex-mcp/src/connection_manager/startup.rs':'1fbd2cc3ba7cf3fc4cb5131cbc98289a0e865fe7883434a83dae4678c8f7ed1c',
 'codex-rs/codex-mcp/src/codex_apps.rs':'38302c893ea1b377d3602be92d62ca10a2654f394598fa1f446f2b146abeaa6d',
 'codex-rs/core/src/tools/hosted_spec.rs':'add42354c1662ced395898ba4b8bac9b4546ee5b5963cd40bc3f542fc950765c',
 'codex-rs/features/src/lib.rs':'b2d81978097a0bcc53750ef7e3fb3dfae655c3cb1b26250525d02980ee09811f',
 'codex-rs/hooks/src/engine/mod.rs':'15d6f819a0de303dd98bfd3ae8050779188ef47e2517081bd4debac913f7d10a',
 'codex-rs/rollout/src/metadata.rs':'ea04fb804a717722db62d9384f9a13752187c8b7ef8c160484c0f5d6e542f711',
 'codex-rs/app-server-transport/src/transport/stdio.rs':'e4f83304498aec2e9ccad9ad3a0af66965ab93508a4a6923f993731adcd69c19',
 'codex-rs/config/src/loader/application.rs':'2ba93ecbbfbc777ea004a135a2241a4df0ec68c1a7946cb16b51fc853a810da3',
 'codex-rs/config/src/loader/local.rs':'67ea1e125708d88286cfe2c4787c4e02225a8a90c27b8764fee7135f24570d52',
});
type SourcePath=keyof typeof PINNED_STARTUP_SOURCE_HASHES;
export type StartupSourcePin={path:string;blobHash:string;artifact:StartupArtifactRef};
type Source=StartupCoverageManifest['routes'][number]['sourceEvidence'][number];
type Consumer=readonly [SourcePath,string];
const load:readonly Consumer[]=[['codex-rs/config/src/loader/mod.rs','load_config_layers_state'],['codex-rs/core/src/config/mod.rs','ConfigBuilder::build']];
const plugins:readonly Consumer[]=[['codex-rs/core/src/config/mod.rs','plugins_config_input'],['codex-rs/core-plugins/src/manager.rs','plugins_for_config']];
const mcp:readonly Consumer[]=[['codex-rs/core/src/config/mod.rs','to_mcp_config_with_loaded_plugins'],['codex-rs/codex-mcp/src/mcp/mod.rs','effective_mcp_servers_from_configured'],['codex-rs/codex-mcp/src/connection_manager.rs','McpConnectionSet::new:enabled_filter'],['codex-rs/core/src/session/mcp_runtime.rs','project_selected_environment_mcp_servers']];
const pathConsumers:Record<typeof STARTUP_MONITOR_PATHS[number],readonly Consumer[]>={
 plugins, 'plugin-contributions':plugins,
 // This excludes only native desktop/browser clients. Their plugin/MCP
 // contributions remain covered by the separate applicable routes below.
 'browser-native':[['codex-rs/app-server/src/lib.rs','run_main_with_transport_options'],['codex-rs/app-server/src/request_processors/thread_processor.rs','thread_start']],
 'browser-cdp':[['codex-rs/app-server/src/lib.rs','run_main_with_transport_options'],['codex-rs/app-server/src/request_processors/thread_processor.rs','thread_start']],
 computer:[['codex-rs/app-server/src/lib.rs','run_main_with_transport_options'],['codex-rs/app-server/src/request_processors/thread_processor.rs','thread_start']],
 'mcp-ordinary':mcp,'mcp-managed-cloud':mcp,'mcp-plugin':[...plugins,...mcp],
 'remote-control':[['codex-rs/app-server/src/lib.rs','run_main_with_transport_options:remote_control_policy'],['codex-rs/app-server-transport/src/transport/stdio.rs','stdio_initialize_client_name'],['codex-rs/app-server-transport/src/transport/remote_control/controller.rs','start_remote_control'],['codex-rs/app-server-transport/src/transport/remote_control/desired_state.rs','desired_state_from_persisted_enrollment'],['codex-rs/app-server-transport/src/transport/remote_control/websocket.rs','RemoteControlDesiredState'],['codex-rs/state/src/runtime/remote_control.rs','get_remote_control_enrollment'],['codex-rs/rollout/src/state_db.rs','init'],['codex-rs/rollout/src/metadata.rs','backfill_sessions']],
 hooks:[...plugins,['codex-rs/features/src/lib.rs','FeatureSpec:CodexHooks:hooks'],['codex-rs/core/src/session/mod.rs','build_hooks_config'],['codex-rs/hooks/src/registry.rs','Hooks::from_config'],['codex-rs/hooks/src/engine/mod.rs','ClaudeHooksEngine::new']],
 'legacy-notify':[['codex-rs/core/src/session/mod.rs','build_hooks_config'],['codex-rs/hooks/src/registry.rs','Hooks::from_config:legacy_notify_argv'],['codex-rs/hooks/src/legacy_notify.rs','notify_hook']],
 apps:[['codex-rs/core/src/config/mod.rs','to_mcp_config_with_loaded_plugins:apps_enabled'],['codex-rs/features/src/lib.rs','Feature::Apps'],['codex-rs/codex-mcp/src/mcp/mod.rs','host_owned_codex_apps_enabled']],
 web:[['codex-rs/core/src/config/mod.rs','resolve_web_search_mode_for_turn'],['codex-rs/core/src/tools/hosted_spec.rs','create_web_search_tool']],
};
/** Constructs a source-specific candidate using the independently reviewed full
 * loader and distinct consumer gates. The returned UNREVIEWED status grants no
 * authority; exact current bytes and the catalog digest still require review. */
export function buildRuntimeSourceRouteCandidate(input:{commit:string;sources:readonly StartupSourcePin[]}){
 if(!/^[a-f0-9]{40}$/.test(input.commit))throw Error('SOURCE_COMMIT_INVALID');
 const pins=new Map<string,StartupSourcePin>();
 for(const pin of input.sources){if(pins.has(pin.path)||!HashSchema.safeParse(pin.blobHash).success||pin.artifact.sha256!==pin.blobHash)throw Error('SOURCE_BLOB_INVALID');pins.set(pin.path,pin);}
 type C=readonly [string,string];
 const common:readonly C[]=[['codex-rs/config/src/loader/mod.rs','load_config_layers_state:all_eight_sources'],['codex-rs/config/src/loader/project_discovery.rs','managed_project_discovery'],['codex-rs/config/src/loader/managed_requirements.rs','load_managed_requirements_state:source_precedence'],['codex-rs/config/src/requirements_layers/stack.rs','compose_requirements:recursive_merge'],['codex-rs/core/src/config/mod.rs','ConfigBuilder::build']];
 const pluginGates:readonly C[]=[['codex-rs/core/src/config/mod.rs','plugins_config_input:effective_feature'],['codex-rs/core-plugins/src/manager.rs','plugins_for_config:disabled_empty_load'],['codex-rs/app-server/src/message_processor.rs','plugin_bootstrap_warmups'],['codex-rs/core-plugins/src/manager.rs','start_startup_tasks:disabled_gate']];
 const pluginContributions:readonly C[]=[['codex-rs/ext/mcp/src/plugin.rs','selected_plugin_servers:disabled_empty_map'],['codex-rs/core/src/mcp.rs','plugin_connector_snapshot:disabled_empty'],['codex-rs/ext/mcp/src/plugin_contributor.rs','local_plugin_providers'],['codex-rs/ext/mcp/src/plugin_providers.rs','PluginProviders::new:cloud_none'],['codex-rs/ext/mcp/src/cloud_plugin.rs','plugins_feature_refresh_and_contribution_gate']];
 const mcpGates:readonly C[]=[['codex-rs/core/src/config/mod.rs','to_mcp_config_with_loaded_plugins'],['codex-rs/core/src/mcp.rs','effective_extension_and_plugin_registrations'],['codex-rs/codex-mcp/src/catalog.rs','resolved_registration_disabled_semantics'],['codex-rs/codex-mcp/src/connection_manager.rs','McpConnectionSet::new:enabled_filter'],['codex-rs/core/src/session/mcp_runtime.rs','project_selected_environment_mcp_servers:local_skip']];
 const native:readonly C[]=[['codex-rs/features/src/lib.rs','browser_computer:requirements_only'],['codex-rs/app-server/src/extensions.rs','headless_registry:no_native_browser_computer'],['codex-rs/app-server/src/request_processors/thread_processor.rs','reserved_namespaces_dynamic_tools_selected_roots']];
 const runtimeConsumers:Record<typeof STARTUP_MONITOR_PATHS[number],readonly C[]>={
  plugins:pluginGates,'plugin-contributions':[...pluginGates,...pluginContributions],
  'browser-native':native,'browser-cdp':native,computer:native,
  'mcp-ordinary':mcpGates,'mcp-managed-cloud':[...mcpGates,...pluginContributions.slice(2)],'mcp-plugin':[...mcpGates,...pluginContributions,...pluginGates.slice(0,1)],
  'remote-control':[['codex-rs/features/src/lib.rs','remote_control_toggle:ignored_not_enforcement'],['codex-rs/app-server/src/lib.rs','remote_control_requirements_and_stdio_startup'],['codex-rs/app-server-transport/src/transport/stdio.rs','stdio_initialize_client_name'],['codex-rs/app-server-transport/src/transport/remote_control/controller.rs','start_remote_control'],['codex-rs/app-server-transport/src/transport/remote_control/desired_state.rs','persisted_enrollment_and_scoped_resolution'],['codex-rs/app-server-transport/src/transport/remote_control/websocket.rs','RemoteControlDesiredState'],['codex-rs/state/src/runtime/remote_control.rs','get_remote_control_enrollment'],['codex-rs/rollout/src/state_db.rs','fresh_isolated_state'],['codex-rs/rollout/src/metadata.rs','session_backfill']],
  hooks:[...pluginGates,['codex-rs/core/src/session/mod.rs','build_hooks_config'],['codex-rs/hooks/src/engine/mod.rs','disabled_and_empty_plugin_sources:empty_engine']],'legacy-notify':[['codex-rs/hooks/src/registry.rs','Hooks::from_config:independent_notify_argv'],['codex-rs/hooks/src/legacy_notify.rs','notify_hook']],
  apps:[['codex-rs/ext/mcp/src/lib.rs','apps_disabled:remove_hosted_contribution'],['codex-rs/core/src/mcp.rs','apps_disabled:remove_compatibility'],['codex-rs/codex-mcp/src/mcp/mod.rs','apps_disabled:final_server_removal']],
  web:[['codex-rs/core/src/tools/hosted_spec.rs','disabled:no_hosted_web_tool'],['codex-rs/ext/web-search/src/extension.rs','disabled:no_standalone_extension_or_tool']],
 };
 const evidence=(consumers:readonly C[]):Source[]=>{const unique=new Map<string,C>();for(const consumer of consumers)unique.set(consumer.join(':'),consumer);return [...unique.values()].map(([path,consumer])=>{const pin=pins.get(path);if(!pin)throw Error('SOURCE_SET_INCOMPLETE:'+path);return {commit:input.commit,path,blobHash:pin.blobHash,artifact:structuredClone(pin.artifact),consumer};});};
 const semantics:Record<typeof STARTUP_MONITOR_PATHS[number],string>={
  plugins:'The full effective loader and managed source precedence feed plugins feature state. Disabled plugins yield an empty load and suppress bootstrap startup tasks; both distinct gates and actual effective disabled observations are required at bootstrap and thread-start.',
  'plugin-contributions':'Plugins feature disabled suppresses plugin loading, selected plugin MCP server maps, and connector snapshots. Local PluginProviders uses cloud=None; optional cloud refresh remains plugins-gated. All contribution paths require actual effective policy observations.',
  'browser-native':'Scoped inapplicability only for observed headless local stdio, new-only closed-method client with no dynamic tools, no selected roots, no remote environments or reconfiguration. Native controls are requirements-only, not ordinary config enforcement. Plugin and MCP contribution routes remain applicable.',
  'browser-cdp':'Scoped inapplicability only for observed headless local stdio, new-only closed-method client with no dynamic tools, no selected roots, no remote environments or reconfiguration. Native controls are requirements-only, not ordinary config enforcement. Plugin and MCP contribution routes remain applicable.',
  computer:'Scoped inapplicability only for observed headless local stdio, new-only closed-method client with no dynamic tools, no selected roots, no remote environments or reconfiguration. Native controls are requirements-only, not ordinary config enforcement. Plugin and MCP contribution routes remain applicable.',
  'mcp-ordinary':'The full effective loader constructs configured registrations and extensions; resolved disabled semantics survive catalog composition and enabled filtering precedes connection creation. Actual effective restrictions or valid registration monitoring at both boundaries remain required.',
  'mcp-managed-cloud':'Managed/cloud layers participate in the full effective loader. Selected remote-environment discovery skips local environments. The local plugin provider has cloud=None; optional cloud contribution paths remain plugins-gated. This is not a claim of a global MCP disable gate.',
  'mcp-plugin':'Effective plugins disabled yields empty selected plugin servers and connector snapshots; local provider cloud=None plus optional cloud feature gates remain independently covered. Final configured registration enablement is filtered before connection creation.',
  'remote-control':'The remote_control feature toggle is ignored and confers no enforcement. Fresh isolated SQLite state without enabled enrollment, correct client persistence key, no enable RPC, actual disabled status, local stdio scope and complete owned drainage are required.',
  hooks:'Effective hooks disabled AND disabled plugins with empty plugin hook sources yield an empty hooks engine; otherwise builtin handlers may remain. Require the combined observed restrictions at both admitted lifecycle boundaries.',
  'legacy-notify':'Legacy notify is constructed independently from nonempty notify argv. Actual empty notify argv is required in addition to the effective hooks and plugin restrictions.',
  apps:'Apps disabled removes the hosted extension contribution, prevents/removes compatibility registration, and removes the final Apps server. All consumers and actual observed effective disabled policy are required.',
  web:'Web disabled produces no hosted search tool and also disables standalone web-search extension availability and tool contribution. Both distinct consumers and observed effective policy are required.',
 };
 const routes=STARTUP_MONITOR_PATHS.flatMap(path=>STARTUP_SOURCES.flatMap(source=>(['bootstrap','thread-start'] as const).map(lifecycle=>({path,source,lifecycle,enforcement:['browser-native','browser-cdp','computer'].includes(path)?'inapplicable' as const:'persistent-restriction' as const,sourceEvidence:evidence([...common,...runtimeConsumers[path]])}))));
 const requirementsSources=STARTUP_SOURCES.map(source=>({source,sourceEvidence:evidence(common)}));
 const sources=evidence([...common,...Object.values(runtimeConsumers).flat(),['codex-rs/protocol/src/shell_environment.rs','inherit_filter_and_runtime_additions'],['codex-rs/core/src/exec_env.rs','runtime_injected_environment_values'],['codex-rs/config/src/strict_config.rs','strict_unknown_field_rejection']]);
 const interpretations=STARTUP_MONITOR_PATHS.map(path=>({path,semantics:semantics[path],sources:evidence([...common,...runtimeConsumers[path]])}));
 const body={routes,requirementsSources,sources,interpretations};return {status:'UNREVIEWED' as const,...body,candidateHash:fingerprint(body)};
}
/** Data-only candidate builder. It retains the exact controller-reviewed scope;
 * artifact bytes, real preparation provenance and source interpretation still
 * require the existing independent accepted review before any closure. */
export function buildPinnedStartupSourceMap(input:{commit:string;sources:readonly StartupSourcePin[];target:QualificationTarget;proof:StartupSessionProof;fixtureHash:string;scope:StartupLocalScope;scopeEvidence:StartupArtifactRef;managedConflict?:StartupArtifactRef;boundaryEvidence?:StartupArtifactRef[]}):{manifest:StartupCoverageManifest;scope:StartupLocalScope;sources:StartupSourcePin[]}{
 if(input.commit!==PINNED_STARTUP_SOURCE_COMMIT)throw Error('SOURCE_COMMIT_CHANGED');
 const pins=new Map<string,StartupSourcePin>();for(const raw of input.sources){const pin=z.strictObject({path:z.string(),blobHash:HashSchema,artifact:z.strictObject({id:IdSchema,sha256:HashSchema})}).parse(raw);if(pins.has(pin.path)||!(pin.path in PINNED_STARTUP_SOURCE_HASHES)||pin.blobHash!==PINNED_STARTUP_SOURCE_HASHES[pin.path as SourcePath]||pin.artifact.sha256!==pin.blobHash)throw Error('SOURCE_BLOB_CHANGED');pins.set(pin.path,pin);}
 if(Object.keys(PINNED_STARTUP_SOURCE_HASHES).some(path=>!pins.has(path)))throw Error('SOURCE_SET_INCOMPLETE');
 // The existing builder checks the actual LIVE owned/policy/target binding.
 const base=buildStartupCoverageManifest({...input,routes:[{path:'plugins',source:'packaged',lifecycle:'bootstrap',enforcement:'persistent-restriction',sourceEvidence:[{commit:input.commit,path:'codex-rs/core-plugins/src/manager.rs',blobHash:pins.get('codex-rs/core-plugins/src/manager.rs')!.blobHash,artifact:pins.get('codex-rs/core-plugins/src/manager.rs')!.artifact,consumer:'plugins_for_config'}]}]});
 const scope=validateStartupLocalScope(input.scope,input.proof,base.targetHash,input.fixtureHash),config=scope.configuration;
 if(!config.appsDisabled||!config.hooksDisabled||!config.notifyDisabled||!config.webDisabled||!config.mcpDisabled||config.optionalConflict||['plugins','browser','browserExternal','browserCdp','computer'].some(key=>config.states[key as keyof typeof config.states]!=='disabled')||config.selectedPermissionsHash!==input.proof.policy!.permissionsHash||config.shellEnvironmentPolicyHash!==input.proof.policy!.shellEnvironmentPolicyHash)throw Error('OBSERVED_RESTRICTIONS_UNPROVEN');
 const evidence=(consumers:readonly Consumer[]):Source[]=>{const seen=new Set<string>();return consumers.filter(([path,consumer])=>{const key=path+':'+consumer;if(seen.has(key))return false;seen.add(key);return true;}).map(([path,consumer])=>({commit:input.commit,path,blobHash:pins.get(path)!.blobHash,artifact:structuredClone(pins.get(path)!.artifact),consumer}));};
 const sourceLoader=(source:typeof STARTUP_SOURCES[number]):readonly Consumer[]=>source==='managed'||source==='cloud'||source==='system'?[['codex-rs/config/src/loader/managed_requirements.rs','load_managed_requirements_state'],['codex-rs/config/src/requirements_layers/stack.rs','compose_requirements']]:source==='plugin'?plugins:source==='session'?[['codex-rs/config/src/loader/mod.rs','load_config_layers_state:cli_overrides']]:[['codex-rs/config/src/loader/local.rs','load_local_config_layers']];
 const terminalGate=(path:typeof STARTUP_MONITOR_PATHS[number],lifecycle:'bootstrap'|'thread-start'):Consumer=>path==='mcp-ordinary'?mcp[lifecycle==='bootstrap'?1:2]!:path==='mcp-managed-cloud'?mcp[3]!:path==='mcp-plugin'?plugins[1]!:path==='remote-control'?pathConsumers[path][3]!:path==='legacy-notify'?pathConsumers[path][1]!:pathConsumers[path].at(-1)!;
 const routes=STARTUP_MONITOR_PATHS.flatMap(path=>STARTUP_SOURCES.flatMap(source=>(['bootstrap','thread-start'] as const).map(lifecycle=>({path,source,lifecycle,enforcement:['browser-native','browser-cdp','computer'].includes(path)?'inapplicable' as const:'persistent-restriction' as const,sourceEvidence:evidence([source==='managed'||source==='cloud'||source==='system'||source==='plugin'||source==='session'?sourceLoader(source)[0]!:load[0]!,terminalGate(path,lifecycle)])}))));
 const requirementsSources=STARTUP_SOURCES.map(source=>({source,sourceEvidence:evidence([...load,...sourceLoader(source),['codex-rs/config/src/loader/managed_requirements.rs','load_managed_requirements_state'],['codex-rs/config/src/requirements_layers/stack.rs','compose_requirements']])}));
 const sourceCatalog=evidence([...load,...Object.values(pathConsumers).flat(),...STARTUP_SOURCES.flatMap(source=>sourceLoader(source)),['codex-rs/config/src/loader/managed_requirements.rs','load_managed_requirements_state'],['codex-rs/config/src/requirements_layers/stack.rs','compose_requirements']]);
 return {manifest:buildStartupCoverageManifest({...input,routes,requirementsSources,sourceCatalog}),scope,sources:[...pins.values()].map(pin=>structuredClone(pin))};
}
