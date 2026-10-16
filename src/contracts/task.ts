import { z } from 'zod';
import {
  IdSchema, HashSchema, TextSchema, PathSchema, BytesSchema,
  PositiveLimitSchema, parseContract, type Result,
} from './common.ts';

export const LimitsSchema = z.strictObject({
  activeMs: PositiveLimitSchema,
  verificationMs: PositiveLimitSchema,
  maxRepairs: z.number().int().min(0).max(2),
  maxFrameBytes: PositiveLimitSchema.max(1048576),
  maxActionOutputBytes: PositiveLimitSchema,
  maxRunOutputBytes: PositiveLimitSchema,
  maxDiagnosticBytes: PositiveLimitSchema.max(16384),
  maxLessonBytes: PositiveLimitSchema.max(32768),
  maxSnapshotBytes: PositiveLimitSchema,
});
export const DEFAULT_LIMITS = {
  activeMs: 1800000,
  verificationMs: 300000,
  maxRepairs: 2,
  maxFrameBytes: 1048576,
  maxActionOutputBytes: 10485760,
  maxRunOutputBytes: 104857600,
  maxDiagnosticBytes: 16384,
  maxLessonBytes: 32768,
  maxSnapshotBytes: 1073741824,
} as const;
export const TaskContractSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdSchema,
  repository: z.strictObject({ id: IdSchema, path: PathSchema }),
  text: TextSchema,
  nonGoals: z.array(TextSchema),
  allowedPaths: z.array(PathSchema).min(1),
  protectedPaths: z.array(PathSchema),
  provider: z.enum(['codex', 'claude']),
  environment: z.enum(['windows', 'wsl2']),
  model: TextSchema,
  effort: TextSchema,
  acceptanceIds: z.array(IdSchema).min(1),
  verificationPlanRef: IdSchema,
  inclusionManifest: z.array(z.strictObject({
    path: PathSchema,
    sha256: HashSchema,
    bytes: BytesSchema,
  })),
  limits: LimitsSchema,
}).superRefine((task, ctx) => {
  if (task.provider === 'claude' && task.environment === 'windows') {
    ctx.addIssue({ code: 'custom', path: ['environment'], message: 'Claude execution requires WSL2' });
  }
  if (task.limits.verificationMs > task.limits.activeMs) {
    ctx.addIssue({ code: 'custom', path: ['limits', 'verificationMs'], message: 'Verification exceeds cumulative active time' });
  }
  if (task.limits.maxActionOutputBytes > task.limits.maxRunOutputBytes) {
    ctx.addIssue({ code: 'custom', path: ['limits'], message: 'Action output exceeds run output' });
  }
});
export type TaskContract = z.infer<typeof TaskContractSchema>;
// Provider adapters validate these strings against the qualified runtime before dispatch.
export function parseTask(value: unknown): Result<TaskContract> {
  return parseContract(TaskContractSchema, value);
}
