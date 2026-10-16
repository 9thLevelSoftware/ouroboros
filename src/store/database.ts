import Database from 'better-sqlite3';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdSchema, HashSchema, BytesSchema, parseContract, type Result } from '../contracts/common.ts';
import { RunRecordSchema, type RunRecord } from '../contracts/run.ts';
import { DEFAULT_LIMITS, LimitsSchema, type TaskContract } from '../contracts/task.ts';
import { OwnerTokenSchema, ActionIntentSchema, ActionOutcomeSchema, ActionRecordSchema, ArtifactRefSchema, ControlRequestSchema, type OwnerToken, type ActionIntent, type ActionOutcome, type ActionRecord, type ArtifactRef, type ControlRequest, type EvidenceRecovery, type StoreEvent, type ArtifactCleanupOperation } from '../contracts/evidence.ts';

class BoundaryFailure extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
function fail(code: string, message: string): never { throw new BoundaryFailure(code, message); }
function ok<T>(value: T): Result<T> { return { ok: true, value }; }
export function storeError<T>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, evidenceIds: [] } }; }
function decode<T>(row: unknown, schema: { parse(value: unknown): T }): T { return schema.parse(JSON.parse((row as { record: string }).record)); }

// Qualification domain validation belongs to the qualification layer. This
// bounded envelope supplies the same durable owner/action fence as other state.
export const QualificationEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, runId: IdSchema, generation: BytesSchema,
  actionId: IdSchema, requestId: IdSchema, targetHash: HashSchema,
  kind: z.enum(['REQUEST', 'ATTEMPT_INTENT', 'ATTEMPT_RESULT', 'REPORT']), payload: z.json(),
});
export type QualificationEnvelope = z.infer<typeof QualificationEnvelopeSchema>;

