import { z } from 'zod';

export const IdSchema = z.uuid();
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TextSchema = z.string().trim().min(1);
// Paths identify declared bytes and scope; validation must never rewrite them.
export const PathSchema = z.string().min(1).refine(
  value => !/[\u0000-\u001f\u007f]/.test(value),
  'Control characters are unsupported in paths',
);
export const BytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PositiveLimitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const EvidenceIdsSchema = z.array(IdSchema);
export const ErrorSchema = z.strictObject({
  code: TextSchema,
  message: TextSchema,
  evidenceIds: EvidenceIdsSchema,
});
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: z.infer<typeof ErrorSchema> };

export function parseContract<T>(schema: z.ZodType<T>, value: unknown): Result<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: 'INVALID_CONTRACT',
      message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      evidenceIds: [],
    },
  };
}
