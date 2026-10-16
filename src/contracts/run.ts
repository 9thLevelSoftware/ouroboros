import { z } from 'zod';
import { IdSchema, TextSchema, EvidenceIdsSchema, BytesSchema } from './common.ts';

export const RunPhaseSchema = z.enum([
  'CREATED',
  'PREPARING',
  'IMPLEMENTING',
  'VERIFYING',
  'READY_FOR_REVIEW',
  'NEEDS_INPUT',
  'BLOCKED',
  'WAITING_FOR_AUTH',
  'WAITING_FOR_QUOTA',
  'NEEDS_REVALIDATION',
  'REPAIR_LIMIT_REACHED',
  'NO_PROGRESS',
  'RECOVERY_REQUIRED',
  'DRAINING',
  'CANCELLED',
  'FAILED',
]);

export const RunRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdSchema,
  taskId: IdSchema,
  phase: RunPhaseSchema,
  blocker: z.strictObject({
    code: TextSchema,
    message: TextSchema,
    evidenceIds: EvidenceIdsSchema,
  }).nullable(),
  generation: BytesSchema,
  baselineRef: IdSchema.nullable(),
  candidateRef: IdSchema.nullable(),
  sessionRef: IdSchema.nullable(),
  repairCount: z.number().int().min(0).max(2),
  cumulativeBudgets: z.strictObject({
    activeMs: BytesSchema,
    outputBytes: BytesSchema,
    tokens: BytesSchema.nullable(),
    requests: BytesSchema.nullable(),
    money: z.number().finite().nonnegative().nullable(),
  }),
  pendingActionIds: z.array(IdSchema),
});

export type RunRecord = z.infer<typeof RunRecordSchema>;
