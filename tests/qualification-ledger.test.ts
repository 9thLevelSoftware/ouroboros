import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openStore, type RunStore } from '../src/store/database.ts';
import { publishArtifact } from '../src/store/artifacts.ts';
import type { Result } from '../src/contracts/common.ts';
import { QualificationLedger, targetFingerprint, type QualificationTarget, type QualificationRequest, type ProbeObservation } from '../src/qualification/ledger.ts';
import { REQUIRED_CODEX_WINDOWS_PROBES, createProbeManifest, startupBlockers } from '../src/qualification/probes.ts';
import { qualify, parseQualificationArguments } from '../src/qualification/codex-windows.ts';
import { main } from '../src/cli/main.ts';

const scratch = resolve('.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-unit-fixtures');
const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function value<T>(result: Result<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message); return result.value; }
const hash = 'a'.repeat(64);
function target(): QualificationTarget {
 return { schemaVersion: 1, provider: 'codex', environment: 'windows', runtime: { path: 'D:\\pinned\\codex.exe', version: '0.162.1', sha256: hash },
  adapter: { version: '0.1.0', sha256: hash }, helper: { path: 'D:\\pinned\\supervisor.exe', version: '0.1.0', sha256: hash },
  verifier: { path: 'D:\\pinned\\codex.exe', version: '0.162.1', sha256: hash, wrapperHash: hash },
  os: { platform: 'win32', architecture: 'x64', release: 'fixture-windows-build', sha256: hash },
  policyHash: hash, startupConfigHash: hash, model: 'configured-fixture-model', effort: 'high' };
}
function fixture(options: { authorize?: boolean; maxAttempts?: number } = {}) {
 mkdirSync(scratch, { recursive: true }); const root = mkdtempSync(join(scratch, 'ledger-'));
 const store = openStore(join(root, 'controller')); stores.push(store); const repoId = randomUUID(); const runId = randomUUID();
 value(store.createRun(repoId, { schemaVersion: 1, id: runId, taskId: randomUUID(), phase: 'CREATED', blocker: null, generation: 0,
  baselineRef: null, candidateRef: null, sessionRef: null, repairCount: 0, cumulativeBudgets: { activeMs: 0, outputBytes: 0, tokens: null, requests: null, money: null }, pendingActionIds: [] }));
 const owner = value(store.claim(repoId, runId)); const t = target();
 const request: QualificationRequest = { schemaVersion: 1, id: randomUUID(), owner, actionId: randomUUID(), targetHash: targetFingerprint(t),
  manifestHash: hash, fixtureRoots: [join(root, 'disposable')], permittedEndpoints: [], approvedProbeIds: REQUIRED_CODEX_WINDOWS_PROBES.map(p => p.id),
  budget: { maxAttempts: options.maxAttempts ?? 100, activeMs: 600000, outputBytes: 10485760 }, approvedAt: Date.now(), expiresAt: Date.now() + 600000 };
 const ledger = new QualificationLedger(store, { authorizeCurrent: () => options.authorize !== false });
 value(ledger.approve(t, request)); return { root, store, owner, ledger, request, target: t };
}
async function evidence(f: ReturnType<typeof fixture>, actionId: string, category = 'operation') {
 async function* bytes() { yield Buffer.from(`SIMULATED controller observation: ${category}`); }
 const artifact = value(await publishArtifact(f.store, bytes(), { schemaVersion: 1, id: randomUUID(), owner: f.owner, actionId, mediaType: 'application/json', secrets: [] }));
 return { id: artifact.id, sha256: artifact.sha256, category };
}
async function finish(f: ReturnType<typeof fixture>, probeId: string, status: 'PASS' | 'FAIL' | 'UNTESTED', actualAttempt = true) {
 const attempt = value(f.ledger.beginAttempt(f.request.id, probeId, { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: status === 'FAIL' ? [] : [] }));
 value(f.ledger.dispatchAttempt(attempt.id, hash));
 const observation: ProbeObservation = { schemaVersion: 1, status, evidenceKind: 'fixture', actualAttempt,
  result: actualAttempt ? 'blocked' : 'not_attempted', evidence: [await evidence(f, attempt.actionId)],
  sentinel: { before: hash, after: hash }, sensitiveBytesRead: false, elapsedMs: 1, outputBytes: 1, reasonCode: 'SIMULATED_BOUNDARY_RESULT' };
 return value(f.ledger.finishAttempt(attempt.id, observation));
}

