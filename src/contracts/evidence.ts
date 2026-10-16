import { z } from 'zod';
import { IdSchema, HashSchema, TextSchema, BytesSchema, EvidenceIdsSchema } from './common.ts';

export const OwnerTokenSchema = z.strictObject({ schemaVersion: z.literal(1), repoId: IdSchema, runId: IdSchema, generation: BytesSchema, nonce: IdSchema });
export type OwnerToken = z.infer<typeof OwnerTokenSchema>;
export const ActionIntentSchema = z.strictObject({ schemaVersion: z.literal(1), id: IdSchema, runId: IdSchema, kind: TextSchema, payload: z.record(z.string(), z.json()) });
export type ActionIntent = z.infer<typeof ActionIntentSchema>;
export const ActionOutcomeSchema = z.strictObject({ schemaVersion: z.literal(1), status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'RECONCILED']), evidenceIds: EvidenceIdsSchema });
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
export const ActionRecordSchema = ActionIntentSchema.extend({ generation: BytesSchema, state: z.enum(['INTENDED', 'DISPATCHED', 'OBSERVED', 'OUTCOME_UNKNOWN']), rawBytes: BytesSchema, outcome: ActionOutcomeSchema.nullable() });
export type ActionRecord = z.infer<typeof ActionRecordSchema>;
export const ControlRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal(1), id: IdSchema, runId: IdSchema, kind: z.literal('CANCEL'), payload: z.strictObject({ reason: TextSchema }) }),
  z.strictObject({ schemaVersion: z.literal(1), id: IdSchema, runId: IdSchema, kind: z.literal('OBSERVATION'), payload: z.strictObject({ text: TextSchema }) }),
  z.strictObject({ schemaVersion: z.literal(1), id: IdSchema, runId: IdSchema, kind: z.literal('INTEGRITY_REVIEW'), payload: z.strictObject({ reason: TextSchema, evidenceIds: EvidenceIdsSchema }) }),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;
// Secrets are ephemeral matching inputs. Never serialize ArtifactMetadata.
export const ArtifactMetadataSchema = z.strictObject({ schemaVersion: z.literal(1), id: IdSchema, owner: OwnerTokenSchema, actionId: IdSchema.nullable(), mediaType: TextSchema, secrets: z.array(z.string().min(1).max(16384)).max(128), expectedSha256: HashSchema.optional() });
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;
export const ArtifactRefSchema = z.strictObject({ schemaVersion: z.literal(1), id: IdSchema, runId: IdSchema, actionId: IdSchema.nullable(), sha256: HashSchema, mediaType: TextSchema, rawBytes: BytesSchema, storedBytes: BytesSchema, truncated: z.boolean(), limit: z.enum(['ACTION_OUTPUT_LIMIT', 'RUN_OUTPUT_LIMIT']).nullable(), producerStopRequired: z.boolean(), redactionApplied: z.boolean(), excerpt: z.strictObject({ head: z.string(), tail: z.string(), headOffset: BytesSchema, tailOffset: BytesSchema, truncated: z.boolean() }) });
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type EvidenceRecovery = { schemaVersion: 1; runId: string; unknownActionIds: string[]; replayedActionIds: []; invalidArtifactIds: string[]; missingReferenceIds: string[]; allowsReady: boolean };
export type StoreEvent = { schemaVersion: 1; id: string; runId: string; kind: string; payload: Record<string, unknown> };
export type ArtifactCleanupOperation = 'CLOSE' | 'UNLINK';
// Publication observations are separate from the canonical durable ArtifactRef.
export type ArtifactCleanupObservation = { schemaVersion: 1; temporaryId: string; operations: ArtifactCleanupOperation[]; durable: boolean; evidenceId: string | null };
