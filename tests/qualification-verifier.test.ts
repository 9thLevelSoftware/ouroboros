import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openStore, type RunStore } from '../src/store/database.ts';
import type { Result } from '../src/contracts/common.ts';
import { LaunchSpecSchema, type LaunchSpec, type OwnedExecution, type Supervisor, type ChildOutput, type DrainEvidence } from '../src/contracts/execution.ts';
import { QualificationLedger, targetFingerprint, type QualificationTarget, type QualificationRequest } from '../src/qualification/ledger.ts';
import { createProbeManifest, fingerprint } from '../src/qualification/probes.ts';
import { controllerSources, createVerifierSliceCli, parseKnownFolders } from '../src/qualification/codex-windows.ts';
import { VERIFIER_SLICE_PROBES, validateVerifierProfile, scanConfigKeys, inspectConfigLayers, sealVerifierSlice, slicePermit, runVerifierSlice, createSliceRequest, sliceLaunchHash,
 type ConfigLayerObservation, type SealedVerifierSlice } from '../src/qualification/verifier-slice.ts';

// Scripted supervisor fixtures only: no codex.exe, helper, sandbox, network or model runs here.
const scratch = resolve('.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-slice-unit');
const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function value<T>(result: Result<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.value; }
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const config: ConfigLayerObservation = { schemaVersion: 1, systemConfigPresent: false, requirementsPresent: false, userConfig: { sha256: 'c'.repeat(64), watchedKeys: ['sandbox_mode', 'windows.sandbox'] }, projectMarkersAbsent: true };

type Script = { stdout?: string; stderr?: string; effect?: (fixtureRoot: string) => void; drain?: 'complete' | 'incomplete' | 'throws';
 outputs?: Array<{ stream: 'stdout' | 'stderr'; data: string; delayMs?: number }>; failAfterAuthorize?: boolean; describeThrows?: boolean };
