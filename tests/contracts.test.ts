import { describe, it, expect } from 'vitest';
import { parseTask } from '../src/contracts/task.ts';
import { RunRecordSchema } from '../src/contracts/run.ts';
import { RuntimeCapabilitiesSchema } from '../src/contracts/provider.ts';
import { validTask } from './support/contracts.ts';
describe('contracts', () => {
 it('rejects_unknown_fields_and_unbounded_limits', () => {
  expect(parseTask(validTask).ok).toBe(true);
  expect(parseTask({ ...validTask, extra: true }).ok).toBe(false);
  for (const value of [0, -1, Infinity, NaN]) expect(parseTask({ ...validTask, limits: { ...validTask.limits, activeMs: value } }).ok).toBe(false);
  expect(parseTask({ ...validTask, limits: { ...validTask.limits, maxRepairs: 3 } }).ok).toBe(false);
 });
 it('rejects_native_claude_execution', () => {
  expect(parseTask({ ...validTask, provider: 'claude' }).ok).toBe(false);
  expect(parseTask({ ...validTask, provider: 'claude', environment: 'wsl2', model: 'claude-opus', effort: 'max' }).ok).toBe(true);
 });
 it('requires_strict_durable_records', () => {
  expect(RunRecordSchema.safeParse({ schemaVersion: 1 }).success).toBe(false);
  expect(RuntimeCapabilitiesSchema.safeParse({ schemaVersion: 1 }).success).toBe(false);
 });
});

