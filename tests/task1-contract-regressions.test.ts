import { expect, it } from 'vitest';
import { parseTask } from '../src/contracts/task.ts';
import { RunPhaseSchema } from '../src/contracts/run.ts';
import { RuntimeCapabilitiesSchema } from '../src/contracts/provider.ts';
import { validTask, id, hash } from './support/contracts.ts';

it('round1_accepts_only_approved_durable_states', () => {
  const states = ['CREATED', 'PREPARING', 'IMPLEMENTING', 'VERIFYING', 'READY_FOR_REVIEW', 'NEEDS_INPUT', 'BLOCKED', 'WAITING_FOR_AUTH', 'WAITING_FOR_QUOTA', 'NEEDS_REVALIDATION', 'REPAIR_LIMIT_REACHED', 'NO_PROGRESS', 'RECOVERY_REQUIRED', 'DRAINING', 'CANCELLED', 'FAILED'];
  for (const phase of states) expect(RunPhaseSchema.safeParse(phase).success, phase).toBe(true);
  for (const phase of ['QUALIFYING', 'REPAIRING', 'CHECKPOINTED', 'NEEDS_ATTENTION']) expect(RunPhaseSchema.safeParse(phase).success, phase).toBe(false);
});

it('round1_preserves_path_identity_without_transforms', () => {
  const task = { ...validTask, environment: 'windows', repository: { id, path: ' D:/fixture' }, allowedPaths: [' src/**'], protectedPaths: [' private/**'], inclusionManifest: [{ path: ' src/main.ts', sha256: hash, bytes: 1 }] };
  const result = parseTask(task);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.repository.path).toBe(task.repository.path);
    expect(result.value.allowedPaths).toEqual(task.allowedPaths);
    expect(result.value.protectedPaths).toEqual(task.protectedPaths);
    expect(result.value.inclusionManifest).toEqual(task.inclusionManifest);
  }
  expect(parseTask({ ...task, repository: { id, path: 'bad\u0000path' } }).ok).toBe(false);
});

it('round1_uses_canonical_environments_without_aliases', () => {
  for (const environment of ['windows', 'wsl2']) {
    expect(parseTask({ ...validTask, environment }).ok, environment).toBe(true);
    expect(RuntimeCapabilitiesSchema.safeParse({ schemaVersion: 1, id, provider: 'codex', environment, runtimeFingerprint: hash, adapterFingerprint: hash, platformFingerprint: hash, policyFingerprint: hash, runtimeVersion: '1', adapterVersion: '1', platform: 'test', capabilities: {} }).success).toBe(true);
  }
  for (const environment of ['native', 'wsl']) expect(parseTask({ ...validTask, environment }).ok).toBe(false);
  expect(parseTask({ ...validTask, provider: 'claude', environment: 'windows' }).ok).toBe(false);
  expect(parseTask({ ...validTask, provider: 'claude', environment: 'wsl2' }).ok).toBe(true);
});