export class RunStore {
  readonly root: string;
  #db: Database.Database;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, 'artifacts'), { recursive: true });
    mkdirSync(join(this.root, 'temporary'), { recursive: true });
    this.#db = new Database(join(this.root, 'store.sqlite'));
    this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('synchronous = FULL'); this.#db.pragma('busy_timeout = 5000');
    try {
      this.#db.transaction(() => {
        this.#db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
        const versions = this.#db.prepare('SELECT version FROM migrations ORDER BY version').all() as { version: number }[];
        if (versions.some(row => row.version !== 1)) fail('UNSUPPORTED_STORE_VERSION', 'Store migration is newer than this controller');
        if (!versions.length) { this.#db.exec(readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')); this.#db.prepare('INSERT INTO migrations VALUES (1, ?)').run(new Date().toISOString()); }
      }).immediate();
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { if (this.#db.open) this.#db.close(); }
  durabilitySettings(): { foreignKeys: number; journalMode: string; synchronous: number; busyTimeout: number } {
    return { foreignKeys: this.#db.pragma('foreign_keys', { simple: true }) as number, journalMode: this.#db.pragma('journal_mode', { simple: true }) as string, synchronous: this.#db.pragma('synchronous', { simple: true }) as number, busyTimeout: this.#db.pragma('busy_timeout', { simple: true }) as number };
  }
  #atomic<T>(fn: () => T): Result<T> {
    try { return ok(this.#db.transaction(fn).immediate()); }
    catch (error) {
      if (error instanceof BoundaryFailure) return storeError(error.code, error.message);
      if (error instanceof Database.SqliteError && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(error.code)) {
        return storeError('STORE_BUSY', 'Store is busy; no transaction was applied');
      }
      // SQL/schema defects and unexpected programmer exceptions still surface.
      throw error;
    }
  }
  #run(id: string): RunRecord { const row = this.#db.prepare('SELECT record FROM runs WHERE id = ?').get(id); if (!row) fail('RUN_NOT_FOUND', 'Run does not exist'); return decode(row, RunRecordSchema); }
  #save(run: RunRecord): void { this.#db.prepare('UPDATE runs SET generation = ?, record = ? WHERE id = ?').run(run.generation, JSON.stringify(RunRecordSchema.parse(run)), run.id); }
  #fence(owner: OwnerToken): RunRecord {
    if (!OwnerTokenSchema.safeParse(owner).success) fail('STALE_OWNER', 'Owner token is invalid');
    const row = this.#db.prepare('SELECT run_id, generation, nonce FROM repo_ownership WHERE repo_id = ?').get(owner.repoId) as { run_id: string; generation: number; nonce: string } | undefined;
    if (!row || row.run_id !== owner.runId || row.generation !== owner.generation || row.nonce !== owner.nonce) fail('STALE_OWNER', 'Ownership nonce or generation does not match');
    const run = this.#run(owner.runId); if (run.generation !== owner.generation) fail('STALE_OWNER', 'Run generation does not match'); return run;
  }
  #action(id: string, owner: OwnerToken): ActionRecord { const row = this.#db.prepare('SELECT record FROM actions WHERE id = ?').get(id); if (!row) fail('INTENT_REQUIRED', 'Durable intent receipt is required'); const action = decode(row, ActionRecordSchema); if (action.runId !== owner.runId || action.generation !== owner.generation) fail('STALE_OWNER', 'Action belongs to another ownership generation'); return action; }
  #saveAction(action: ActionRecord): void { this.#db.prepare('UPDATE actions SET state = ?, record = ? WHERE id = ?').run(action.state, JSON.stringify(action), action.id); }
  #event(runId: string, kind: string, payload: Record<string, unknown>): StoreEvent { const event: StoreEvent = { schemaVersion: 1, id: randomUUID(), runId, kind, payload }; this.#db.prepare('INSERT INTO events(id, run_id, kind, record) VALUES (?, ?, ?, ?)').run(event.id, runId, kind, JSON.stringify(event)); return event; }
  recordArtifactCleanup(owner: OwnerToken, temporaryId: string, artifactId: string | null, operations: ArtifactCleanupOperation[]): Result<StoreEvent> {
    return this.#atomic(() => {
      this.#fence(owner);
      if (!IdSchema.safeParse(temporaryId).success || (artifactId !== null && !IdSchema.safeParse(artifactId).success) || !operations.length || operations.some(op => op !== 'CLOSE' && op !== 'UNLINK')) fail('INVALID_CONTRACT', 'Artifact cleanup observation is invalid');
      return this.#event(owner.runId, 'CLEANUP_REQUIRED', { temporaryId, artifactId, operations });
    });
  }
  createRun(repoId: string, input: RunRecord, limits: TaskContract['limits'] = DEFAULT_LIMITS): Result<RunRecord> {
    const parsed = parseContract(RunRecordSchema, input); if (!parsed.ok) return parsed;
    const parsedLimits = parseContract(LimitsSchema, limits); if (!parsedLimits.ok) return parsedLimits;
    if (!IdSchema.safeParse(repoId).success) return storeError('INVALID_CONTRACT', 'Repository ID must be a UUID');
    if (input.generation !== 0 || input.pendingActionIds.length || input.cumulativeBudgets.outputBytes !== 0 || input.phase !== 'CREATED') return storeError('INVALID_CONTRACT', 'New run must have initial state and no pending actions or output');
    return this.#atomic(() => { if (this.#db.prepare('SELECT 1 FROM runs WHERE id = ?').get(input.id)) fail('DUPLICATE_RUN', 'Run ID already exists'); this.#db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?)').run(input.id, repoId, 0, JSON.stringify(parsed.value), JSON.stringify(parsedLimits.value)); return parsed.value; });
  }
  loadRun(id: string): Result<RunRecord> { return this.#atomic(() => this.#run(id)); }
  loadAction(id: string): Result<ActionRecord> { return this.#atomic(() => { const row = this.#db.prepare('SELECT record FROM actions WHERE id = ?').get(id); if (!row) fail('ACTION_NOT_FOUND', 'Action does not exist'); return decode(row, ActionRecordSchema); }); }
  loadArtifact(id: string): Result<ArtifactRef> { return this.#atomic(() => { const row = this.#db.prepare('SELECT record FROM artifacts WHERE id = ?').get(id); if (!row) fail('ARTIFACT_NOT_FOUND', 'Artifact does not exist'); return decode(row, ArtifactRefSchema); }); }
  listArtifacts(runId: string): ArtifactRef[] { return this.#db.prepare('SELECT record FROM artifacts WHERE run_id = ? ORDER BY rowid').all(runId).map(row => decode(row, ArtifactRefSchema)); }
  listEvents(runId: string): Result<StoreEvent[]> { return this.#atomic(() => { this.#run(runId); return this.#db.prepare('SELECT record FROM events WHERE run_id = ? ORDER BY sequence').all(runId).map(row => JSON.parse((row as { record: string }).record) as StoreEvent); }); }
  appendQualification(owner: OwnerToken, input: QualificationEnvelope, expectedRecordCount: number): Result<void> {
    let envelope: QualificationEnvelope;
    try {
      envelope = QualificationEnvelopeSchema.parse(input);
      if (Buffer.byteLength(JSON.stringify(envelope)) > 1048576) return storeError('INVALID_CONTRACT', 'Qualification envelope exceeds the frame bound');
    } catch { return storeError('INVALID_CONTRACT', 'Qualification envelope is malformed'); }
    if (!Number.isSafeInteger(expectedRecordCount) || expectedRecordCount < 0) return storeError('INVALID_CONTRACT', 'Qualification revision is invalid');
    return this.#atomic(() => {
      this.#fence(owner); this.#action(envelope.actionId, owner);
      if (envelope.runId !== owner.runId || envelope.generation !== owner.generation) fail('STALE_OWNER', 'Qualification record belongs to another owner generation');
      if (this.#db.prepare('SELECT 1 FROM qualifications WHERE id = ?').get(envelope.id)) fail('DUPLICATE_QUALIFICATION', 'Qualification records are immutable');
      const count = this.#db.prepare('SELECT count(*) AS count FROM qualifications WHERE run_id = ?').get(owner.runId) as { count: number };
      if (count.count !== expectedRecordCount) fail('QUALIFICATION_CONFLICT', 'Qualification history changed; no record was appended');
      this.#db.prepare('INSERT INTO qualifications(id, run_id, record) VALUES (?, ?, ?)').run(envelope.id, owner.runId, JSON.stringify(envelope));
    });
  }
  listQualifications(runId?: string): Result<QualificationEnvelope[]> {
    return this.#atomic(() => {
      if (runId !== undefined) { if (!IdSchema.safeParse(runId).success) fail('INVALID_CONTRACT', 'Run ID must be a UUID'); this.#run(runId); }
      const rows = runId === undefined
        ? this.#db.prepare('SELECT record FROM qualifications ORDER BY rowid').all()
        : this.#db.prepare('SELECT record FROM qualifications WHERE run_id = ? ORDER BY rowid').all(runId);
      return rows.map(row => decode(row, QualificationEnvelopeSchema));
    });
  }
  claim(repoId: string, runId: string): Result<OwnerToken> { return this.#atomic(() => { if (!IdSchema.safeParse(repoId).success || !IdSchema.safeParse(runId).success) fail('INVALID_CONTRACT', 'Repository and run IDs must be UUIDs'); const run = this.#run(runId); const repo = this.#db.prepare('SELECT repo_id FROM runs WHERE id = ?').get(runId) as { repo_id: string }; if (repo.repo_id !== repoId) fail('REPOSITORY_MISMATCH', 'Run belongs to a different repository'); const previous = this.#db.prepare('SELECT run_id, generation FROM repo_ownership WHERE repo_id = ?').get(repoId) as { run_id: string | null; generation: number } | undefined; if (previous?.run_id) fail('RUN_OWNED', 'Repository already has an owner; explicit reconciliation is required'); if (run.pendingActionIds.length) fail('RECOVERY_REQUIRED', 'Pending actions prohibit a new ownership generation'); const generation = Math.max(run.generation, previous?.generation ?? 0) + 1; if (!Number.isSafeInteger(generation)) fail('GENERATION_EXHAUSTED', 'Ownership generation is exhausted'); const owner: OwnerToken = { schemaVersion: 1, repoId, runId, generation, nonce: randomUUID() }; this.#db.prepare('INSERT INTO repo_ownership VALUES (?, ?, ?, ?) ON CONFLICT(repo_id) DO UPDATE SET run_id = excluded.run_id, generation = excluded.generation, nonce = excluded.nonce').run(repoId, runId, generation, owner.nonce); run.generation = generation; this.#save(run); this.#event(runId, 'OWNERSHIP_CLAIMED', { generation }); return owner; }); }
  release(owner: OwnerToken): Result<void> { return this.#atomic(() => { const run = this.#fence(owner); if (run.pendingActionIds.length || this.#db.prepare("SELECT 1 FROM actions WHERE run_id = ? AND state != 'OBSERVED'").get(owner.runId)) fail('RECOVERY_REQUIRED', 'Unresolved actions prohibit ownership release'); this.#db.prepare('UPDATE repo_ownership SET run_id = NULL, nonce = NULL WHERE repo_id = ?').run(owner.repoId); this.#event(run.id, 'OWNERSHIP_RELEASED', { generation: owner.generation }); }); }
  intent(owner: OwnerToken, input: ActionIntent): Result<ActionRecord> { const parsed = parseContract(ActionIntentSchema, input); if (!parsed.ok) return parsed; return this.#atomic(() => { const run = this.#fence(owner); if (input.runId !== run.id) fail('STALE_OWNER', 'Intent is outside owned run'); if (this.#db.prepare('SELECT 1 FROM actions WHERE id = ?').get(input.id)) fail('DUPLICATE_ACTION', 'Action ID already exists'); const action: ActionRecord = { ...parsed.value, generation: owner.generation, state: 'INTENDED', rawBytes: 0, outcome: null }; this.#db.prepare('INSERT INTO actions VALUES (?, ?, ?, ?, ?)').run(action.id, run.id, owner.generation, action.state, JSON.stringify(action)); run.pendingActionIds.push(action.id); this.#save(run); this.#event(run.id, 'ACTION_INTENDED', { actionId: action.id }); return action; }); }
  dispatch(owner: OwnerToken, id: string): Result<ActionRecord> { return this.#atomic(() => { this.#fence(owner); const action = this.#action(id, owner); if (action.state !== 'INTENDED') fail('INVALID_ACTION_TRANSITION', 'Only a durable intended action may dispatch'); action.state = 'DISPATCHED'; this.#saveAction(action); this.#event(owner.runId, 'ACTION_DISPATCHED', { actionId: id }); return action; }); }
  unknown(owner: OwnerToken, id: string): Result<ActionRecord> {
    return this.#atomic(() => {
      this.#fence(owner);
      const action = this.#action(id, owner);
      if (action.state !== 'INTENDED' && action.state !== 'DISPATCHED') fail('INVALID_ACTION_TRANSITION', 'Only unresolved actions may become unknown');
      action.state = 'OUTCOME_UNKNOWN';
      this.#saveAction(action);
      this.#event(owner.runId, 'ACTION_OUTCOME_UNKNOWN', { actionId: id });
      return action;
    });
  }
  outcome(owner: OwnerToken, id: string, input: ActionOutcome): Result<void> { const parsed = parseContract(ActionOutcomeSchema, input); if (!parsed.ok) return parsed; return this.#atomic(() => { const run = this.#fence(owner); const action = this.#action(id, owner); if (action.state === 'OBSERVED') fail('INVALID_ACTION_TRANSITION', 'Observed actions are immutable'); if ((action.state === 'INTENDED' || action.state === 'OUTCOME_UNKNOWN') && input.status !== 'RECONCILED') fail('INVALID_ACTION_TRANSITION', 'Undispatched or unknown action requires explicit reconciliation'); for (const evidenceId of input.evidenceIds) { const row = this.#db.prepare('SELECT run_id FROM artifacts WHERE id = ?').get(evidenceId) as { run_id: string } | undefined; if (!row || row.run_id !== run.id) fail('INVALID_EVIDENCE', 'Outcome evidence must reference this run'); } action.state = 'OBSERVED'; action.outcome = parsed.value; this.#saveAction(action); run.pendingActionIds = run.pendingActionIds.filter(value => value !== id); this.#save(run); this.#event(run.id, 'ACTION_OBSERVED', { actionId: id, status: input.status }); }); }
  reserveOutput(owner: OwnerToken, actionId: string | null, rawBytes: number): Result<{ acceptedBytes: number; limit: ArtifactRef['limit']; diagnosticBytes: number }> { return this.#atomic(() => { const run = this.#fence(owner); if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) fail('INVALID_CONTRACT', 'Raw byte count is invalid'); const row = this.#db.prepare('SELECT limits FROM runs WHERE id = ?').get(run.id) as { limits: string }; const limits = LimitsSchema.parse(JSON.parse(row.limits)); const action = actionId === null ? null : this.#action(actionId, owner); const runRemaining = Math.max(0, limits.maxRunOutputBytes - run.cumulativeBudgets.outputBytes); const actionRemaining = action ? Math.max(0, limits.maxActionOutputBytes - action.rawBytes) : Infinity; const acceptedBytes = Math.min(rawBytes, runRemaining, actionRemaining); const limit = rawBytes === 0 ? null : rawBytes >= Math.min(runRemaining, actionRemaining) ? (actionRemaining < runRemaining ? 'ACTION_OUTPUT_LIMIT' : 'RUN_OUTPUT_LIMIT') : null; if (!Number.isSafeInteger(run.cumulativeBudgets.outputBytes + rawBytes) || (action && !Number.isSafeInteger(action.rawBytes + rawBytes))) fail('OUTPUT_COUNT_EXHAUSTED', 'Raw output count exhausted'); run.cumulativeBudgets.outputBytes += rawBytes; this.#save(run); if (action) { action.rawBytes += rawBytes; this.#saveAction(action); } if (limit) this.#event(run.id, 'OUTPUT_LIMIT', { actionId, limit, rawBytes, acceptedBytes, runRawBytes: run.cumulativeBudgets.outputBytes, actionRawBytes: action?.rawBytes ?? null, producerStopRequired: true }); return { acceptedBytes, limit, diagnosticBytes: limits.maxDiagnosticBytes }; }); }
  registerArtifact(owner: OwnerToken, artifact: ArtifactRef): Result<ArtifactRef> { const parsed = parseContract(ArtifactRefSchema, artifact); if (!parsed.ok) return parsed; return this.#atomic(() => { this.#fence(owner); if (artifact.runId !== owner.runId) fail('STALE_OWNER', 'Artifact is outside owned run'); if (artifact.actionId) this.#action(artifact.actionId, owner); if (this.#db.prepare('SELECT 1 FROM artifacts WHERE id = ?').get(artifact.id)) fail('DUPLICATE_ARTIFACT', 'Artifact ID already exists'); if (!this.#validArtifact(artifact)) fail('INVALID_ARTIFACT', 'Published artifact hash or size does not match'); this.#db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?)').run(artifact.id, owner.runId, artifact.actionId, artifact.sha256, JSON.stringify(parsed.value)); this.#event(owner.runId, 'ARTIFACT_REFERENCED', { artifactId: artifact.id }); return parsed.value; }); }
  #validArtifact(artifact: ArtifactRef): boolean { try { const bytes = readFileSync(join(this.root, 'artifacts', artifact.sha256)); return bytes.length === artifact.storedBytes && createHash('sha256').update(bytes).digest('hex') === artifact.sha256; } catch { return false; } }
  reconcileEvidence(runId: string): Result<EvidenceRecovery> { return this.#atomic(() => { const run = this.#run(runId); const actions = this.#db.prepare("SELECT id FROM actions WHERE run_id = ? AND state != 'OBSERVED'").all(runId) as { id: string }[]; const artifacts = this.listArtifacts(runId); const invalidArtifactIds = artifacts.filter(a => !this.#validArtifact(a)).map(a => a.id); const missingReferenceIds = [run.baselineRef, run.candidateRef, run.sessionRef].filter((id): id is string => id !== null && !artifacts.some(a => a.id === id)); return { schemaVersion: 1, runId, unknownActionIds: actions.map(a => a.id), replayedActionIds: [], invalidArtifactIds, missingReferenceIds, allowsReady: !actions.length && !invalidArtifactIds.length && !missingReferenceIds.length }; }); }
  enqueue(expectedGeneration: number, input: ControlRequest): Result<string> { const parsed = parseContract(ControlRequestSchema, input); if (!parsed.ok) return parsed; return this.#atomic(() => { const run = this.#run(input.runId); const owner = this.#db.prepare('SELECT generation FROM repo_ownership WHERE run_id = ?').get(run.id) as { generation: number } | undefined; if (!owner || !Number.isSafeInteger(expectedGeneration) || expectedGeneration !== run.generation || expectedGeneration !== owner.generation) fail('STALE_GENERATION', 'Control request targets a stale or absent owner'); const existing = this.#db.prepare('SELECT record, generation FROM control_requests WHERE id = ?').get(input.id) as { record: string; generation: number } | undefined; if (existing) { if (existing.record !== JSON.stringify(parsed.value) || existing.generation !== expectedGeneration) fail('CONTROL_REQUEST_CONFLICT', 'Control request ID has different contents'); return input.id; } this.#db.prepare('INSERT INTO control_requests(id, run_id, generation, record) VALUES (?, ?, ?, ?)').run(input.id, run.id, expectedGeneration, JSON.stringify(parsed.value)); return input.id; }); }
  consume(owner: OwnerToken): Result<ControlRequest[]> { return this.#atomic(() => { this.#fence(owner); const rows = this.#db.prepare('SELECT id, record FROM control_requests WHERE run_id = ? AND generation = ? AND consumed = 0 ORDER BY sequence').all(owner.runId, owner.generation) as { id: string; record: string }[]; for (const row of rows) this.#db.prepare('UPDATE control_requests SET consumed = 1 WHERE id = ?').run(row.id); return rows.map(row => ControlRequestSchema.parse(JSON.parse(row.record))); }); }
}
export function openStore(root: string): RunStore { return new RunStore(root); }