function fixture() {
 mkdirSync(scratch, { recursive: true }); const base = mkdtempSync(join(scratch, 'case-')); const fixtureRoot = join(base, 'fixture');
 const bin = join(base, 'bin'); mkdirSync(bin);
 for (const name of ['codex.exe', 'helper.exe', 'node.exe']) writeFileSync(join(bin, name), `fake ${name}`);
 const pinned = (name: string) => ({ path: join(bin, name), sha256: sha(join(bin, name)) });
 const target: QualificationTarget = { schemaVersion: 1, provider: 'codex', environment: 'windows', runtime: { ...pinned('codex.exe'), version: '0.162.1' },
  adapter: { version: 'fixture', sha256: 'a'.repeat(64) }, helper: { ...pinned('helper.exe'), version: 'fixture' }, verifier: { ...pinned('codex.exe'), version: '0.162.1', wrapperHash: 'a'.repeat(64) },
  os: { platform: 'win32', architecture: 'x64', release: 'fixture', sha256: 'a'.repeat(64) }, policyHash: 'a'.repeat(64), startupConfigHash: 'a'.repeat(64), model: 'fixture', effort: 'high' };
 const manifest = createProbeManifest(fixtureRoot, target);
 for (const path of Object.values(manifest.roots)) mkdirSync(path, { recursive: true });
 for (const sentinel of manifest.sentinels) writeFileSync(sentinel.path, sentinel.bytes);
 writeFileSync(join(manifest.roots.workspace, 'allowed.txt'), 'allowed fixture baseline\r\n');
 copyFileSync(resolve('tests/fixtures/boundary/boundary-driver.mjs'), join(manifest.roots.driver, 'boundary-driver.mjs'));
 const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture', APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local', SystemDrive: 'C:', TEMP: join(fixtureRoot, 'trusted-temp'), TMP: join(fixtureRoot, 'trusted-temp') };
 const sealed = value(sealVerifierSlice(manifest, { codex: pinned('codex.exe'), helper: pinned('helper.exe'), node: pinned('node.exe'),
  driverSha256: sha(resolve('tests/fixtures/boundary/boundary-driver.mjs')), env, config, targetHash: targetFingerprint(target) }));
 const store = openStore(join(base, 'controller')); stores.push(store);
 const runId = randomUUID(); const repoId = randomUUID();
 value(store.createRun(repoId, { schemaVersion: 1, id: runId, taskId: randomUUID(), phase: 'CREATED', blocker: null, generation: 0, baselineRef: null, candidateRef: null,
  sessionRef: null, repairCount: 0, cumulativeBudgets: { activeMs: 0, outputBytes: 0, tokens: null, requests: null, money: null }, pendingActionIds: [] }));
 const owner = value(store.claim(repoId, runId));
 const now = Date.now();
 const request: QualificationRequest = { schemaVersion: 1, id: randomUUID(), owner, actionId: randomUUID(), targetHash: targetFingerprint(target), manifestHash: fingerprint(manifest),
  fixtureRoots: [fixtureRoot], permittedEndpoints: [], approvedProbeIds: [...VERIFIER_SLICE_PROBES], budget: { maxAttempts: 2, activeMs: 120000, outputBytes: 131072 },
  approvedAt: now, expiresAt: now + 600000 };
 const ledger = new QualificationLedger(store, { authorizeCurrent: slicePermit(sealed, request.id) }); value(ledger.approve(target, request));
 return { base, fixtureRoot, manifest, sealed, store, owner, request, ledger };
}
function scripted(f: ReturnType<typeof fixture>, scripts: Partial<Record<string, Script>>, hooks: { mutate?: (spec: LaunchSpec) => LaunchSpec } = {}) {
 const launched: string[] = [];
 const supervisorFor = (authorize: (spec: Readonly<LaunchSpec>) => Promise<boolean>): Supervisor => ({
  async launchOwned(input) {
   let spec = LaunchSpecSchema.parse(input); if (hooks.mutate) spec = hooks.mutate(spec);
   if (!(await authorize(Object.freeze(spec)))) return { ok: false, error: { code: 'EXECUTION_NOT_AUTHORIZED', message: 'denied', evidenceIds: [] } };
   const probeId = spec.authorization.kind === 'qualification' ? spec.authorization.probeId : '';
   const script = scripts[probeId] ?? {}; if (script.failAfterAuthorize) return { ok: false, error: { code: 'LAUNCH_FAILED', message: 'helper lost', evidenceIds: [] } };
   launched.push(probeId); script.effect?.(f.fixtureRoot);
   const at = Date.now(); const ids = { runId: spec.runId, generation: spec.generation, actionId: spec.actionId, role: spec.role };
   const evidence = (complete: boolean): DrainEvidence => ({ schemaVersion: 1, ...ids, reason: 'fixture', requestAcknowledged: true, requestedAt: at, acknowledgedAt: at,
    rootExited: complete, rootExitedAt: complete ? at : null, membershipEmpty: complete, membershipObservedAt: at, activeProcesses: complete ? 0 : 1, unresolvedExecutions: complete ? [] : [42],
    outputComplete: true, unresolvedOutputStreams: [], outputCompletedAt: at, childRanBeforeAssignment: false, completedAt: at });
   const outputs: ChildOutput[] = [...(script.stdout ? [{ stream: 'stdout' as const, data: Buffer.from(script.stdout) }] : []), ...(script.stderr ? [{ stream: 'stderr' as const, data: Buffer.from(script.stderr) }] : [])];
   const execution: OwnedExecution = {
    async describe() { if (script.describeThrows) throw Error('describe lost'); return { schemaVersion: 1, ...ids, environment: 'windows', pid: 4242, creationIdentity: 'root-creation', helperPid: 4141, helperCreationIdentity: 'helper-creation',
     jobIdentity: 'job', boundaryHash: spec.boundaryHash, assignedBeforeResume: true, capturedAt: at }; },
    async fence() {}, async renewLease() {},
    async drain() { if (script.drain === 'throws') throw Error('helper lost'); return evidence(script.drain !== 'incomplete'); },
    onOutput(listener) { queueMicrotask(() => { for (const output of outputs) listener(output); });
     for (const later of script.outputs ?? []) setTimeout(() => listener({ stream: later.stream, data: Buffer.from(later.data) }), later.delayMs ?? 0); return () => {}; },
    async writeInput() { return { ok: false, error: { code: 'INPUT_CLOSED', message: 'closed', evidenceIds: [] } }; },
    async endInput() { return { ok: true, value: undefined }; },
   };
   return { ok: true, value: execution };
  },
 });
 return { launched, supervisorFor };
}
const deps = (f: ReturnType<typeof fixture>, s: ReturnType<typeof scripted>, inspect: () => Result<ConfigLayerObservation> = () => ({ ok: true, value: config })) =>
 ({ ledger: f.ledger, store: f.store, requestId: f.request.id, supervisorFor: s.supervisorFor, inspectConfig: inspect, caseMs: 300, renewalMs: 50, graceMs: 120 });
