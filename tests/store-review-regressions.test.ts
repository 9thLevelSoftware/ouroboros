import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openStore } from '../src/store/database.ts';
import { claimRun } from '../src/store/ownership.ts';
import { recordIntent } from '../src/store/actions.ts';
import { publishArtifact } from '../src/store/artifacts.ts';
import type { RunRecord } from '../src/contracts/run.ts';
import type { Result } from '../src/contracts/common.ts';

const stores: ReturnType<typeof openStore>[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const store of stores.splice(0)) store.close(); });
function value<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.value; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ouroboros-fix1-'));
  const store = openStore(root); stores.push(store);
  const repoId = randomUUID();
  const run: RunRecord = { schemaVersion: 1, id: randomUUID(), taskId: randomUUID(), phase: 'CREATED', blocker: null, generation: 0, baselineRef: null, candidateRef: null, sessionRef: null, repairCount: 0, cumulativeBudgets: { activeMs: 0, outputBytes: 0, tokens: null, requests: null, money: null }, pendingActionIds: [] };
  value(store.createRun(repoId, run));
  return { root, store, run, owner: value(claimRun(store, repoId, run.id)) };
}
function metadata(f: ReturnType<typeof fixture>) { return { schemaVersion: 1 as const, id: randomUUID(), owner: f.owner, actionId: null, mediaType: 'text/plain', secrets: [] }; }
function obstructTemporary(root: string) { const temporary = join(root, 'temporary', readdirSync(join(root, 'temporary'))[0]!); renameSync(temporary, temporary + '.retained'); mkdirSync(temporary); }
async function* bytes() { yield Buffer.from('owned fixture bytes'); }

test('review_cleanup_close_failure_before_publish_returns_safe_obligation', async () => {
  const f = fixture(); const secret = 'CLOSE_ERROR_SENTINEL';
  const realOpen = fsPromises.open; let realClose: (() => Promise<void>) | undefined;
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const file = await realOpen(...args);
    if (String(args[0]).startsWith(join(f.root, 'temporary'))) { realClose = file.close.bind(file); file.close = async () => { throw Error(secret + f.root); }; }
    return file;
  });
  syncBuiltinESMExports();
  try {
    const result = await publishArtifact(f.store, bytes(), metadata(f));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ARTIFACT_IO_ERROR');
    expect(result.cleanup?.operations).toContain('CLOSE');
    expect(result.cleanup?.durable).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain(f.root);
    expect(f.store.listArtifacts(f.run.id)).toEqual([]);
    const events = value(f.store.listEvents(f.run.id)).filter(e => e.kind === 'CLEANUP_REQUIRED');
    expect(events).toHaveLength(1); expect(JSON.stringify(events)).not.toContain(secret);
    if (!result.ok) expect(result.error.evidenceIds).toEqual([events[0]!.id]);
  } finally { await realClose?.(); }
});

test('review_cleanup_unlink_failure_before_publish_returns_safe_obligation', async () => {
  const f = fixture();
  async function* source() { yield Buffer.from('owned bytes'); obstructTemporary(f.root); throw Error('UNLINK_ERROR_SENTINEL' + f.root); }
  const result = await publishArtifact(f.store, source(), metadata(f));
  expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('ARTIFACT_IO_ERROR');
  expect(result.cleanup?.operations).toEqual(['UNLINK']); expect(result.cleanup?.durable).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.root); expect(JSON.stringify(result)).not.toContain('UNLINK_ERROR_SENTINEL');
  expect(f.store.listArtifacts(f.run.id)).toEqual([]);
  const events = value(f.store.listEvents(f.run.id)).filter(e => e.kind === 'CLEANUP_REQUIRED'); expect(events).toHaveLength(1);
});

test('review_cleanup_after_reference_commit_preserves_canonical_success', async () => {
  const f = fixture(); const m = metadata(f);
  const register = f.store.registerArtifact.bind(f.store);
  f.store.registerArtifact = (owner, artifact) => { const result = register(owner, artifact); expect(result.ok).toBe(true); obstructTemporary(f.root); return result; };
  const result = await publishArtifact(f.store, bytes(), m);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error.code);
  expect(result.value).toEqual(value(f.store.loadArtifact(m.id)));
  expect(result.cleanup?.operations).toEqual(['UNLINK']); expect(result.cleanup?.durable).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.root);
  expect(value(f.store.reconcileEvidence(f.run.id)).allowsReady).toBe(true);
  const events = value(f.store.listEvents(f.run.id)).filter(e => e.kind === 'CLEANUP_REQUIRED'); expect(events).toHaveLength(1);
  expect(events[0]!.payload.artifactId).toBe(m.id);
});

test('review_sqlite_contention_returns_safe_result_without_ownership_change', () => {
  const f = fixture(); const blocker = new Database(join(f.root, 'store.sqlite'));
  const actionId = randomUUID();
  const ownershipBefore = blocker.prepare('SELECT * FROM repo_ownership').all();
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const result = recordIntent(f.store, f.owner, { schemaVersion: 1, id: actionId, runId: f.run.id, kind: 'VERIFY', payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error.code).toBe('STORE_BUSY'); expect(result.error.message).toBe('Store is busy; no transaction was applied'); expect(result.error.evidenceIds).toEqual([]); }
    expect(blocker.prepare('SELECT * FROM repo_ownership').all()).toEqual(ownershipBefore);
    expect(blocker.prepare('SELECT id FROM actions WHERE id = ?').all(actionId)).toEqual([]);
  } finally { blocker.exec('ROLLBACK'); blocker.close(); }
  expect(value(f.store.loadRun(f.run.id)).generation).toBe(f.owner.generation);
  expect(value(f.store.loadRun(f.run.id)).pendingActionIds).toEqual([]);
}, 15000);
