import { z } from 'zod';
import { IdSchema, TextSchema, HashSchema, EvidenceIdsSchema } from './common.ts';

export const CapabilityStatusSchema = z.enum(['SUPPORTED', 'UNSUPPORTED', 'UNQUALIFIED']);
export const CapabilitySchema = z.strictObject({
  status: CapabilityStatusSchema,
  evidenceIds: EvidenceIdsSchema,
}).superRefine((capability, ctx) => {
  if (capability.status !== 'UNQUALIFIED' && !capability.evidenceIds.length) {
    ctx.addIssue({ code: 'custom', message: 'Qualified capability requires evidence' });
  }
});
export const RuntimeCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdSchema,
  provider: z.enum(['codex', 'claude']),
  environment: z.enum(['windows', 'wsl2']),
  runtimeFingerprint: HashSchema,
  adapterFingerprint: HashSchema,
  platformFingerprint: HashSchema,
  policyFingerprint: HashSchema,
  runtimeVersion: TextSchema,
  adapterVersion: TextSchema,
  platform: TextSchema,
  capabilities: z.record(TextSchema, CapabilitySchema),
}).superRefine((runtime, ctx) => {
  if (runtime.provider === 'claude' && runtime.environment === 'windows') {
    ctx.addIssue({ code: 'custom', message: 'Native Claude execution is excluded' });
  }
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