const deniedOk: Script = { stderr: 'RESULT:OPERATION_ERROR:EACCES\n' };
const allowedOk: Script = { stdout: 'RESULT:WRITE_SUCCEEDED\n', effect: root => writeFileSync(join(root, 'workspace/allowed.txt'), 'ATTEMPTED_DISPOSABLE_MUTATION\r\n') };

it('slice_profile_rejects_unknown_or_inherited_keys', () => {
 const f = fixture(); const profile = structuredClone(f.manifest.profiles.initialNetworkDenied) as Record<string, any>;
 expect(validateVerifierProfile(profile).ok).toBe(true);
 for (const mutate of [(p: any) => { p.extends = ':workspace'; }, (p: any) => { p.network.enabeld = false; }, (p: any) => { delete p.network.enabled; },
  (p: any) => { p.network.enabled = true; }, (p: any) => { p.filesystem['D:\\other'] = 'none'; }, (p: any) => { p.workspace_roots = {}; }, (p: any) => { p.network.domains = { 'example.com': 'allow' }; }]) {
  const copy = structuredClone(profile); mutate(copy); const result = validateVerifierProfile(copy); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('VERIFIER_PROFILE_INVALID');
 }
});
it('slice_config_scan_blocks_profile_keys_and_reports_watched', () => {
 const text = 'model = "x"\nsandbox_mode = "workspace-write"\n# [permissions.fake]\n[windows]\nsandbox = "elevated"\n[features]\nprefer_mxc = true\n';
 expect(scanConfigKeys(text)).toEqual({ blocked: [], watched: ['sandbox_mode', 'windows.sandbox', 'features.prefer_mxc'] });
 expect(scanConfigKeys('[permissions.ouroboros_verifier]\nextends = ":workspace"\n').blocked).toEqual(['permissions.ouroboros_verifier', 'permissions.ouroboros_verifier.extends']);
 expect(scanConfigKeys('default_permissions = ":workspace"\nprofile = "x"\n[profiles.x]\na = 1\nallowed_permission_profiles = []\n').blocked)
  .toEqual(['default_permissions', 'profile', 'profiles.x', 'profiles.x.a', 'profiles.x.allowed_permission_profiles']);
});
it('slice_inspect_rejects_system_layers_and_project_codex', () => {
 const f = fixture(); const programData = join(f.base, 'ProgramData'); const codexHome = join(f.base, 'codex-home'); mkdirSync(codexHome);
 writeFileSync(join(codexHome, 'config.toml'), 'sandbox_mode = "read-only"\n');
 const clean = value(inspectConfigLayers({ programDataDir: programData, codexHome, workspace: f.manifest.roots.workspace, stopAt: f.base }));
 expect(clean).toMatchObject({ systemConfigPresent: false, requirementsPresent: false, projectMarkersAbsent: true, userConfig: { sha256: sha(join(codexHome, 'config.toml')), watchedKeys: ['sandbox_mode'] } });
 mkdirSync(join(programData, 'OpenAI', 'Codex'), { recursive: true }); writeFileSync(join(programData, 'OpenAI', 'Codex', 'requirements.toml'), '');
 const system = inspectConfigLayers({ programDataDir: programData, codexHome, workspace: f.manifest.roots.workspace, stopAt: f.base }); expect(system.ok).toBe(false);
 if (!system.ok) expect(system.error.code).toBe('CONFIG_LAYER_UNSUPPORTED');
 const projectBase = mkdtempSync(join(scratch, 'project-')); mkdirSync(join(projectBase, 'w', '.codex'), { recursive: true });
 const project = inspectConfigLayers({ programDataDir: join(projectBase, 'none'), codexHome, workspace: join(projectBase, 'w'), stopAt: projectBase }); expect(project.ok).toBe(false);
 writeFileSync(join(codexHome, 'config.toml'), '[permissions.ouroboros_verifier]\n');
 expect(inspectConfigLayers({ programDataDir: join(projectBase, 'none'), codexHome, workspace: f.manifest.roots.workspace, stopAt: f.base }).ok).toBe(false);
});
it('slice_seal_binds_manifest_argv_and_is_deterministic', () => {
 const f = fixture(); const again = value(sealVerifierSlice(f.manifest, { codex: f.sealed.codex, helper: f.sealed.helper, node: f.sealed.node, driverSha256: f.sealed.driver.sha256, env: f.sealed.env, config, targetHash: f.sealed.targetHash }));
 expect(again.sealHash).toBe(f.sealed.sealHash);
 expect(f.sealed.launches['verifier.denied_sensitive_read'].argv).toEqual([...f.manifest.verifier.argvPrefix, f.sealed.node.path, '--preserve-symlinks-main', join(f.manifest.roots.driver, 'boundary-driver.mjs'), 'denied_sensitive_read', f.fixtureRoot]);
 const drifted = value(sealVerifierSlice(f.manifest, { codex: f.sealed.codex, helper: f.sealed.helper, node: f.sealed.node, driverSha256: f.sealed.driver.sha256, env: f.sealed.env,
  config: { ...config, userConfig: { ...config.userConfig, sha256: 'd'.repeat(64) } }, targetHash: f.sealed.targetHash }));
 expect(drifted.sealHash).not.toBe(f.sealed.sealHash);
 const tampered = structuredClone(f.manifest); (tampered.verifier.argvPrefix as string[])[3] = 'permissions.ouroboros_verifier={}';
 const result = sealVerifierSlice(tampered, { codex: f.sealed.codex, helper: f.sealed.helper, node: f.sealed.node, driverSha256: f.sealed.driver.sha256, env: f.sealed.env, config, targetHash: f.sealed.targetHash });
 expect(result.ok).toBe(false);
});
it('slice_denied_read_pass_then_allowed_pass', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': deniedOk, 'verifier.allowed_command': allowedOk });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(s.launched).toEqual(['verifier.denied_sensitive_read', 'verifier.allowed_command']);
 expect(outcome.attempts.map(a => [a.probeId, a.observation!.status, a.observation!.result])).toEqual([['verifier.denied_sensitive_read', 'PASS', 'blocked'], ['verifier.allowed_command', 'PASS', 'allowed']]);
 expect(outcome.effectiveProfileProven).toBe(true);
 const report = value(f.ledger.report(f.request.id, []));
 expect(report.probes.filter(p => VERIFIER_SLICE_PROBES.includes(p.id as never)).map(p => p.status)).toEqual(['PASS', 'PASS']);
});
it('slice_sensitive_read_success_fails_and_stops_allowed', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { stdout: 'RESULT:SENSITIVE_READ_SUCCEEDED\n' }, 'verifier.allowed_command': allowedOk });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(s.launched).toEqual(['verifier.denied_sensitive_read']);
 expect(outcome.attempts).toHaveLength(1); expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', result: 'allowed', sensitiveBytesRead: true });
 expect(outcome.effectiveProfileProven).toBe(false); expect(outcome.stoppedAt).toBe('verifier.denied_sensitive_read');
});
it('slice_missing_result_is_error_not_blocked', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { stderr: 'windows sandbox failed: CreateProcessInSandbox failed\n' } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', result: 'error', reasonCode: 'SANDBOX_RESULT_MISSING' }); expect(s.launched).toHaveLength(1);
});
it('slice_allowed_postimage_mismatch_fails', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': deniedOk, 'verifier.allowed_command': { stdout: 'RESULT:WRITE_SUCCEEDED\n' } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[1].observation).toMatchObject({ status: 'FAIL', reasonCode: 'POSTIMAGE_MISMATCH' });
});
it('slice_incomplete_drain_fails', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { ...deniedOk, drain: 'incomplete' } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', reasonCode: 'DRAIN_INCOMPLETE' });
});
it('slice_drain_failure_leaves_dispatched_and_blocks', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { ...deniedOk, drain: 'throws' } });
 const result = await runVerifierSlice(f.sealed, deps(f, s)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('RECOVERY_REQUIRED');
 const attempt = value(f.ledger.history(f.request.id)).attempts[0]; expect(attempt.observation).toBeNull();
 expect(value(f.store.loadAction(attempt.actionId)).state).toBe('DISPATCHED');
 const next = f.ledger.beginAttempt(f.request.id, 'verifier.allowed_command', { actionId: randomUUID(), launchHash: 'a'.repeat(64), repairEvidenceIds: [] });
 expect(next.ok).toBe(false); if (!next.ok) expect(next.error.code).toBe('RECOVERY_REQUIRED');
});
it('slice_time_of_use_drift_refuses_launch', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': deniedOk }); let calls = 0;
 const drift = () => ({ ok: true as const, value: ++calls === 1 ? config : { ...config, userConfig: { ...config.userConfig, sha256: 'e'.repeat(64) } } });
 const result = await runVerifierSlice(f.sealed, deps(f, s, drift)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('PRELAUNCH_REFUSED');
 expect(s.launched).toEqual([]);
 const attempt = value(f.ledger.history(f.request.id)).attempts[0]; expect(value(f.store.loadAction(attempt.actionId)).state).toBe('OBSERVED');
});
it('slice_spec_mismatch_refuses', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': deniedOk }, { mutate: spec => ({ ...spec, argv: [...spec.argv.slice(0, -2), 'allowed_edit', spec.argv.at(-1)!] }) });
 const result = await runVerifierSlice(f.sealed, deps(f, s)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('PRELAUNCH_REFUSED');
 expect(s.launched).toEqual([]);
});

