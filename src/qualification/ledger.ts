import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import { IdSchema, HashSchema, PathSchema, TextSchema, BytesSchema, PositiveLimitSchema, type Result } from '../contracts/common.ts';
import { OwnerTokenSchema, type OwnerToken } from '../contracts/evidence.ts';
import { OwnershipReceiptSchema, WindowsDrainEvidenceSchema } from '../contracts/execution.ts';
import { RuntimeCapabilitiesSchema, type RuntimeCapabilities } from '../contracts/provider.ts';
import { storeError, type RunStore, type QualificationEnvelope } from '../store/database.ts';
import { REQUIRED_CODEX_WINDOWS_PROBES, fingerprint } from './probes.ts';

const Identity = z.strictObject({ version: TextSchema, sha256: HashSchema });
const Binary = Identity.extend({ path: PathSchema });
export const QualificationTargetSchema = z.strictObject({
 schemaVersion: z.literal(1), provider: z.literal('codex'), environment: z.literal('windows'), runtime: Binary, adapter: Identity, helper: Binary,
 verifier: Binary.extend({ wrapperHash: HashSchema }), os: z.strictObject({ platform: z.literal('win32'), architecture: TextSchema, release: TextSchema, sha256: HashSchema }),
 policyHash: HashSchema, startupConfigHash: HashSchema, model: TextSchema, effort: TextSchema,
});
export type QualificationTarget = z.infer<typeof QualificationTargetSchema>;
export function targetFingerprint(target: QualificationTarget): string { return fingerprint(QualificationTargetSchema.parse(target)); }
const AbsoluteFixture = PathSchema.refine(path => /^[A-Za-z]:[\\/]/.test(path) && !path.split(/[\\/]/).some(p => p === '..' || p === '.') && !path.slice(2).includes(':'), 'Absolute non-aliased Windows fixture required');
export const QualificationRequestSchema = z.strictObject({
 schemaVersion: z.literal(1), id: IdSchema, owner: OwnerTokenSchema, actionId: IdSchema, targetHash: HashSchema, manifestHash: HashSchema,
 fixtureRoots: z.array(AbsoluteFixture).min(1).max(8), permittedEndpoints: z.array(z.string().url()).max(16),
 approvedProbeIds: z.array(TextSchema).min(1).max(64), budget: z.strictObject({ maxAttempts: PositiveLimitSchema.max(192), activeMs: PositiveLimitSchema.max(600000), outputBytes: PositiveLimitSchema.max(10485760) }),
 approvedAt: PositiveLimitSchema, expiresAt: PositiveLimitSchema,
}).superRefine((request, ctx) => {
 if (request.owner.generation < 1 || request.expiresAt <= request.approvedAt || request.expiresAt - request.approvedAt > 600000 ||
  new Set(request.approvedProbeIds).size !== request.approvedProbeIds.length || request.approvedProbeIds.some(id => !REQUIRED_CODEX_WINDOWS_PROBES.some(p => p.id === id)) ||
  new Set(request.fixtureRoots.map(p => win32.normalize(p).toLowerCase())).size !== request.fixtureRoots.length) ctx.addIssue({ code: 'custom', message: 'Qualification scope, lifetime or owner is invalid' });
 for (const endpoint of request.permittedEndpoints) { const url = new URL(endpoint); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ctx.addIssue({ code: 'custom', message: 'Only named credential-free disposable loopback endpoints are supported' }); }
});
export type QualificationRequest = z.infer<typeof QualificationRequestSchema>;
const EvidenceRef = z.strictObject({ id: IdSchema, sha256: HashSchema, category: TextSchema });
export const ProbeObservationSchema = z.strictObject({
 schemaVersion: z.literal(1), status: z.enum(['PASS', 'FAIL', 'UNTESTED']), evidenceKind: z.enum(['live', 'fixture', 'fault_injection']),
 actualAttempt: z.boolean(), result: z.enum(['allowed', 'blocked', 'stopped', 'observed', 'refused', 'not_attempted', 'error']), evidence: z.array(EvidenceRef).max(64),
 sentinel: z.strictObject({ before: HashSchema, after: HashSchema }).optional(), sensitiveBytesRead: z.boolean().optional(),
 ownership: OwnershipReceiptSchema.optional(), drain: WindowsDrainEvidenceSchema.optional(),
 heartbeat: z.strictObject({ beforeBytes: BytesSchema, afterBytes: BytesSchema, stableMs: BytesSchema }).optional(), unrelatedProcessAlive: z.boolean().optional(),
 facts: z.record(TextSchema, z.union([z.string().max(256), z.boolean(), z.number().finite()])).optional(),
 elapsedMs: BytesSchema, outputBytes: BytesSchema, reasonCode: z.string().regex(/^[A-Z0-9_]{1,96}$/),
});
export type ProbeObservation = z.infer<typeof ProbeObservationSchema>;
const AttemptSchema = z.strictObject({ schemaVersion: z.literal(1), id: IdSchema, requestId: IdSchema, targetHash: HashSchema,
 probeId: TextSchema, owner: OwnerTokenSchema, actionId: IdSchema, launchHash: HashSchema, ordinal: z.number().int().min(0).max(2),
 repairEvidenceIds: z.array(IdSchema).max(64), startedAt: PositiveLimitSchema, deadline: PositiveLimitSchema, observation: ProbeObservationSchema.nullable() });
