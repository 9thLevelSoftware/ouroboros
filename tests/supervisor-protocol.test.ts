import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createSupervisor, FrameDecoder, encodeFrame } from '../src/runtime/supervisor.ts';
import { LaunchSpecSchema } from '../src/contracts/execution.ts';

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: transport.spawn }));

const owner = { runId: '11111111-1111-4111-8111-111111111111', generation: 1,
  actionId: '22222222-2222-4222-8222-222222222222', role: 'implementation' };
const output = { protocolVersion: 1, ...owner, type: 'output', stream: 'stdout',
  data: Buffer.from('{"type":"drained","activeProcesses":0}').toString('base64') };

function naturalDrainPeer() {
  const peer = Object.assign(new EventEmitter(), { pid: 5023, stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: undefined as unknown as Writable, kill: vi.fn() });
  let buffered = Buffer.alloc(0); const controls: Record<string, unknown>[] = [];
  const timestamp = Date.now();
  const evidence = { schemaVersion: 1, ...owner, reason: 'root_exit', requestAcknowledged: false,
    requestedAt: timestamp, acknowledgedAt: null, rootExited: true, rootExitedAt: timestamp,
    membershipEmpty: true, membershipObservedAt: timestamp, activeProcesses: 0, unresolvedExecutions: [],
    childRanBeforeAssignment: false, completedAt: timestamp, outputComplete: true,
    unresolvedOutputStreams: [], outputCompletedAt: timestamp };
  peer.stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE()) {
      const size = buffered.readUInt32LE(); const message = JSON.parse(buffered.subarray(4, 4 + size).toString()); buffered = buffered.subarray(4 + size);
      controls.push(message);
      if (message.type === 'launch') setImmediate(() => peer.stdout.write(encodeFrame({ protocolVersion: 1, ...owner, type: 'launched',
        receipt: { schemaVersion: 1, ...owner, environment: 'windows', pid: 5024, creationIdentity: 'child-creation', helperPid: peer.pid,
          helperCreationIdentity: 'helper-creation', jobIdentity: 'private-job', boundaryHash: 'a'.repeat(64), assignedBeforeResume: true, capturedAt: timestamp } })));
    }
    callback();
  } });
  peer.kill.mockImplementation(() => { peer.stdout.end(); peer.emit('close', 1); return true; });
  transport.spawn.mockReturnValue(peer as unknown as ChildProcess);
  return { controls, evidence, peer, complete() {
    peer.stdout.end(encodeFrame({ protocolVersion: 1, ...owner, type: 'drained', evidence }));
    setImmediate(() => peer.emit('close', 0));
  } };
}
async function peerExecution() {
  const fixture = naturalDrainPeer();
  const result = await createSupervisor({ helperPath: 'C:\\trusted\\supervisor.exe', authorize: async () => true }).launchOwned({
    ...owner, executable: process.execPath, argv: [], cwd: process.cwd(), env: {}, boundaryHash: 'a'.repeat(64),
    authorization: { kind: 'qualification', requestId: owner.runId, probeId: 'drain-race', fixtureRoots: [process.cwd()] }, leaseTtlMs: 10000, deadline: Date.now() + 60000 });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message);
  return { ...fixture, execution: result.value };
}
describe('review drain concurrency', () => {
  it('returns natural drain evidence before the requested acknowledgment without inventing one', async () => {
    const fixture = await peerExecution();
    const pending = fixture.execution.drain('cancel race');
    const settled = Promise.allSettled([pending]); fixture.complete();
    const [result] = await settled;
    expect(result.status).toBe('fulfilled');
    if (result.status === 'fulfilled') { expect(result.value.requestAcknowledged).toBe(false); expect(result.value.acknowledgedAt).toBeNull(); }
    expect(fixture.peer.kill).not.toHaveBeenCalled();
  });
  it('coalesces concurrent drain callers onto the same truthful terminal evidence', async () => {
    const fixture = await peerExecution();
    const settled = Promise.allSettled([fixture.execution.drain('first'), fixture.execution.drain('second')]);
    fixture.complete(); const results = await settled;
    expect(fixture.controls.filter(control => control.type === 'drain')).toHaveLength(1);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    if (results[0].status === 'fulfilled' && results[1].status === 'fulfilled') expect(results[0].value).toBe(results[1].value);
  });
});

describe('supervisor framed protocol', () => {
  it('declares piped child input explicitly for provider transport', () => {
    expect(LaunchSpecSchema.safeParse({ ...owner, executable: 'C:\\node.exe', argv: [], cwd: 'C:\\fixture', env: {},
      boundaryHash: 'a'.repeat(64), authorization: { kind: 'qualified', qualificationRef: owner.runId },
      leaseTtlMs: 10000, deadline: Date.now()+60000, stdin: 'pipe' }).success).toBe(true);
  });
  it('reassembles fragmented/coalesced UTF-8 frames without interpreting output payload', () => {
    const decoder = new FrameDecoder(owner);
    const bytes = Buffer.concat([encodeFrame(output), encodeFrame({ ...output, stream: 'stderr' })]);
    const frames = [];
    for (const byte of bytes) frames.push(...decoder.push(Buffer.of(byte)));
    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe('output');
    expect(Buffer.from((frames[0] as typeof output).data, 'base64').toString()).toBe('{"type":"drained","activeProcesses":0}');
    decoder.finish();
  });
  it('rejects stale owner, action or generation identities', () => {
    for (const change of [{ generation: 2 }, { actionId: owner.runId }, { runId: owner.actionId }, { role: 'verification' }]) {
      expect(() => new FrameDecoder(owner).push(encodeFrame({ ...output, ...change }))).toThrow(/identity/i);
    }
  });
  it('rejects oversize frames from their prefix before buffering a body', () => {
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(1024 * 1024 + 1);
    expect(() => new FrameDecoder(owner).push(prefix)).toThrow(/size/i);
  });
  it('rejects forged output fields, invalid UTF-8 and truncated frames', () => {
    expect(() => new FrameDecoder(owner).push(encodeFrame({ ...output, activeProcesses: 0 }))).toThrow();
    expect(() => new FrameDecoder(owner).push(Buffer.from([1, 0, 0, 0, 255]))).toThrow();
    const decoder = new FrameDecoder(owner); decoder.push(Buffer.from([1, 0]));
    expect(() => decoder.finish()).toThrow(/truncated/i);
  });
  it('denies launch when the authorization resolver rejects or throws', async () => {
    const spec = { ...owner, executable: 'C:\\missing\\node.exe', argv: [], cwd: 'C:\\fixture', env: {},
      boundaryHash: 'a'.repeat(64), authorization: { kind: 'qualified' as const, qualificationRef: owner.runId },
      leaseTtlMs: 10000, deadline: Date.now() + 60000 };
    for (const authorize of [async () => false, async () => { throw new Error('missing receipt'); }]) {
      const result = await createSupervisor({ helperPath: 'C:\\missing\\helper.exe', authorize }).launchOwned(spec);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('EXECUTION_NOT_AUTHORIZED');
    }
  });
});