// Review fix round 1. New behavior must fail before the fix; guards are demonstrated separately by recorded mutation runs.
const sealInput = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) => ({ codex: f.sealed.codex, helper: f.sealed.helper, node: f.sealed.node,
 driverSha256: f.sealed.driver.sha256, env: f.sealed.env, config, targetHash: 'a'.repeat(64), ...extra });
it('review1_scan_blocks_shell_environment_policy', () => {
 expect(scanConfigKeys('[shell_environment_policy]\nset = { NODE_OPTIONS = "--require x" }\n').blocked.length).toBeGreaterThan(0);
 expect(scanConfigKeys('shell_environment_policy.inherit = "all"\n').blocked.length).toBeGreaterThan(0);
});
it('review1_scan_fails_closed_on_quoted_and_unparseable_keys', () => {
 expect(scanConfigKeys('permissions.ouroboros_verifier.filesystem."C:\\\\x" = "write"\n').blocked.length).toBeGreaterThan(0);
 expect(scanConfigKeys("'permissions' = {}\n").blocked.length).toBeGreaterThan(0);
 expect(scanConfigKeys('"unterminated = 1\n').blocked.length).toBeGreaterThan(0);
 // Multi-line values are not keys: this must not block.
 expect(scanConfigKeys('notes = """\n[permissions]\n"""\nmodel = "x"\nlist = [\n  "profiles",\n]\n')).toEqual({ blocked: [], watched: [] });
});
it('review1_inspect_refuses_unreadable_system_layer', () => {
 mkdirSync(scratch, { recursive: true }); const base = mkdtempSync(join(scratch, 'pd-')); writeFileSync(join(base, 'OpenAI'), 'not a directory');
 const result = inspectConfigLayers({ programDataDir: base, codexHome: join(base, 'none'), workspace: join(base, 'w'), stopAt: base });
 expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('CONFIG_LAYER_UNSUPPORTED');
});
it('review1_seal_binds_target_hash', () => {
 const f = fixture(); const one = value(sealVerifierSlice(f.manifest, sealInput(f) as never)); const two = value(sealVerifierSlice(f.manifest, sealInput(f, { targetHash: 'b'.repeat(64) }) as never));
 expect(one.sealHash).not.toBe(two.sealHash);
});
it('review1_request_lifetime_fits_ledger', () => {
 const f = fixture(); const request = createSliceRequest({ owner: f.owner, targetHash: f.request.targetHash, manifestHash: f.request.manifestHash, fixtureRoot: f.fixtureRoot, now: Date.now() });
 expect(request.expiresAt - request.approvedAt).toBeLessThanOrEqual(600000); expect(request.approvedProbeIds).toEqual([...VERIFIER_SLICE_PROBES]);
 const ledger = new QualificationLedger(f.store, { authorizeCurrent: () => false });
 const target = value(f.ledger.history(f.request.id)).target; expect(ledger.approve(target, request).ok).toBe(true);
});
it('review1_profile_grants_node_read', () => {
 const f = fixture(); expect((f.manifest.profiles.initialNetworkDenied.filesystem as Record<string, string>)[dirname(process.execPath)]).toBe('read');
});
it('review1_denial_accepts_only_access_errors', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { stderr: 'RESULT:OPERATION_ERROR:ENOENT\n' } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', result: 'error' }); expect(s.launched).toHaveLength(1);
});
it('review1_allowed_preimage_must_be_baseline', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { ...deniedOk, effect: root => writeFileSync(join(root, 'workspace/allowed.txt'), 'tampered') }, 'verifier.allowed_command': allowedOk });
 const result = await runVerifierSlice(f.sealed, deps(f, s)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('PRELAUNCH_REFUSED');
 expect(s.launched).toEqual(['verifier.denied_sensitive_read']);
});
it('review1_trailing_output_after_result_is_classified', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { ...deniedOk, outputs: [{ stream: 'stderr', data: 'late diagnostic\n', delayMs: 40 }] } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', result: 'error' });
});
it('review1_extra_line_with_valid_result_is_error', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { stderr: 'RESULT:OPERATION_ERROR:EPERM\nunexpected diagnostic\n' } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', result: 'error' });
});
it('review1_launch_failure_after_dispatch_is_recovery', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { failAfterAuthorize: true } });
 const result = await runVerifierSlice(f.sealed, deps(f, s)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('RECOVERY_REQUIRED');
 const attempt = value(f.ledger.history(f.request.id)).attempts[0]; expect(value(f.store.loadAction(attempt.actionId)).state).toBe('DISPATCHED');
});
it('review1_overflow_is_error', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { stdout: 'x'.repeat(70000) + '\n', stderr: 'RESULT:OPERATION_ERROR:EPERM\n' } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', result: 'error', reasonCode: 'OUTPUT_LIMIT_EXCEEDED' });
});
it('review1_permit_refuses_other_hash_or_request', () => {
 const f = fixture(); const permit = slicePermit(f.sealed, f.request.id); const good = sliceLaunchHash(f.sealed, 'verifier.denied_sensitive_read');
 expect(permit(f.request, 'verifier.denied_sensitive_read', good)).toBe(true);
 expect(permit(f.request, 'verifier.denied_sensitive_read', 'f'.repeat(64))).toBe(false);
 expect(permit(f.request, 'verifier.allowed_command', good)).toBe(false);
 expect(permit({ ...f.request, id: randomUUID() }, 'verifier.denied_sensitive_read', good)).toBe(false);
 expect(permit(f.request, 'worker.allowed_edit', good)).toBe(false);
});
it('review1_binary_drift_at_time_of_use_refuses', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': deniedOk }); let codexReads = 0;
 const hashFile = (path: string) => path === f.sealed.codex.path && ++codexReads > 1 ? 'e'.repeat(64) : (() => { try { return sha(path); } catch { return null; } })();
 const result = await runVerifierSlice(f.sealed, { ...deps(f, s), hashFile }); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('PRELAUNCH_REFUSED');
 expect(s.launched).toEqual([]);
});

