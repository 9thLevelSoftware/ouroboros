import type { Result } from '../contracts/common.ts';
import type { DrainEvidence, ExecutionAuthorization, ExecutionOwner, OwnershipReceipt } from '../contracts/execution.ts';
import type { BoundaryProfile } from '../runtime/command-boundary.ts';

export type ArtifactRef = { id: string; sha256: string };
/** A qualification probe may supply a policy before it has an accepted receipt. */
export type ProviderBoundary = Omit<BoundaryProfile, 'qualification'> & { qualification?: BoundaryProfile['qualification'] };
export type ProviderStart = {
  owner: ExecutionOwner; actionId: string; workspaceRoot: string;
  promptRef: ArtifactRef; contextRefs: ArtifactRef[]; model: string; effort: string;
  boundary: ProviderBoundary; authorization: ExecutionAuthorization; mode: 'IMPLEMENT' | 'REFLECT';
};
export type ProviderResume = ProviderStart & {
  sessionId: string;
  /** Controller reconciles a persisted intent; never replay an ambiguous model action. */
  reconciliation: { priorOwner: ExecutionOwner; sessionId: string; evidenceIds: string[];
    priorExecutionDrained: true; outcome: 'safe_to_resume' };
};
export type ProviderInspection = {
  provider: 'codex' | 'claude'; runtimeVersion: string;
  capabilities: Record<string, { status: 'SUPPORTED' | 'UNSUPPORTED' | 'UNQUALIFIED'; reason: string }>;
  extraUsage: 'unknown';
};
export type ProviderEvent = ExecutionOwner & {
  sessionId: string; turnId: string | null;
} & (
  | { type: 'turn_started' | 'turn_completed' }
  | { type: 'tool_execution'; itemId: string; status: 'started' | 'completed' }
  | { type: 'approval'; decision: 'deny'; method: string }
  | { type: 'diagnostic' | 'auth_error' | 'quota_error'; code: string }
);
export type ExecutionInventory = {
  owner: ExecutionOwner; sessionId: string; turnId: string;
  complete: false; reason: string; capturedAt: number; ownership: OwnershipReceipt;
  observed: Array<{ kind: 'terminal' | 'item'; id: string; status: 'observed' | 'started' | 'completed' }>;
};
export type InterruptReceipt = {
  owner: ExecutionOwner; sessionId: string; turnId: string; acknowledged: boolean;
  inventory: ExecutionInventory; drain: DrainEvidence;
};
export interface ProviderSession {
  sessionId: string; turnId: string; events: AsyncIterable<ProviderEvent>;
  interrupt(): Promise<InterruptReceipt>; inspectExecution(): Promise<ExecutionInventory>;
  close(): Promise<DrainEvidence>;
}
export interface ProviderAdapter {
  inspect(): Promise<ProviderInspection>;
  start(input: ProviderStart): Promise<Result<ProviderSession>>;
  resume(input: ProviderResume): Promise<Result<ProviderSession>>;
}
