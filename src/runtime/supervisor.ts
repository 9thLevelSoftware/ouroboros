import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { z } from 'zod';
import type { Result } from '../contracts/common.ts';
import { type ChildOutput, DrainEvidenceSchema, ExecutionOwnerSchema, LaunchSpecSchema, OwnershipReceiptSchema,
  type DrainEvidence, type ExecutionOwner, type LaunchSpec, type OwnedExecution, type OwnershipReceipt, type Supervisor } from '../contracts/execution.ts';

const MAX_FRAME = 1024 * 1024;
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const base = { protocolVersion: z.literal(1), ...ExecutionOwnerSchema.shape };
const payloadSchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(s => Buffer.from(s, 'base64').toString('base64') === s, 'Noncanonical base64');
const FrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('output'), stream: z.enum(['stdout', 'stderr']), data: payloadSchema }),
  z.strictObject({ ...base, type: z.literal('launched'), receipt: OwnershipReceiptSchema }),
  z.strictObject({ ...base, type: z.literal('described'), sequence: sequenceSchema, receipt: OwnershipReceiptSchema }),
  z.strictObject({ ...base, type: z.literal('ack'), sequence: sequenceSchema,
    operation: z.enum(['fence', 'renewLease', 'drain', 'input', 'endInput']) }),
  z.strictObject({ ...base, type: z.literal('drained'), evidence: DrainEvidenceSchema }),
  z.strictObject({ ...base, type: z.literal('error'), sequence: sequenceSchema, code: z.string().min(1), message: z.string().min(1) }),
]);
export type SupervisorFrame = z.infer<typeof FrameSchema>;
function sameOwner(a: ExecutionOwner, b: ExecutionOwner): boolean {
  return a.runId === b.runId && a.generation === b.generation && a.actionId === b.actionId && a.role === b.role;
}
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > MAX_FRAME) throw new Error('Invalid supervisor frame size');
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}
/** Prefix bounds are enforced before allocation; UTF-8 and each message shape are strict. */
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private bodyUsed = 0;
  private failed = false;
  private readonly owner: ExecutionOwner;
  constructor(owner: ExecutionOwner) { this.owner = ExecutionOwnerSchema.parse(owner); }
  push(chunk: Uint8Array): SupervisorFrame[] {
    if (this.failed) throw new Error('Supervisor decoder is failed');
    const frames: SupervisorFrame[] = [];
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.body) {
          const take = Math.min(4 - this.headerUsed, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + take), this.headerUsed); this.headerUsed += take; offset += take;
          if (this.headerUsed < 4) continue;
          const size = this.header.readUInt32LE();
          if (!size || size > MAX_FRAME) throw new Error('Invalid supervisor frame size');
          this.body = Buffer.alloc(size); this.bodyUsed = 0;
        }
        const take = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
        this.body.set(chunk.subarray(offset, offset + take), this.bodyUsed); this.bodyUsed += take; offset += take;
        if (this.bodyUsed === this.body.length) {
          const frame = FrameSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.body)));
          if (!sameOwner(frame, this.owner)) throw new Error('Supervisor frame identity mismatch');
          if (frame.type === 'launched' || frame.type === 'described') {
            if (!sameOwner(frame.receipt, this.owner)) throw new Error('Receipt identity mismatch');
          }
          if (frame.type === 'drained' && !sameOwner(frame.evidence, this.owner)) throw new Error('Drain identity mismatch');
          frames.push(frame); this.body = undefined; this.headerUsed = 0;
        }
      }
      return frames;
    } catch (error) { this.failed = true; throw error; }
  }
  finish(): void {
    if (this.failed || this.headerUsed || this.body) throw new Error('Truncated or failed supervisor frame');
  }
}
export type SupervisorOptions = {
  helperPath: string;
  /** Trusted controller lookup: bind explicit user-task authority or current receipt/probe approval to the entire spec.
   * Task 7 supplies qualification ledger lookup, freshness and resolved fixture-scope checks.
   * A reference or declared fixtureRoots alone never grants permission. */
  authorize: (spec: Readonly<LaunchSpec>) => Promise<boolean>;
  observation?: SupervisorRawMeter;
};
function failure<T>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, evidenceIds: [] } }; }
type Pending = { operation: string; resolve: (value: SupervisorFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** The controller persists dispatch intent first. This client owns no store authority. */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  if (!win32.isAbsolute(options.helperPath) || typeof options.authorize !== 'function') throw new Error('Absolute trusted helper and authorization resolver required');
  return {
    async launchOwned(input): Promise<Result<OwnedExecution>> {
      const parsed = LaunchSpecSchema.safeParse(input);
      if (!parsed.success) return failure('INVALID_LAUNCH_SPEC', parsed.error.message);
      // Clone before the asynchronous resolver to prevent caller mutation of approved inputs.
      const spec = parsed.data;
      if (!win32.isAbsolute(spec.executable) || !win32.isAbsolute(spec.cwd) ||
          (spec.authorization.kind === 'qualification' && spec.authorization.fixtureRoots.some(root => !win32.isAbsolute(root))) ||
          new Set(Object.keys(spec.env).map(key => key.toUpperCase())).size !== Object.keys(spec.env).length || spec.deadline <= Date.now()) {
        return failure('INVALID_LAUNCH_SPEC', 'Absolute paths, unique environment keys and future deadline required');
      }
      if (spec.launchNotAfter !== undefined && spec.launchNotAfter <= Date.now()) {
        return failure('LAUNCH_WINDOW_EXPIRED', 'Launch admission cutoff expired');
      }
      // Resolver receives a deep-frozen snapshot; the worker has no default permission path.
      Object.freeze(spec.argv); Object.freeze(spec.env);
      if (spec.authorization.kind === 'qualification') Object.freeze(spec.authorization.fixtureRoots);
      Object.freeze(spec.authorization); Object.freeze(spec);
      try { if (!(await options.authorize(spec))) return failure('EXECUTION_NOT_AUTHORIZED', 'Execution authorization lookup denied launch'); }
      catch { return failure('EXECUTION_NOT_AUTHORIZED', 'Execution authorization lookup failed'); }
      if (spec.launchNotAfter !== undefined && spec.launchNotAfter <= Date.now()) {
        return failure('LAUNCH_WINDOW_EXPIRED', 'Launch admission cutoff expired during authorization');
      }
      if (process.platform !== 'win32') return failure('UNSUPPORTED_ENVIRONMENT', 'Native supervisor requires Windows');
      if (spec.deadline <= Date.now()) return failure('DEADLINE_EXPIRED', 'Deadline expired during authorization');
      return await connectOwnedHelper({ file: options.helperPath, args: [] }, spec, 'windows', options.observation);
    },
  };
}
export type SupervisorRawMeter = {
  onRawBytes?: (source: 'helper', stream: 'stdout' | 'stderr', bytes: Uint8Array) => void;
  /** Kernel creation time to observed exit is a conservative upper duration bound. */
  onProcessCompleted?: (meter: {kind:'root'|'helper';identity:{pid:number;creationIdentity:string};activeMs:number}) => void;
  waitHelperExit?: boolean;
};
export async function connectOwnedHelper(command: { file: string; args: string[] }, spec: LaunchSpec, environment: 'windows' | 'wsl2', rawMeter?: SupervisorRawMeter): Promise<Result<OwnedExecution>> {
  const helper = spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const decoder = new FrameDecoder({ runId: spec.runId, generation: spec.generation, actionId: spec.actionId, role: spec.role });
  let receipt: OwnershipReceipt | undefined;
  let drainEvidence: DrainEvidence | undefined;
  let draining: Promise<DrainEvidence> | undefined;
  let fenced = false;
  let sequence = 0;
  let leaseSequence = 0;
  let endedInput = spec.stdin === 'closed';
  let stopped: Error | undefined;
  let outputBytes = 0;
  const listeners = new Set<(output: ChildOutput) => void>();
  const earlyOutput: ChildOutput[] = [];
  const pending = new Map<number, Pending>();
  let resolveHelperExit!:()=>void, rejectHelperExit!:(error:Error)=>void;
  const helperExit = new Promise<void>((resolve,reject)=>{resolveHelperExit=resolve;rejectHelperExit=reject;});void helperExit.catch(()=>{});
  const completedMeter=(kind:'root'|'helper',pid:number,creationIdentity:string,exitedAt:number)=>{
    if(!rawMeter?.onProcessCompleted)return;
    if(!/^[a-f0-9]{16}$/i.test(creationIdentity))throw new Error('Unknown process kernel creation time');
    const ticks=BigInt(`0x${creationIdentity}`),epoch=116444736000000000n;
    if(ticks<epoch)throw new Error('Invalid process kernel creation time');
    const createdAt=Number((ticks-epoch)/10000n);if(!Number.isSafeInteger(createdAt)||exitedAt<createdAt)throw new Error('Unknown process lifetime');
    rawMeter.onProcessCompleted({kind,identity:{pid,creationIdentity},activeMs:exitedAt-createdAt});
  };
  let resolveLaunch!: (receipt: OwnershipReceipt) => void;
  let rejectLaunch!: (error: Error) => void;
  const launched = new Promise<OwnershipReceipt>((resolve, reject) => { resolveLaunch = resolve; rejectLaunch = reject; });
  void launched.catch(() => {});
  let resolveDrain!: (evidence: DrainEvidence) => void;
  let rejectDrain!: (error: Error) => void;
  const drained = new Promise<DrainEvidence>((resolve, reject) => { resolveDrain = resolve; rejectDrain = reject; });
  // A natural completion may happen before the caller asks for evidence.
  void drained.catch(() => {});
  const fail = (error: Error): void => {
    if (stopped) return;
    stopped = error; fenced = true; endedInput = true;
    rejectHelperExit(error);
    rejectLaunch(error); if (!drainEvidence) rejectDrain(error);
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); } pending.clear();
    helper.stdin.destroy();
    // Only the owned ChildProcess handle is killed. Job kill-on-close owns descendants.
    helper.kill();
  };
  const launchTimer = setTimeout(() => fail(new Error('Supervisor launch acknowledgment timeout')), 15000);
  helper.on('error', error => fail(error));
  helper.stdin.on('error', error => { if (!drainEvidence) fail(error); });
  helper.stdout.on('error', error => fail(error));
  helper.stderr.on('error', error => fail(error));
  // Diagnostics can contain no child input; do not retain arbitrary helper stderr.
  helper.stderr.on('data', (bytes: Buffer) => { try { rawMeter?.onRawBytes?.('helper', 'stderr', bytes); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); } });
  helper.stdout.on('data', (bytes: Buffer) => {
    try {
      rawMeter?.onRawBytes?.('helper', 'stdout', bytes);
      for (const frame of decoder.push(bytes)) {
        if (frame.type === 'launched') {
          if (receipt || frame.receipt.environment !== environment ||
              (frame.receipt.environment === 'windows' && frame.receipt.helperPid !== helper.pid) ||
              frame.receipt.boundaryHash !== spec.boundaryHash) throw new Error('Unexpected helper ownership receipt');
          receipt = frame.receipt; clearTimeout(launchTimer); resolveLaunch(receipt);
        } else if (frame.type === 'output') {
          if (!receipt || drainEvidence) throw new Error('Child output outside owned execution');
          const data = Buffer.from(frame.data, 'base64'); outputBytes += data.length;
          if (outputBytes > 10 * 1024 * 1024) throw new Error('Child output budget exhausted');
          const output = { stream: frame.stream, data };
          if (!listeners.size) earlyOutput.push(output);
          else for (const listener of listeners) listener(output);
        } else if (frame.type === 'drained') {
          if (!receipt || drainEvidence) throw new Error('Unexpected drain receipt');
          if (receipt.environment === 'wsl2') {
            if (!('environment' in frame.evidence) || frame.evidence.environment !== 'wsl2' ||
                frame.evidence.unitName !== receipt.unitName || frame.evidence.invocationId !== receipt.invocationId ||
                frame.evidence.bootId !== receipt.bootId || frame.evidence.controlGroup !== receipt.controlGroup ||
                JSON.stringify(frame.evidence.observationSlice) !== JSON.stringify(receipt.observationSlice) ||
                JSON.stringify(frame.evidence.observer) !== JSON.stringify(receipt.observer)) throw new Error('WSL drainage incarnation mismatch');
          } else if ('environment' in frame.evidence) throw new Error('Windows drainage platform mismatch');
          if(receipt.environment==='windows'&&frame.evidence.rootExitedAt!==null)completedMeter('root',receipt.pid,receipt.creationIdentity,frame.evidence.rootExitedAt);
          drainEvidence = frame.evidence; fenced = true; endedInput = true; resolveDrain(drainEvidence);
          for (const value of pending.values()) {
            clearTimeout(value.timer);
            // Known terminal evidence reconciles cancellation even when the helper
            // completed naturally before accepting our drain request. It is no ack.
            if (value.operation === 'drain') value.resolve(frame);
            else value.reject(new Error('Execution completed before control acknowledgment'));
          }
          pending.clear();
          helper.stdin.end();
        } else {
          const waiter = pending.get(frame.sequence);
          if (!waiter) throw new Error('Unrequested or stale supervisor response');
          if (frame.type === 'ack' && frame.operation !== waiter.operation) throw new Error('Supervisor acknowledgment operation mismatch');
          if (frame.type === 'described' && (waiter.operation !== 'describe' || JSON.stringify(frame.receipt) !== JSON.stringify(receipt))) throw new Error('Ownership receipt changed');
          pending.delete(frame.sequence); clearTimeout(waiter.timer);
          if (frame.type === 'error') waiter.reject(new Error(`${frame.code}: ${frame.message}`)); else waiter.resolve(frame);
        }
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  helper.on('close', () => {
    clearTimeout(launchTimer);
    try { decoder.finish(); } catch (error) { fail(error as Error); return; }
    if (!drainEvidence) fail(new Error('Supervisor exited without drainage evidence; outcome unknown'));
    else try {if(receipt?.environment==='windows')completedMeter('helper',receipt.helperPid,receipt.helperCreationIdentity,Date.now());resolveHelperExit();}catch(error){fail(error instanceof Error?error:new Error(String(error)));}
  });
  const reconcileHelperExit=async(evidence:DrainEvidence):Promise<DrainEvidence>=>{
    if(!rawMeter?.waitHelperExit)return evidence;
    let timer:NodeJS.Timeout|undefined;try{await Promise.race([helperExit,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{const error=new Error('Actual helper exit unobserved');fail(error);reject(error);},5000);})]);return evidence;}finally{clearTimeout(timer);}
  };
  const write = (frame: unknown): Promise<void> => new Promise((resolve, reject) => {
    let bytes: Buffer; try { bytes = encodeFrame(frame); } catch (error) { reject(error); return; }
    helper.stdin.write(bytes, error => error ? reject(error) : resolve());
  });
  const request = (operation: string, extra: Record<string, unknown> = {}): Promise<SupervisorFrame> => {
    if (stopped || drainEvidence) return Promise.reject(stopped ?? new Error('Execution drained'));
    const next = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Supervisor control acknowledgment timeout')), 20000);
      pending.set(next, { operation, resolve, reject, timer });
      void write({ protocolVersion: 1, runId: spec.runId, generation: spec.generation, actionId: spec.actionId, role: spec.role,
        type: operation, sequence: next, ...extra }).catch(error => fail(error as Error));
    });
  };
  try {
    await write({ protocolVersion: 1, runId: spec.runId, generation: spec.generation, actionId: spec.actionId, role: spec.role, type: 'launch', spec });
    await launched;
  } catch (error) { clearTimeout(launchTimer); fail(error as Error); return failure('LAUNCH_FAILED', (error as Error).message); }
  const execution: OwnedExecution = {
    async waitForDrain() { return await reconcileHelperExit(await drained); },
    async describe() { if (drainEvidence) return receipt!; const frame = await request('describe'); if (frame.type !== 'described') throw new Error('Missing ownership receipt'); return frame.receipt; },
    async fence() { if (fenced) return; fenced = true; endedInput = true; await request('fence'); },
    async renewLease(next) {
      if (!Number.isSafeInteger(next) || next <= leaseSequence) throw new Error('Stale lease sequence');
      leaseSequence = next; await request('renewLease', { leaseSequence: next });
    },
    async drain(reason) {
      if (drainEvidence) return await reconcileHelperExit(drainEvidence);
      if (draining) return await draining;
      if (!reason.trim() || reason.length > 16384) throw new Error('Invalid drain reason');
      fenced = true; endedInput = true;
      draining = (async () => {
        await request('drain', { reason });
        return await reconcileHelperExit(await drained);
      })();
      return await draining;
    },
    onOutput(listener) { listeners.add(listener); for (const output of earlyOutput.splice(0)) listener(output); return () => listeners.delete(listener); },
    async writeInput(bytes) {
      if (fenced || endedInput || stopped || drainEvidence) return failure('INPUT_CLOSED', 'Execution input is closed');
      if (bytes.length > 65536) return failure('INPUT_TOO_LARGE', 'Child input writes are bounded to 64 KiB');
      try { await request('input', { data: Buffer.from(bytes).toString('base64') }); return { ok: true, value: undefined }; }
      catch { return failure('INPUT_FAILED', 'Child input was not acknowledged'); }
    },
    async endInput() {
      if (fenced || stopped || drainEvidence) return failure('INPUT_CLOSED', 'Execution input is closed');
      if (endedInput) return { ok: true, value: undefined };
      endedInput = true;
      try { await request('endInput'); return { ok: true, value: undefined }; }
      catch { return failure('INPUT_FAILED', 'Child input closure was not acknowledged'); }
    },
  };
  return { ok: true, value: execution };
}