// Review fix round 2 (final). New behavior must fail before the fix; guards are demonstrated by recorded mutation runs.
it('review2_scan_blocks_escaped_quoted_keys', () => {
 expect(scanConfigKeys('"\\u0070ermissions" = {}\n').blocked.length).toBeGreaterThan(0);
 expect(scanConfigKeys('["shell_environment_\\u0070olicy"]\nset = {}\n').blocked.length).toBeGreaterThan(0);
 expect(scanConfigKeys('a."b\\tc" = 1\n').blocked.length).toBeGreaterThan(0);
});
it('review2_wrapper_covers_all_controller_sources', () => {
 const sources = controllerSources(resolve('.'));
 for (const path of ['src/cli/doctor.ts', 'src/contracts/common.ts', 'src/store/schema.sql', 'src/qualification/verifier-slice.ts', 'package-lock.json', 'tests/fixtures/boundary/boundary-driver.mjs']) expect(sources).toContain(path);
 expect([...sources].sort()).toEqual(sources);
});
it('review2_known_folders_cross_check_profile', () => {
 const env = { ProgramData: 'C:\\ProgramData', USERPROFILE: 'C:\\Users\\fixture' };
 expect(parseKnownFolders('C:\\ProgramData\r\nC:\\Users\\fixture\r\n', env)).toEqual({ programData: 'C:\\ProgramData', profile: 'C:\\Users\\fixture' });
 expect(() => parseKnownFolders('C:\\ProgramData\r\nC:\\Users\\other\r\n', env)).toThrow();
 expect(() => parseKnownFolders('C:\\ProgramData\r\n', env)).toThrow();
});
function cliFixture() {
 mkdirSync(scratch, { recursive: true }); const base = mkdtempSync(join(scratch, 'cli-'));
 const runtime = join(base, 'codex.exe'); const helper = join(base, 'helper.exe'); writeFileSync(runtime, 'fake codex'); writeFileSync(helper, 'fake helper');
 // Keep the absent fixture outside repository ancestors so config-layer guards remain genuine.
 const container = mkdtempSync(join(dirname(resolve('.')), 'ouroboros-cli-unit-')); const fixtureRoot = join(container, 'fixture');
 const controllerRoot = join(base, 'controller'); const programData = join(base, 'ProgramData'); const profile = join(base, 'profile'); mkdirSync(profile);
 const args = { provider: 'codex' as const, environment: 'windows' as const, fixtureRoot, model: 'fixture', effort: 'high' };
 const options = { installationRoot: resolve('.'), controllerRoot, runtimePath: runtime, helperPath: helper, pinnedRuntimeHash: sha(runtime), knownFolders: () => ({ programData, profile }) };
 return { base, fixtureRoot, controllerRoot, args, options };
}
it('review2_cli_dry_run_creates_nothing_and_approved_run_composes', async () => {
 const c = cliFixture();
 const s = scripted({ fixtureRoot: c.fixtureRoot } as never, { 'verifier.denied_sensitive_read': deniedOk, 'verifier.allowed_command': allowedOk });
 const cli = createVerifierSliceCli({ ...c.options, supervisorFor: s.supervisorFor });
 const dry = await cli(c.args, null); expect(dry.launched).toBe(false);
 expect(existsSync(c.fixtureRoot)).toBe(false); expect(existsSync(c.controllerRoot)).toBe(false);
 const run = await cli(c.args, dry.sealHash);
 expect(run).toMatchObject({ launched: true, sealHash: dry.sealHash, passed: true, ownershipReleased: true, error: null });
 expect(s.launched).toEqual(['verifier.denied_sensitive_read', 'verifier.allowed_command']);
 expect(JSON.parse(readFileSync(join(c.fixtureRoot, 'seal.json'), 'utf8')).sealHash).toBe(dry.sealHash);
});
it('review2_cli_wrong_hash_creates_nothing', async () => {
 const c = cliFixture(); const s = scripted({ fixtureRoot: c.fixtureRoot } as never, {});
 const cli = createVerifierSliceCli({ ...c.options, supervisorFor: s.supervisorFor });
 await expect(cli(c.args, 'f'.repeat(64))).rejects.toThrow('Approved seal does not match');
 expect(existsSync(c.fixtureRoot)).toBe(false); expect(existsSync(c.controllerRoot)).toBe(false); expect(s.launched).toEqual([]);
});
it('review2_allowed_operation_error_is_error', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': deniedOk, 'verifier.allowed_command': { stderr: 'RESULT:OPERATION_ERROR:EPERM\n' } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[1].observation).toMatchObject({ status: 'FAIL', result: 'error' });
});
it('review2_deadline_without_output_is_error', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': {} });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', result: 'error', reasonCode: 'SANDBOX_RESULT_MISSING' });
});
it('review2_split_result_line_is_classified', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { outputs: [{ stream: 'stderr', data: 'RESULT:OPERATION_' }, { stream: 'stderr', data: 'ERROR:EPERM\n', delayMs: 10 }] }, 'verifier.allowed_command': allowedOk });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'PASS', result: 'blocked' });
});
it('review2_sentinel_change_fails', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { ...deniedOk, effect: root => writeFileSync(join(root, 'fake-credential/sentinel.txt'), 'changed') } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', reasonCode: 'SENTINEL_CHANGED' });
});
it('review2_ownership_unavailable_fails', async () => {
 const f = fixture(); const s = scripted(f, { 'verifier.denied_sensitive_read': { ...deniedOk, describeThrows: true } });
 const outcome = value(await runVerifierSlice(f.sealed, deps(f, s)));
 expect(outcome.attempts[0].observation).toMatchObject({ status: 'FAIL', reasonCode: 'OWNERSHIP_UNAVAILABLE' });
});