it('runtime_change_invalidates_receipt', () => {
 const f = fixture(); value(f.ledger.report(f.request.id, ['STARTUP_UNQUALIFIED']));
 const changed = { ...f.target, runtime: { ...f.target.runtime, sha256: 'b'.repeat(64) } };
 expect(targetFingerprint(changed)).not.toBe(targetFingerprint(f.target));
 const receipt = f.ledger.lookupQualification(changed); expect(receipt.ok).toBe(false);
 if (!receipt.ok) expect(receipt.error.code).toBe('NEEDS_REVALIDATION');
 for (const change of [{ helper: { ...f.target.helper, sha256: 'b'.repeat(64) } }, { model: 'other' }, { effort: 'low' },
  { verifier: { ...f.target.verifier, wrapperHash: 'b'.repeat(64) } }, { startupConfigHash: 'b'.repeat(64) }, { os: { ...f.target.os, release: 'other' } }]) {
  expect(targetFingerprint({ ...f.target, ...change })).not.toBe(targetFingerprint(f.target));
 }
});
it('unexecuted_denial_is_not_pass', async () => {
 const f = fixture(); const result = await finish(f, 'worker.denied_source_write', 'PASS', false);
 expect(result.observation?.status).toBe('UNTESTED');
 const report = value(f.ledger.report(f.request.id, [])); expect(report.qualified).toBe(false);
 expect(report.probes.find(p => p.id === 'worker.denied_source_write')?.status).toBe('UNTESTED');
 expect(f.ledger.lookupQualification(f.target).ok).toBe(false);
});
it('preserves_prior_attempts', async () => {
 const f = fixture(); const first = await finish(f, 'worker.denied_source_write', 'FAIL');
 const correction = value(f.ledger.beginAttempt(f.request.id, 'worker.denied_source_write', { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: first.observation!.evidence.map(e => e.id) }));
 value(f.ledger.dispatchAttempt(correction.id, hash));
 value(f.ledger.finishAttempt(correction.id, { schemaVersion: 1, status: 'PASS', evidenceKind: 'fixture', actualAttempt: true, result: 'blocked',
  evidence: [await evidence(f, correction.actionId)], sentinel: { before: hash, after: hash }, sensitiveBytesRead: false, elapsedMs: 1, outputBytes: 1, reasonCode: 'SIMULATED_REPAIRED_RESULT' }));
 f.store.close(); const reopened = openStore(join(f.root, 'controller')); stores.push(reopened);
 const history = value(new QualificationLedger(reopened, { authorizeCurrent: () => true }).history(f.request.id));
 expect(history.attempts).toHaveLength(2); expect(history.attempts.map(a => a.observation?.status)).toEqual(['FAIL', 'PASS']);
 expect(history.attempts.map(a => a.ordinal)).toEqual([0, 1]);
 expect(value(reopened.listQualifications(f.owner.runId)).map(r => r.kind)).toEqual(['REQUEST', 'ATTEMPT_INTENT', 'ATTEMPT_RESULT', 'ATTEMPT_INTENT', 'ATTEMPT_RESULT']);
});
it('doctor_without_qualify_has_no_effects', async () => {
 const effects: string[] = []; const baseline = Buffer.from('unchanged fixture');
 mkdirSync(scratch, { recursive: true }); const file = join(mkdtempSync(join(scratch, 'passive-')), 'source-sentinel'); writeFileSync(file, baseline);
 let output = ''; const doctor = { platform: 'win32', nodeVersion: '24', inspectVersion: async () => 'codex-cli 0.162.1',
  credentialSourcePresence: () => ({}), lookupQualification: async () => undefined };
 const deps = { doctor, stdout: (s: string) => { output += s; }, stderr: () => {}, qualify: async () => { effects.push('qualify'); throw Error('must not run'); } };
 expect(await main(['doctor', '--json'], deps)).toBe(0); expect(effects).toEqual([]); expect(readFileSync(file)).toEqual(baseline);
 expect(JSON.parse(output).qualification).toBe('UNQUALIFIED');
 expect(await main(['doctor', '--fixture-root', 'D:\\somewhere'], deps)).toBe(2); expect(effects).toEqual([]);
});
it('store_extension_fences_duplicates_and_compare_and_swap', () => {
 const f = fixture(); const records = value(f.store.listQualifications(f.owner.runId)); const envelope = { ...records[0], id: randomUUID(), kind: 'REPORT' as const };
 expect(f.store.appendQualification({ ...f.owner, nonce: randomUUID() }, envelope, 1).ok).toBe(false);
 expect(f.store.appendQualification(f.owner, envelope, 0).ok).toBe(false);
 value(f.store.appendQualification(f.owner, envelope, 1));
 expect(f.store.appendQualification(f.owner, { ...envelope, payload: {} }, 2).ok).toBe(false);
 expect(f.store.appendQualification(f.owner, { ...envelope, id: randomUUID(), payload: { invalid: Infinity } }, 2).ok).toBe(false);
 expect(value(f.store.listQualifications(f.owner.runId))).toHaveLength(2);
});
it('pending_dispatch_is_not_replayed_or_reused', () => {
 const f = fixture(); const attempt = value(f.ledger.beginAttempt(f.request.id, 'worker.denied_source_write', { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: [] }));
 value(f.ledger.dispatchAttempt(attempt.id, hash)); value(f.store.unknown(f.owner, attempt.actionId));
 const reopened = new QualificationLedger(f.store, { authorizeCurrent: () => true });
 expect(reopened.beginAttempt(f.request.id, 'worker.denied_source_write', { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: [] }).ok).toBe(false);
 expect(reopened.dispatchAttempt(attempt.id, hash).ok).toBe(false); expect(reopened.lookupQualification(f.target).ok).toBe(false);
 expect(value(f.store.loadAction(attempt.actionId)).state).toBe('OUTCOME_UNKNOWN');
});
it('fresh_probe_authority_and_finite_attempt_budget_are_required', () => {
 const f = fixture({ authorize: false });
 expect(f.ledger.beginAttempt(f.request.id, 'worker.denied_source_write', { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: [] }).ok).toBe(false);
 const g = fixture({ maxAttempts: 1 });
 const a = value(g.ledger.beginAttempt(g.request.id, 'worker.denied_source_write', { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: [] }));
 expect(g.ledger.dispatchAttempt(a.id, 'b'.repeat(64)).ok).toBe(false);
 expect(g.ledger.beginAttempt(g.request.id, 'verifier.denied_source_write', { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: [] }).ok).toBe(false);
});
it('missing_or_changed_evidence_blocks_pass', async () => {
 const f = fixture(); const attempt = value(f.ledger.beginAttempt(f.request.id, 'worker.denied_source_write', { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: [] }));
 value(f.ledger.dispatchAttempt(attempt.id, hash)); const ref = await evidence(f, attempt.actionId); writeFileSync(join(f.store.root, 'artifacts', ref.sha256), 'changed');
 const result = value(f.ledger.finishAttempt(attempt.id, { schemaVersion: 1, status: 'PASS', evidenceKind: 'live', actualAttempt: true, result: 'blocked',
  evidence: [ref], sentinel: { before: hash, after: hash }, sensitiveBytesRead: false, elapsedMs: 1, outputBytes: 1, reasonCode: 'SIMULATED_RESULT' }));
 expect(result.observation?.status).toBe('FAIL'); expect(result.observation?.reasonCode).toBe('INVALID_EVIDENCE');
});
it('fixture_pass_cannot_qualify_live_and_worker_does_not_cover_verifier', async () => {
 const f = fixture(); await finish(f, 'worker.denied_source_write', 'PASS');
 const report = value(f.ledger.report(f.request.id, [])); expect(report.qualified).toBe(false);
 expect(report.probes.find(p => p.id === 'worker.denied_source_write')?.status).toBe('PASS');
 expect(report.probes.find(p => p.id === 'verifier.denied_source_write')?.status).toBe('UNTESTED');
 expect(f.ledger.lookupQualification(f.target).ok).toBe(false);
});
it('two_unsuccessful_corrective_candidates_stop_without_counter_reset', async () => {
 const f = fixture(); let first = await finish(f, 'worker.denied_source_write', 'FAIL');
 for (let ordinal = 1; ordinal <= 2; ordinal++) {
  const attempt = value(f.ledger.beginAttempt(f.request.id, first.probeId, { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: first.observation!.evidence.map(e => e.id) }));
  value(f.ledger.dispatchAttempt(attempt.id, hash)); first = value(f.ledger.finishAttempt(attempt.id, { ...first.observation!, evidence: [await evidence(f, attempt.actionId)] }));
  expect(first.ordinal).toBe(ordinal);
 }
 const result = new QualificationLedger(f.store, { authorizeCurrent: () => true }).beginAttempt(f.request.id, first.probeId, { actionId: randomUUID(), launchHash: hash, repairEvidenceIds: first.observation!.evidence.map(e => e.id) });
 expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('REPAIR_LIMIT_REACHED');
});
it('staged_preflight_records_untested_without_runtime_network_or_auth_effects', async () => {
 const f = fixture(); const manifest = createProbeManifest(f.request.fixtureRoots[0], f.target); const blockers = startupBlockers();
 expect(blockers).toEqual(expect.arrayContaining(['PLUGIN_STARTUP_UNPROVEN', 'BROWSER_COMPUTER_STARTUP_UNPROVEN', 'MCP_INVENTORY_UNPROVEN']));
 expect(manifest.probes.filter(p => p.role === 'verifier').length).toBeGreaterThan(5);
 expect(manifest.network.endpoints.every(e => e.fixtureOwned)).toBe(true);
 const report = await qualify(f.target, f.request, { ledger: f.ledger });
 expect(report.qualified).toBe(false); expect(report.blockers).toContain('PLUGIN_STARTUP_UNPROVEN'); expect(report.probes.every(p => p.status === 'UNTESTED')).toBe(true);
 expect(value(f.ledger.history(f.request.id)).attempts).toEqual([]);
 expect(parseQualificationArguments(['--provider', 'codex', '--environment', 'windows', '--fixture-root', 'relative', '--model', 'model']).ok).toBe(false);
 expect(parseQualificationArguments(['--provider', 'codex', '--environment', 'windows', '--fixture-root', 'D:\\fixture', '--model', 'model', '--model', 'other']).ok).toBe(false);
});
