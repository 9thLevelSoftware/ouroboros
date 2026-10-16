import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, type RunStore } from '../src/store/database.ts';
import { publishArtifact } from '../src/store/artifacts.ts';
import type { Result } from '../src/contracts/common.ts';
import { QualificationLedger, targetFingerprint, type QualificationTarget, type QualificationRequest } from '../src/qualification/ledger.ts';
import { createProbeManifest, REQUIRED_CODEX_WINDOWS_PROBES } from '../src/qualification/probes.ts';

const scratch = resolve('.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-fix-1-unit');
const hash = 'a'.repeat(64); const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function value<T>(result: Result<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message); return result.value; }
const binary = { path: 'D:\\pinned\\runtime.exe', version: '0.162.1', sha256: hash };
function target(): QualificationTarget { return { schemaVersion: 1, provider: 'codex', environment: 'windows', runtime: binary,
 adapter: { version: 'fixture', sha256: hash }, helper: { ...binary, version: 'fixture' }, verifier: { ...binary, wrapperHash: hash },
 os: { platform: 'win32', architecture: 'x64', release: 'fixture', sha256: hash }, policyHash: hash, startupConfigHash: hash, model: 'fixture', effort: 'high' }; }
function fixture() {
 mkdirSync(scratch, { recursive: true }); const root = mkdtempSync(join(scratch, 'case-')); const store = openStore(join(root, 'controller')); stores.push(store);
 const runId = randomUUID(); const repoId = randomUUID(); value(store.createRun(repoId, { schemaVersion: 1, id: runId, taskId: randomUUID(), phase: 'CREATED', blocker: null,
  generation: 0, baselineRef: null, candidateRef: null, sessionRef: null, repairCount: 0, cumulativeBudgets: { activeMs: 0, outputBytes: 0, tokens: null, requests: null, money: null }, pendingActionIds: [] }));
 const owner = value(store.claim(repoId, runId)); const t = target();
 const request: QualificationRequest = { schemaVersion: 1, id: randomUUID(), owner, actionId: randomUUID(), targetHash: targetFingerprint(t), manifestHash: hash,
  fixtureRoots: [join(root, 'disposable')], permittedEndpoints: [], approvedProbeIds: REQUIRED_CODEX_WINDOWS_PROBES.map(p => p.id), budget: { maxAttempts: 96, activeMs: 600000, outputBytes: 10485760 }, approvedAt: Date.now(), expiresAt: Date.now() + 600000 };
 const ledger = new QualificationLedger(store, { authorizeCurrent: () => true }); value(ledger.approve(t, request)); return { root, store, owner, request, ledger };
}
async function observe(f: ReturnType<typeof fixture>, probeId: string, status: 'PASS' | 'FAIL', repairEvidenceIds: string[] = [], evidenceKind: 'live' | 'fixture' | 'fault_injection' = 'fixture') {
 const attempt = value(f.ledger.beginAttempt(f.request.id, probeId, { actionId: randomUUID(), launchHash: hash, repairEvidenceIds })); value(f.ledger.dispatchAttempt(attempt.id, hash));
 async function* bytes() { yield Buffer.from('SIMULATED bounded operation receipt'); }
 const artifact = value(await publishArtifact(f.store, bytes(), { schemaVersion: 1, id: randomUUID(), owner: f.owner, actionId: attempt.actionId, mediaType: 'application/json', secrets: [] }));
 return value(f.ledger.finishAttempt(attempt.id, { schemaVersion: 1, status, evidenceKind, actualAttempt: true, result: 'blocked',
  evidence: [{ id: artifact.id, sha256: artifact.sha256, category: 'operation' }], sentinel: { before: hash, after: hash }, sensitiveBytesRead: false, elapsedMs: 1, outputBytes: 1, reasonCode: 'SIMULATED_RESULT' }));
}
function begin(f: ReturnType<typeof fixture>, probeId: string, repairEvidenceIds: string[] = []) { return f.ledger.beginAttempt(f.request.id, probeId, { actionId: randomUUID(), launchHash: hash, repairEvidenceIds }); }
const evidenceIds = (attempt: Awaited<ReturnType<typeof observe>>) => attempt.observation!.evidence.map(e => e.id);