// Repair 1 (after the first live FAIL). Built without fixture() so the fixture's environment cannot be the RED cause.
function sealOnly(env: Record<string, string>) {
 const pin = (name: string) => ({ path: `C:\\pinned\\${name}`, sha256: 'a'.repeat(64) });
 const target: QualificationTarget = { schemaVersion: 1, provider: 'codex', environment: 'windows', runtime: { ...pin('codex.exe'), version: '0.162.1' },
  adapter: { version: 'fixture', sha256: 'a'.repeat(64) }, helper: { ...pin('helper.exe'), version: 'fixture' }, verifier: { ...pin('codex.exe'), version: '0.162.1', wrapperHash: 'a'.repeat(64) },
  os: { platform: 'win32', architecture: 'x64', release: 'fixture', sha256: 'a'.repeat(64) }, policyHash: 'a'.repeat(64), startupConfigHash: 'a'.repeat(64), model: 'fixture', effort: 'high' };
 const fixtureRoot = 'D:\\repair-fixture'; const manifest = createProbeManifest(fixtureRoot, target);
 const base = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture', APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local', TEMP: join(fixtureRoot, 'trusted-temp'), TMP: join(fixtureRoot, 'trusted-temp') };
 return { manifest, result: sealVerifierSlice(manifest, { codex: pin('codex.exe'), helper: pin('helper.exe'), node: pin('node.exe'), driverSha256: 'b'.repeat(64), env: { ...base, ...env }, config, targetHash: 'c'.repeat(64) }) };
}
it('repair1_seal_requires_system_drive_matching_system_root', () => {
 const missing = sealOnly({}).result; expect(missing.ok).toBe(false);
 const mismatched = sealOnly({ SystemDrive: 'D:' }).result; expect(mismatched.ok).toBe(false);
 const matching = sealOnly({ SystemDrive: 'C:' }).result; expect(matching.ok).toBe(true);
 if (matching.ok) expect(matching.value.env.SystemDrive).toBe('C:');
});
it('repair1_node_launch_preserves_symlinks_main', () => {
 const { manifest, result } = sealOnly({ SystemDrive: 'C:' }); const sealed = value(result);
 for (const probeId of VERIFIER_SLICE_PROBES) {
  const argv = sealed.launches[probeId].argv; const nodeAt = argv.indexOf('C:\\pinned\\node.exe');
  expect(argv.slice(nodeAt, nodeAt + 3)).toEqual(['C:\\pinned\\node.exe', '--preserve-symlinks-main', join(manifest.roots.driver, 'boundary-driver.mjs')]);
  expect(argv.length).toBe(nodeAt + 5);
 }
});
it('repair1_cli_child_env_has_system_drive', async () => {
 const c = cliFixture(); const cli = createVerifierSliceCli({ ...c.options, supervisorFor: scripted({ fixtureRoot: c.fixtureRoot } as never, {}).supervisorFor });
 const dry = await cli(c.args, null); expect(dry.launched).toBe(false);
 if (!dry.launched) expect((dry.seal as { envKeys: string[] }).envKeys).toContain('SystemDrive');
 expect(existsSync(c.fixtureRoot)).toBe(false);
});
