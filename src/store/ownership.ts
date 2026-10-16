import type { Result } from '../contracts/common.ts';
import type { OwnerToken } from '../contracts/evidence.ts';
import type { RunStore } from './database.ts';
export type { OwnerToken } from '../contracts/evidence.ts';
export function claimRun(store: RunStore, repoId: string, runId: string): Result<OwnerToken> { return store.claim(repoId, runId); }
// Caller must prove runtime drainage separately. No timeout or automatic takeover.
export function releaseRun(store: RunStore, owner: OwnerToken): Result<void> { return store.release(owner); }
