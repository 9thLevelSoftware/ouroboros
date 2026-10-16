import { z } from 'zod';
import { HashSchema, IdSchema, PathSchema, PositiveLimitSchema, TextSchema, type Result } from './common.ts';

export const ExecutionOwnerSchema = z.strictObject({
  runId: IdSchema, generation: PositiveLimitSchema, actionId: IdSchema, role: TextSchema,
});
export type ExecutionOwner = z.infer<typeof ExecutionOwnerSchema>;
export const ExecutionAuthorizationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('qualified'), qualificationRef: TextSchema }),
  z.strictObject({ kind: z.literal('qualification'), requestId: IdSchema, probeId: TextSchema,
    fixtureRoots: z.array(PathSchema).min(1) }),
]);
export type ExecutionAuthorization = z.infer<typeof ExecutionAuthorizationSchema>;
export const LaunchSpecSchema = z.strictObject({
  ...ExecutionOwnerSchema.shape, executable: PathSchema,
  argv: z.array(z.string().refine(v => !v.includes('\0'), 'NUL is unsupported')),
  cwd: PathSchema, env: z.record(z.string().min(1).refine(v => !/[=\0]/.test(v)), z.string().refine(v => !v.includes('\0'))),
  boundaryHash: HashSchema, authorization: ExecutionAuthorizationSchema,
  stdin: z.enum(['closed', 'pipe']).default('closed'),
  leaseTtlMs: PositiveLimitSchema.max(10000), deadline: PositiveLimitSchema,
});
export type LaunchSpec = z.infer<typeof LaunchSpecSchema>;
export type LaunchInput = z.input<typeof LaunchSpecSchema>;
export const WindowsOwnershipReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), ...ExecutionOwnerSchema.shape, environment: z.literal('windows'),
  pid: PositiveLimitSchema, creationIdentity: TextSchema,
  helperPid: PositiveLimitSchema, helperCreationIdentity: TextSchema, jobIdentity: TextSchema,
  boundaryHash: HashSchema, assignedBeforeResume: z.literal(true), capturedAt: PositiveLimitSchema,
});
const KernelIdentitySchema = z.string().regex(/^[1-9][0-9]*$/).refine(value => BigInt(value) <= 18446744073709551615n, 'Kernel identity exceeds u64');
const InvocationIdSchema = z.string().regex(/^[a-f0-9]{32}$/).refine(value => value !== '0'.repeat(32));
const CgroupPathSchema = PathSchema.refine(value => value.startsWith('/') && value !== '/' && !value.split('/').some(part => part === '..' || part === '.'));
const UnitSchema = TextSchema.refine(value => /^[a-zA-Z0-9_.-]+\.(service|slice)$/.test(value));
export const WslUnitIdentitySchema = z.strictObject({
  unitName: UnitSchema, invocationId: InvocationIdSchema, bootId: IdSchema, controlGroup: CgroupPathSchema,
  observationSlice: z.strictObject({ unitName: UnitSchema, invocationId: InvocationIdSchema,
    controlGroup: CgroupPathSchema, fileDevice: KernelIdentitySchema, fileInode: KernelIdentitySchema }),
  observer: z.strictObject({ unitName: UnitSchema, invocationId: InvocationIdSchema }),
});
export const WslOwnershipReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), ...ExecutionOwnerSchema.shape, environment: z.literal('wsl2'), distro: TextSchema,
  ...WslUnitIdentitySchema.shape,
  helper: z.strictObject({ pid: PositiveLimitSchema, startTimeTicks: KernelIdentitySchema }),
  root: z.strictObject({ pid: PositiveLimitSchema, startTimeTicks: KernelIdentitySchema }),
  boundaryHash: HashSchema, identityCapturedBeforeExec: z.literal(true), observationArmedBeforeExec: z.literal(true), capturedAt: PositiveLimitSchema,
}).superRefine((receipt, ctx) => {
  if (!receipt.controlGroup.startsWith(`${receipt.observationSlice.controlGroup}/`) ||
      receipt.unitName === receipt.observer.unitName || receipt.helper.pid === receipt.root.pid) {
    ctx.addIssue({ code: 'custom', message: 'Invalid exclusive WSL execution ancestry' });
  }
});
export const OwnershipReceiptSchema = z.union([WindowsOwnershipReceiptSchema, WslOwnershipReceiptSchema]);
export type OwnershipReceipt = z.infer<typeof OwnershipReceiptSchema>;
export const WindowsDrainEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1), ...ExecutionOwnerSchema.shape, reason: TextSchema,
  requestAcknowledged: z.boolean(), requestedAt: PositiveLimitSchema,
  acknowledgedAt: PositiveLimitSchema.nullable(), rootExited: z.boolean(), rootExitedAt: PositiveLimitSchema.nullable(),
  membershipEmpty: z.boolean(), membershipObservedAt: PositiveLimitSchema,
  activeProcesses: z.number().int().nonnegative(), unresolvedExecutions: z.array(PositiveLimitSchema),
  outputComplete: z.boolean(), unresolvedOutputStreams: z.array(z.enum(['stdout', 'stderr'])),
  outputCompletedAt: PositiveLimitSchema.nullable(),
  childRanBeforeAssignment: z.literal(false), completedAt: PositiveLimitSchema,
}).superRefine((evidence, ctx) => {
  if (evidence.membershipEmpty !== (evidence.activeProcesses === 0) ||
      evidence.requestAcknowledged !== (evidence.acknowledgedAt !== null) ||
      evidence.rootExited !== (evidence.rootExitedAt !== null) ||
      (evidence.membershipEmpty && evidence.unresolvedExecutions.length !== 0)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent drain evidence' });
  }
  if (new Set(evidence.unresolvedOutputStreams).size !== evidence.unresolvedOutputStreams.length ||
      evidence.outputComplete !== (evidence.unresolvedOutputStreams.length === 0) ||
      evidence.outputComplete !== (evidence.outputCompletedAt !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent output completion evidence' });
  }
});
export const WslDrainEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1), ...ExecutionOwnerSchema.shape, environment: z.literal('wsl2'), ...WslUnitIdentitySchema.shape,
  reason: TextSchema, requestAcknowledged: z.boolean(), requestedAt: PositiveLimitSchema, acknowledgedAt: PositiveLimitSchema.nullable(),
  rootExited: z.boolean(), rootExitedAt: PositiveLimitSchema.nullable(), membershipEmpty: z.boolean(),
  membershipObservedAt: PositiveLimitSchema.nullable(), cgroupPopulated: z.union([z.literal(0), z.literal(1)]).nullable(),
  observationError: TextSchema.nullable(), unresolvedUnits: z.array(UnitSchema),
  outputComplete: z.boolean(), unresolvedOutputStreams: z.array(z.enum(['stdout', 'stderr'])), outputCompletedAt: PositiveLimitSchema.nullable(),
  completedAt: PositiveLimitSchema,
}).superRefine((evidence, ctx) => {
  if (!evidence.controlGroup.startsWith(`${evidence.observationSlice.controlGroup}/`) ||
      evidence.membershipEmpty !== (evidence.cgroupPopulated === 0) ||
      (evidence.membershipObservedAt === null) !== (evidence.cgroupPopulated === null) ||
      (evidence.observationError !== null) !== (evidence.cgroupPopulated === null) ||
      evidence.requestAcknowledged !== (evidence.acknowledgedAt !== null) || evidence.rootExited !== (evidence.rootExitedAt !== null) ||
      (evidence.membershipEmpty ? evidence.unresolvedUnits.length !== 0 : !evidence.unresolvedUnits.includes(evidence.unitName)) ||
      new Set(evidence.unresolvedOutputStreams).size !== evidence.unresolvedOutputStreams.length ||
      evidence.outputComplete !== (evidence.unresolvedOutputStreams.length === 0) || evidence.outputComplete !== (evidence.outputCompletedAt !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent WSL drain or output evidence' });
  }
});
export const DrainEvidenceSchema = z.union([WindowsDrainEvidenceSchema, WslDrainEvidenceSchema]);
export type DrainEvidence = z.infer<typeof DrainEvidenceSchema>;
export type ChildOutput = { stream: 'stdout' | 'stderr'; data: Buffer };
export interface OwnedExecution {
  describe(): Promise<OwnershipReceipt>;
  fence(): Promise<void>;
  renewLease(sequence: number): Promise<void>;
  drain(reason: string): Promise<DrainEvidence>;
  onOutput(listener: (output: ChildOutput) => void): () => void;
  writeInput(bytes: Uint8Array): Promise<Result<void>>;
  endInput(): Promise<Result<void>>;
}
export interface Supervisor { launchOwned(spec: LaunchInput): Promise<Result<OwnedExecution>> }
