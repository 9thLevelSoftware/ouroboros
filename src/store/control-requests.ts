import type { Result } from '../contracts/common.ts';
import type { OwnerToken, ControlRequest } from '../contracts/evidence.ts';
import type { RunStore } from './database.ts';
export type { ControlRequest } from '../contracts/evidence.ts';
export function submitControlRequest(store: RunStore, expectedGeneration: number, request: ControlRequest): Result<string> { return store.enqueue(expectedGeneration, request); }
export function consumeControlRequests(store: RunStore, owner: OwnerToken): Result<ControlRequest[]> { return store.consume(owner); }
