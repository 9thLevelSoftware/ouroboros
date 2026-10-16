import type { Result } from '../contracts/common.ts';
import type { OwnerToken, ActionIntent, ActionRecord, ActionOutcome } from '../contracts/evidence.ts';
import type { RunStore } from './database.ts';
export type { ActionIntent, ActionRecord, ActionOutcome } from '../contracts/evidence.ts';
export function recordIntent(store: RunStore, owner: OwnerToken, intent: ActionIntent): Result<ActionRecord> { return store.intent(owner, intent); }
// This receipt must commit before the caller dispatches anything externally.
export function markDispatched(store: RunStore, owner: OwnerToken, actionId: string): Result<ActionRecord> { return store.dispatch(owner, actionId); }
export function markOutcomeUnknown(store: RunStore, owner: OwnerToken, actionId: string): Result<ActionRecord> { return store.unknown(owner, actionId); }
export function appendOutcome(store: RunStore, owner: OwnerToken, actionId: string, outcome: ActionOutcome): Result<void> { return store.outcome(owner, actionId, outcome); }