it('manifest_verifier_command_binds_driver_operation_and_fixture_root', () => {
 const manifest = createProbeManifest('D:\\disposable\\exact-root', target());
 expect(manifest.verifier.command.argv).toEqual([join(manifest.roots.driver, 'boundary-driver.mjs'), 'allowed_edit', manifest.fixtureRoot]);
 const commands = (manifest.verifier as unknown as { commands: Array<{ probeId: string; supported: boolean; operation?: string; argv?: string[] }> }).commands;
 expect(commands.find(c => c.probeId === 'verifier.allowed_command')).toMatchObject({ supported: true, operation: 'allowed_edit', argv: manifest.verifier.command.argv });
 for (const name of ['source', 'controller', 'sibling']) expect(commands.find(c => c.probeId === `verifier.denied_${name}_write`)?.argv).toEqual([join(manifest.roots.driver, 'boundary-driver.mjs'), `denied_${name}_write`, manifest.fixtureRoot]);
 expect(commands.find(c => c.probeId === 'verifier.denied_sensitive_read')?.argv).toEqual([join(manifest.roots.driver, 'boundary-driver.mjs'), 'denied_sensitive_read', manifest.fixtureRoot]);
});
it('unsupported_verifier_drivers_have_no_executable_argv', () => {
 const manifest = createProbeManifest('D:\\disposable\\exact-root', target());
 const commands = (manifest.verifier as unknown as { commands: Array<{ probeId: string; supported: boolean; reasonCode?: string; argv?: string[] }> }).commands;
 expect(commands).toBeDefined();
 for (const id of ['verifier.allowed_proxy_network', 'verifier.link_escape', 'verifier.broker_escape']) {
  expect(commands.find(c => c.probeId === id)).toMatchObject({ supported: false, reasonCode: 'FIXED_DRIVER_UNIMPLEMENTED' });
  expect(commands.find(c => c.probeId === id)?.argv).toBeUndefined();
 }
});
it('manifest_allowed_command_runs_one_finite_trusted_unit_driver', () => {
 // The only subprocess in this new suite. It is ordinary Node in an explicitly
 // owned unit fixture, with no sandbox/provider/network/native qualification.
 mkdirSync(scratch, { recursive: true }); const root = mkdtempSync(join(scratch, 'driver-')); const manifest = createProbeManifest(root, target());
 mkdirSync(manifest.roots.driver, { recursive: true }); mkdirSync(manifest.roots.workspace, { recursive: true });
 copyFileSync(resolve('tests/fixtures/boundary/boundary-driver.mjs'), join(manifest.roots.driver, 'boundary-driver.mjs'));
 writeFileSync(join(manifest.roots.workspace, 'allowed.txt'), 'before');
 // Assertions intentionally precede launch: RED cannot execute the broken argv.
 expect(manifest.verifier.command.argv).toHaveLength(3); expect(manifest.verifier.command.argv[1]).toBe('allowed_edit'); expect(manifest.verifier.command.argv[2]).toBe(root);
 const result = spawnSync(process.execPath, manifest.verifier.command.argv, { cwd: manifest.roots.workspace, shell: false, windowsHide: true, timeout: 3000, maxBuffer: 4096,
  env: Object.fromEntries(['SystemRoot', 'WINDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]!])) });
 expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout.toString()).toBe('RESULT:WRITE_SUCCEEDED\n'); expect(result.stderr.length).toBe(0);
 expect(readFileSync(join(manifest.roots.workspace, 'allowed.txt'), 'utf8')).toBe('ATTEMPTED_DISPOSABLE_MUTATION\r\n');
});
it('required_fail_blocks_another_probe_without_writing_new_intent', async () => {
 const f = fixture(); await observe(f, 'worker.denied_source_write', 'FAIL'); const before = value(f.store.listQualifications(f.owner.runId));
 const next = begin(f, 'verifier.denied_source_write'); expect(next.ok).toBe(false); if (!next.ok) expect(next.error.code).toBe('REQUIRED_PROBE_FAILED');
 expect(value(f.store.listQualifications(f.owner.runId))).toEqual(before); expect(value(f.store.loadRun(f.owner.runId)).pendingActionIds).toEqual([]);
});
it('only_supported_repair_of_affected_failure_can_resume_request', async () => {
 const f = fixture(); const failed = await observe(f, 'worker.denied_source_write', 'FAIL');
 expect(begin(f, 'worker.denied_source_write').ok).toBe(false); expect(begin(f, 'verifier.denied_source_write', evidenceIds(failed)).ok).toBe(false);
 await observe(f, failed.probeId, 'PASS', evidenceIds(failed)); expect(begin(f, 'verifier.denied_source_write').ok).toBe(true);
});
it('repair_limit_blocks_every_probe_after_reopen', async () => {
 const f = fixture(); let failed = await observe(f, 'worker.denied_source_write', 'FAIL');
 failed = await observe(f, failed.probeId, 'FAIL', evidenceIds(failed)); failed = await observe(f, failed.probeId, 'FAIL', evidenceIds(failed));
 f.store.close(); const reopened = openStore(join(f.root, 'controller')); stores.push(reopened); const ledger = new QualificationLedger(reopened, { authorizeCurrent: () => true });
 for (const id of [failed.probeId, 'verifier.denied_source_write']) {
  const result = ledger.beginAttempt(f.request.id, id, { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: evidenceIds(failed) }); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('REPAIR_LIMIT_REACHED');
 }
 expect(value(ledger.history(f.request.id)).attempts).toHaveLength(3);
});
it('unsuccessful_corrective_count_is_cumulative_across_repaired_probes', async () => {
 const f = fixture(); let a = await observe(f, 'worker.denied_source_write', 'FAIL'); a = await observe(f, a.probeId, 'FAIL', evidenceIds(a));
 await observe(f, a.probeId, 'PASS', evidenceIds(a)); let b = await observe(f, 'verifier.denied_source_write', 'FAIL'); b = await observe(f, b.probeId, 'FAIL', evidenceIds(b));
 const reopenedLedger = new QualificationLedger(f.store, { authorizeCurrent: () => true });
 const result = reopenedLedger.beginAttempt(f.request.id, b.probeId, { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: evidenceIds(b) });
 expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('REPAIR_LIMIT_REACHED');
 expect(begin({ ...f, ledger: reopenedLedger }, 'verifier.denied_sibling_write').ok).toBe(false);
});
// Fix round 2: a failure clears only through a PASS of the same evidence class.
it('fix2_fixture_pass_cannot_clear_live_failure', async () => {
 const f = fixture(); const failed = await observe(f, 'worker.denied_source_write', 'FAIL', [], 'live');
 const simulated = await observe(f, failed.probeId, 'PASS', evidenceIds(failed), 'fixture'); expect(simulated.observation!.status).toBe('PASS');
 const before = value(f.store.listQualifications(f.owner.runId));
 const next = begin(f, 'verifier.denied_source_write'); expect(next.ok).toBe(false); if (!next.ok) expect(next.error.code).toBe('REQUIRED_PROBE_FAILED');
 expect(value(f.store.listQualifications(f.owner.runId))).toEqual(before);
});
it('fix2_fixture_pass_cannot_clear_fault_injection_failure', async () => {
 // The fixed simulated observation satisfies this probe's PASS proof, so the
 // fixture PASS is genuinely recorded; only the evidence class differs.
 const f = fixture(); const failed = await observe(f, 'worker.denied_source_write', 'FAIL', [], 'fault_injection');
 const simulated = await observe(f, failed.probeId, 'PASS', evidenceIds(failed), 'fixture'); expect(simulated.observation!.status).toBe('PASS');
 const before = value(f.store.listQualifications(f.owner.runId));
 const next = begin(f, 'verifier.denied_source_write'); expect(next.ok).toBe(false); if (!next.ok) expect(next.error.code).toBe('REQUIRED_PROBE_FAILED');
 expect(value(f.store.listQualifications(f.owner.runId))).toEqual(before);
});
it('fix2_live_correction_remains_available_after_fixture_pass', async () => {
 const f = fixture(); const failed = await observe(f, 'worker.denied_source_write', 'FAIL', [], 'live');
 const simulated = await observe(f, failed.probeId, 'PASS', evidenceIds(failed), 'fixture');
 const citesSimulation = begin(f, failed.probeId, evidenceIds(simulated)); expect(citesSimulation.ok).toBe(false); if (!citesSimulation.ok) expect(citesSimulation.error.code).toBe('SUPPORTED_REPAIR_REQUIRED');
 await observe(f, failed.probeId, 'PASS', evidenceIds(failed), 'live');
 expect(begin(f, 'verifier.denied_source_write').ok).toBe(true);
});
it('fix2_same_class_fixture_simulation_still_clears', async () => {
 const f = fixture(); const failed = await observe(f, 'worker.denied_source_write', 'FAIL', [], 'fixture');
 await observe(f, failed.probeId, 'PASS', evidenceIds(failed), 'fixture');
 expect(begin(f, 'verifier.denied_source_write').ok).toBe(true);
});