export type ProbeAttempt = z.infer<typeof AttemptSchema>;
const ApprovalPayload = z.strictObject({ target: QualificationTargetSchema, request: QualificationRequestSchema });
export const QualificationReportSchema = z.strictObject({ schemaVersion: z.literal(1), id: IdSchema, requestId: IdSchema, target: QualificationTargetSchema,
 targetHash: HashSchema, qualified: z.boolean(), blockers: z.array(TextSchema), createdAt: PositiveLimitSchema,
 probes: z.array(z.strictObject({ id: TextSchema, status: z.enum(['PASS', 'FAIL', 'UNTESTED']), evidenceKind: z.enum(['live', 'fixture', 'fault_injection']).nullable(), attemptIds: z.array(IdSchema), evidenceIds: z.array(IdSchema) })) });
export type QualificationReport = z.infer<typeof QualificationReportSchema>;
type History = { target: QualificationTarget; request: QualificationRequest; attempts: ProbeAttempt[]; revision: number };
type LedgerOptions = { authorizeCurrent(request: Readonly<QualificationRequest>, probeId: string, launchHash: string): boolean };
function frozen<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function json(value: unknown): z.infer<ReturnType<typeof z.json>> { return JSON.parse(JSON.stringify(value)); }

/** Trusted controller observations only. A reusable receipt never grants current execution authority. */
export class QualificationLedger {
 readonly store: RunStore;
 readonly options: LedgerOptions;
 constructor(store: RunStore, options: LedgerOptions) { if (typeof options.authorizeCurrent !== 'function') throw Error('Current probe authorization resolver required'); this.store = store; this.options = options; }
 #records(runId?: string): Result<QualificationEnvelope[]> { try { return this.store.listQualifications(runId); } catch { return storeError('INVALID_LEDGER', 'Qualification history is corrupt or unsupported'); } }
 #append(owner: OwnerToken, requestId: string, actionId: string, targetHash: string, kind: QualificationEnvelope['kind'], payload: unknown, expectedCount: number): Result<void> {
  return this.store.appendQualification(owner, { schemaVersion: 1, id: randomUUID(), runId: owner.runId, generation: owner.generation, actionId, requestId, targetHash, kind, payload: json(payload) }, expectedCount);
 }
 approve(targetInput: QualificationTarget, requestInput: QualificationRequest): Result<void> {
  const target = QualificationTargetSchema.safeParse(targetInput); const request = QualificationRequestSchema.safeParse(requestInput);
  if (!target.success || !request.success || targetFingerprint(target.data) !== request.data.targetHash || request.data.expiresAt <= Date.now()) return storeError('INVALID_QUALIFICATION_REQUEST', 'Bounded current target approval required');
  const records = this.#records(request.data.owner.runId); if (!records.ok) return records;
  if (records.value.some(r => r.requestId === request.data.id)) return storeError('DUPLICATE_QUALIFICATION', 'Qualification request is immutable');
  const intent = this.store.intent(request.data.owner, { schemaVersion: 1, id: request.data.actionId, runId: request.data.owner.runId, kind: 'QUALIFICATION_APPROVAL', payload: { targetHash: request.data.targetHash, manifestHash: request.data.manifestHash } });
  if (!intent.ok) return intent;
  const appended = this.#append(request.data.owner, request.data.id, request.data.actionId, request.data.targetHash, 'REQUEST', { target: target.data, request: request.data }, records.value.length);
  if (!appended.ok) return appended;
  // Recording approval has no runtime operation; explicitly reconcile the metadata action.
  return this.store.outcome(request.data.owner, request.data.actionId, { schemaVersion: 1, status: 'RECONCILED', evidenceIds: [] });
 }
 history(requestId: string): Result<History> {
  const records = this.#records(); if (!records.ok) return records;
  try {
   const entries = records.value.filter(r => r.requestId === requestId); const approvals = entries.filter(r => r.kind === 'REQUEST');
   if (approvals.length !== 1) return storeError('QUALIFICATION_NOT_FOUND', 'Exactly one immutable approval required');
   const { target, request } = ApprovalPayload.parse(approvals[0].payload);
   if (targetFingerprint(target) !== request.targetHash) throw Error('Target mismatch');
   const attempts: ProbeAttempt[] = [];
   for (const entry of entries) {
    if (entry.targetHash !== request.targetHash || entry.runId !== request.owner.runId || entry.generation !== request.owner.generation) throw Error('Envelope mismatch');
    if (entry.kind === 'ATTEMPT_INTENT' || entry.kind === 'ATTEMPT_RESULT') {
     const attempt = AttemptSchema.parse(entry.payload);
     if (attempt.requestId !== request.id || attempt.targetHash !== request.targetHash || attempt.actionId !== entry.actionId || fingerprint(attempt.owner) !== fingerprint(request.owner)) throw Error('Attempt mismatch');
     const prior = attempts.findIndex(a => a.id === attempt.id);
     if (entry.kind === 'ATTEMPT_INTENT') { if (prior !== -1 || attempt.observation !== null) throw Error('Duplicate intent'); attempts.push(attempt); }
     else { if (prior === -1 || attempts[prior].observation !== null || fingerprint({ ...attempt, observation: null }) !== fingerprint(attempts[prior])) throw Error('Invalid result'); attempts[prior] = attempt; }
    }
   }
   return { ok: true, value: { target, request, attempts, revision: records.value.filter(r => r.runId === request.owner.runId).length } };
  } catch { return storeError('INVALID_LEDGER', 'Qualification history bindings are invalid'); }
 }
 beginAttempt(requestId: string, probeId: string, input: { actionId: string; launchHash: string; repairEvidenceIds: string[] }): Result<ProbeAttempt> {
  const history = this.history(requestId); if (!history.ok) return history; const { request, attempts } = history.value;
  if (!request.approvedProbeIds.includes(probeId) || request.expiresAt <= Date.now() || !HashSchema.safeParse(input.launchHash).success) return storeError('EXECUTION_NOT_AUTHORIZED', 'Probe or exact launch is outside current approval');
  if (attempts.some(a => a.observation === null)) return storeError('RECOVERY_REQUIRED', 'An unresolved qualification attempt cannot be replayed');
  const reconciliation = this.store.reconcileEvidence(request.owner.runId); if (!reconciliation.ok) return reconciliation;
  if (reconciliation.value.unknownActionIds.length) return storeError('RECOVERY_REQUIRED', 'Unresolved action prohibits probe dispatch');
  // Failures stop this entire request. Reopening or switching probe IDs cannot
  // bypass the corrective limit; only a successful affected repair clears a stop.
  const unsuccessfulCorrections = attempts.filter(a => a.ordinal > 0 && a.observation !== null && a.observation.status !== 'PASS').length;
  if (unsuccessfulCorrections >= 2) return storeError('REPAIR_LIMIT_REACHED', 'Two unsuccessful corrective candidates exhausted across this request');
  // A failure is cleared only by a PASS of the same evidence class: simulated
  // fixture results never stand in for live or fault-injection proof.
  const outstanding = new Map<string, ProbeAttempt>();
  for (const attempt of attempts) {
   const observed = attempt.observation; if (!observed) continue; const key = `${attempt.probeId}\u0000${observed.evidenceKind}`;
   if (observed.status === 'FAIL') outstanding.set(key, attempt); else if (observed.status === 'PASS') outstanding.delete(key);
  }
  const failures = [...outstanding.values()];
  if (failures.length && !failures.some(a => a.probeId === probeId)) return storeError('REQUIRED_PROBE_FAILED', 'Required failure stops the request; only its supported corrective path may continue');
  const prior = attempts.filter(a => a.probeId === probeId); const affected = prior.filter(a => failures.includes(a)).at(-1);
  if (!affected && prior.at(-1)?.observation?.status === 'PASS') return storeError('NEEDS_REVALIDATION', 'Passing probe may not be repeated without separate narrow revalidation authorization');
  if (prior.length >= 3) return storeError('REPAIR_LIMIT_REACHED', 'Two corrective candidates exhausted; resume preserves the count');
  const repaired = affected ?? prior.at(-1);
  if (repaired && (!input.repairEvidenceIds.length || !input.repairEvidenceIds.every(id => repaired.observation!.evidence.some(e => e.id === id)))) return storeError('SUPPORTED_REPAIR_REQUIRED', 'Retry needs evidence of the affected prior failed probe');
  const elapsed = attempts.reduce((n, a) => n + (a.observation?.elapsedMs ?? 0), 0); const output = attempts.reduce((n, a) => n + (a.observation?.outputBytes ?? 0), 0);
  if (attempts.length >= request.budget.maxAttempts || elapsed >= request.budget.activeMs || output >= request.budget.outputBytes) return storeError('QUALIFICATION_BUDGET_EXHAUSTED', 'Finite approved probe budget exhausted');
  try { if (this.options.authorizeCurrent(frozen(structuredClone(request)), probeId, input.launchHash) !== true) return storeError('EXECUTION_NOT_AUTHORIZED', 'Current owner/probe launch authority denied'); }
  catch { return storeError('EXECUTION_NOT_AUTHORIZED', 'Current authority unavailable'); }
  const parsed = AttemptSchema.safeParse({ schemaVersion: 1, id: randomUUID(), requestId, targetHash: request.targetHash, probeId, owner: request.owner,
   actionId: input.actionId, launchHash: input.launchHash, ordinal: prior.length, repairEvidenceIds: input.repairEvidenceIds, startedAt: Date.now(),
   deadline: Math.min(request.expiresAt, Date.now() + request.budget.activeMs - elapsed), observation: null });
  if (!parsed.success) return storeError('INVALID_CONTRACT', 'Probe intent is malformed');
  const intent = this.store.intent(request.owner, { schemaVersion: 1, id: input.actionId, runId: request.owner.runId, kind: 'QUALIFICATION_PROBE', payload: { requestId, probeId, launchHash: input.launchHash } });
  if (!intent.ok) return intent;
  const appended = this.#append(request.owner, requestId, input.actionId, request.targetHash, 'ATTEMPT_INTENT', parsed.data, history.value.revision);
  return appended.ok ? { ok: true, value: parsed.data } : appended;
 }
 #find(attemptId: string): Result<{ history: History; attempt: ProbeAttempt }> {
  const records = this.#records(); if (!records.ok) return records; const entry = records.value.find(r => r.kind === 'ATTEMPT_INTENT' && (r.payload as { id?: unknown })?.id === attemptId);
  if (!entry) return storeError('INTENT_REQUIRED', 'Durable qualification attempt required'); const history = this.history(entry.requestId); if (!history.ok) return history;
  const attempt = history.value.attempts.find(a => a.id === attemptId); return attempt ? { ok: true, value: { history: history.value, attempt } } : storeError('INVALID_LEDGER', 'Attempt missing');
 }
 dispatchAttempt(attemptId: string, launchHash: string): Result<void> {
  const found = this.#find(attemptId); if (!found.ok) return found; const { attempt, history } = found.value;
  if (attempt.observation || attempt.launchHash !== launchHash || attempt.deadline <= Date.now()) return storeError('EXECUTION_NOT_AUTHORIZED', 'Exact current one-time launch authority required');
  try { if (this.options.authorizeCurrent(frozen(structuredClone(history.request)), attempt.probeId, launchHash) !== true) return storeError('EXECUTION_NOT_AUTHORIZED', 'Current dispatch authority denied'); }
  catch { return storeError('EXECUTION_NOT_AUTHORIZED', 'Current dispatch authority unavailable'); }
  const result = this.store.dispatch(attempt.owner, attempt.actionId); return result.ok ? { ok: true, value: undefined } : result;
 }
 #validEvidence(attempt: ProbeAttempt, observation: ProbeObservation): boolean {
  return observation.evidence.length > 0 && observation.evidence.every(ref => {
   const loaded = this.store.loadArtifact(ref.id); if (!loaded.ok) return false; const artifact = loaded.value;
   if (artifact.runId !== attempt.owner.runId || artifact.actionId !== attempt.actionId || artifact.sha256 !== ref.sha256 || artifact.truncated || artifact.producerStopRequired) return false;
   try { const bytes = readFileSync(join(this.store.root, 'artifacts', artifact.sha256)); return bytes.length === artifact.storedBytes && createHash('sha256').update(bytes).digest('hex') === ref.sha256; } catch { return false; }
  });
 }
 finishAttempt(attemptId: string, input: ProbeObservation): Result<ProbeAttempt> {
  const found = this.#find(attemptId); if (!found.ok) return found; const { attempt, history } = found.value;
  const parsed = ProbeObservationSchema.safeParse(input); if (!parsed.success) return storeError('INVALID_CONTRACT', 'Filtered qualification observation required');
  if (attempt.observation) return storeError('DUPLICATE_QUALIFICATION', 'Attempt results are immutable');
  const action = this.store.loadAction(attempt.actionId); if (!action.ok) return action;
  if (action.value.state !== 'DISPATCHED') return storeError('RECOVERY_REQUIRED', 'Only a dispatched, known current action can finish');
  const observation = parsed.data; const definition = REQUIRED_CODEX_WINDOWS_PROBES.find(p => p.id === attempt.probeId)!;
  if (!observation.actualAttempt || ['refused', 'not_attempted'].includes(observation.result)) { observation.status = 'UNTESTED'; observation.reasonCode = 'OPERATION_NOT_ATTEMPTED'; }
  else if (!this.#validEvidence(attempt, observation)) { observation.status = 'FAIL'; observation.reasonCode = 'INVALID_EVIDENCE'; }
  else if (observation.status === 'PASS') {
   const mismatch = observation.result !== definition.expected || definition.evidenceCategories.some(category => !observation.evidence.some(e => e.category === category)) ||
    (definition.sentinel && (!observation.sentinel || observation.sentinel.before !== observation.sentinel.after)) ||
    (attempt.probeId.endsWith('denied_sensitive_read') && observation.sensitiveBytesRead !== false) ||
    (attempt.probeId === 'worker.subscription_request' && (observation.facts?.accountSource !== 'chatgpt' || observation.facts?.model !== history.target.model || observation.facts?.effort !== history.target.effort)) ||
    (attempt.probeId === 'worker.correlated_lifecycle' && (observation.facts?.correlated !== true || observation.facts?.completed !== true)) ||
    (attempt.probeId === 'worker.unapproved_config_inactive' && observation.facts?.allRequiredSurfacesInactive !== true) ||
    (definition.expected === 'stopped' && !this.#stopped(attempt, observation));
   if (mismatch) { observation.status = 'FAIL'; observation.reasonCode = 'REQUIRED_PROOF_MISMATCH'; }
  }
  const priorMs = history.attempts.reduce((n, a) => n + (a.observation?.elapsedMs ?? 0), 0); const priorBytes = history.attempts.reduce((n, a) => n + (a.observation?.outputBytes ?? 0), 0);
  if (Date.now() > attempt.deadline || priorMs + observation.elapsedMs > history.request.budget.activeMs || priorBytes + observation.outputBytes > history.request.budget.outputBytes) { observation.status = 'FAIL'; observation.reasonCode = 'QUALIFICATION_BUDGET_EXHAUSTED'; }
  const result = { ...attempt, observation }; const records = this.#records(attempt.owner.runId); if (!records.ok) return records;
  const appended = this.#append(attempt.owner, attempt.requestId, attempt.actionId, attempt.targetHash, 'ATTEMPT_RESULT', result, records.value.length); if (!appended.ok) return appended;
  // Missing artifact refs still record the failed observation, but cannot become an outcome receipt.
  const registeredIds = observation.evidence.filter(ref => this.store.loadArtifact(ref.id).ok).map(ref => ref.id);
  const outcome = this.store.outcome(attempt.owner, attempt.actionId, { schemaVersion: 1, status: observation.status === 'PASS' ? 'SUCCEEDED' : 'FAILED', evidenceIds: registeredIds });
  return outcome.ok ? { ok: true, value: result } : outcome;
 }
 #stopped(attempt: ProbeAttempt, observation: ProbeObservation): boolean {
  const owner = observation.ownership; const drain = observation.drain; const heartbeat = observation.heartbeat;
  return !!owner && owner.environment === 'windows' && owner.runId === attempt.owner.runId && owner.generation === attempt.owner.generation && owner.actionId === attempt.actionId &&
   !!drain && drain.runId === owner.runId && drain.generation === owner.generation && drain.actionId === owner.actionId && drain.rootExited && drain.membershipEmpty && drain.activeProcesses === 0 &&
   drain.unresolvedExecutions.length === 0 && drain.outputComplete && drain.unresolvedOutputStreams.length === 0 && drain.outputCompletedAt !== null &&
   !!heartbeat && heartbeat.beforeBytes > 0 && heartbeat.beforeBytes === heartbeat.afterBytes && heartbeat.stableMs >= 2000 && observation.unrelatedProcessAlive === true;
 }
 report(requestId: string, blockers: string[]): Result<QualificationReport> {
  const history = this.history(requestId); if (!history.ok) return history; const { target, request, attempts } = history.value;
  const report: QualificationReport = { schemaVersion: 1, id: randomUUID(), requestId, target, targetHash: request.targetHash, blockers, createdAt: Date.now(), qualified: false,
   probes: REQUIRED_CODEX_WINDOWS_PROBES.map(definition => { const prior = attempts.filter(a => a.probeId === definition.id); const observation = prior.at(-1)?.observation;
    return { id: definition.id, status: observation?.status ?? 'UNTESTED', evidenceKind: observation?.evidenceKind ?? null, attemptIds: prior.map(a => a.id), evidenceIds: observation?.evidence.map(e => e.id) ?? [] }; }) };
  const recovery = this.store.reconcileEvidence(request.owner.runId); if (!recovery.ok) return recovery;
  report.qualified = blockers.length === 0 && recovery.value.allowsReady && report.probes.every(p => p.status === 'PASS' && p.evidenceKind === REQUIRED_CODEX_WINDOWS_PROBES.find(d => d.id === p.id)!.evidenceKind);
  const records = this.#records(request.owner.runId); if (!records.ok) return records;
  const appended = this.#append(request.owner, requestId, request.actionId, request.targetHash, 'REPORT', QualificationReportSchema.parse(report), records.value.length);
  return appended.ok ? { ok: true, value: report } : appended;
 }
 lookupQualification(target: QualificationTarget): Result<RuntimeCapabilities> {
  const parsed = QualificationTargetSchema.safeParse(target); if (!parsed.success) return storeError('INVALID_CONTRACT', 'Exact qualification target required');
  const records = this.#records(); if (!records.ok) return records; const targetHash = targetFingerprint(parsed.data);
  try {
   const reports = records.value.filter(r => r.kind === 'REPORT').map(r => QualificationReportSchema.parse(r.payload));
   const matching = reports.filter(r => r.targetHash === targetHash).at(-1);
   if (!matching) return storeError(reports.length ? 'NEEDS_REVALIDATION' : 'UNQUALIFIED', 'No receipt matches the complete runtime/helper/wrapper/policy/platform/model target');
   const history = this.history(matching.requestId); if (!history.ok) return history;
   const recovery = this.store.reconcileEvidence(history.value.request.owner.runId); if (!recovery.ok) return recovery;
   if (!matching.qualified || matching.blockers.length || !recovery.value.allowsReady || matching.probes.length !== REQUIRED_CODEX_WINDOWS_PROBES.length ||
    REQUIRED_CODEX_WINDOWS_PROBES.some(definition => { const probe = matching.probes.find(p => p.id === definition.id); const latest = history.value.attempts.filter(a => a.probeId === definition.id).at(-1);
     return !probe || probe.status !== 'PASS' || probe.evidenceKind !== definition.evidenceKind || !latest?.observation || latest.observation.status !== 'PASS' ||
      probe.attemptIds.at(-1) !== latest.id || !this.#validEvidence(latest, latest.observation); })) return storeError('UNQUALIFIED', 'Required fresh actual probes and intact evidence are missing');
   return { ok: true, value: RuntimeCapabilitiesSchema.parse({ schemaVersion: 1, id: matching.id, provider: 'codex', environment: 'windows',
    runtimeFingerprint: fingerprint(parsed.data.runtime), adapterFingerprint: fingerprint({ adapter: parsed.data.adapter, helper: parsed.data.helper, verifier: parsed.data.verifier }),
    platformFingerprint: fingerprint(parsed.data.os), policyFingerprint: fingerprint({ targetHash, policy: parsed.data.policyHash, startup: parsed.data.startupConfigHash, model: parsed.data.model, effort: parsed.data.effort }),
    runtimeVersion: parsed.data.runtime.version, adapterVersion: parsed.data.adapter.version, platform: `${parsed.data.os.platform}/${parsed.data.os.architecture}/${parsed.data.os.release}`,
    capabilities: Object.fromEntries([...new Set(REQUIRED_CODEX_WINDOWS_PROBES.map(p => p.capability))].map(capability => [capability, { status: 'SUPPORTED', evidenceIds: matching.probes.filter(p => REQUIRED_CODEX_WINDOWS_PROBES.find(d => d.id === p.id)!.capability === capability).flatMap(p => p.evidenceIds) }])) }) };
  } catch { return storeError('INVALID_LEDGER', 'Qualification receipt is invalid'); }
 }
}
