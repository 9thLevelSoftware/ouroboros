import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createSupervisor, FrameDecoder, encodeFrame, type SupervisorRawMeter } from '../src/runtime/supervisor.ts';
import { LaunchSpecSchema, WindowsDrainEvidenceSchema } from '../src/contracts/execution.ts';

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
  return { controls, evidence, peer, complete(close = true) {
    peer.stdout.end(encodeFrame({ protocolVersion: 1, ...owner, type: 'drained', evidence }));
    if (close) setImmediate(() => peer.emit('close', 0));
  } };
}
async function peerExecution(observation?: SupervisorRawMeter) {
  const fixture = naturalDrainPeer();
  const result = await createSupervisor({ helperPath: 'C:\\trusted\\supervisor.exe', authorize: async () => true, observation }).launchOwned({
    ...owner, executable: process.execPath, argv: [], cwd: process.cwd(), env: {}, boundaryHash: 'a'.repeat(64),
    authorization: { kind: 'qualification', requestId: owner.runId, probeId: 'drain-race', fixtureRoots: [process.cwd()] }, leaseTtlMs: 10000, deadline: Date.now() + 60000 });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message);
  return { ...fixture, execution: result.value };
}
describe('review drain concurrency', () => {
  it('observes passive completion without controls and reconciles actual helper exit', async () => {
    const fixture = await peerExecution({ waitHelperExit: true });
    Object.assign(fixture.evidence, { rootExitCode: 7 });
    let settled = false;
    expect(fixture.execution.waitForDrain).toBeTypeOf('function');
    const completion = fixture.execution.waitForDrain!().then(evidence => { settled = true; return evidence; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(fixture.controls.map(control => control.type)).toEqual(['launch']);
    expect(fixture.peer.kill).not.toHaveBeenCalled();
    fixture.complete(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); // Terminal evidence alone is insufficient when helper exit is required.
    fixture.peer.emit('close', 0);
    expect(await completion).toEqual(fixture.evidence);
    expect(await fixture.execution.waitForDrain!()).toEqual(fixture.evidence);
    expect(fixture.controls.map(control => control.type)).toEqual(['launch']);
    expect(fixture.peer.kill).not.toHaveBeenCalled();
  });
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
  const drainEvidence = { schemaVersion: 1, ...owner, reason: 'root_exit', requestAcknowledged: false,
    requestedAt: 1, acknowledgedAt: null, rootExited: true, rootExitedAt: 1,
    membershipEmpty: true, membershipObservedAt: 1, activeProcesses: 0, unresolvedExecutions: [],
    childRanBeforeAssignment: false, completedAt: 1, outputComplete: true,
    unresolvedOutputStreams: [], outputCompletedAt: 1 };
  const decodeDrain = (evidence: unknown) => new FrameDecoder(owner).push(encodeFrame({
    protocolVersion: 1, ...owner, type: 'drained', evidence }))[0];
  it.each([0, 1, 259, 4294967295, null])('preserves observed or unknown Windows root exit code %s', rootExitCode => {
    const evidence = { ...drainEvidence, rootExitCode };
    expect(WindowsDrainEvidenceSchema.parse(evidence).rootExitCode).toBe(rootExitCode);
    const frame = decodeDrain(evidence);
    expect(frame.type).toBe('drained');
    if (frame.type === 'drained' && 'rootExitCode' in frame.evidence) expect(frame.evidence.rootExitCode).toBe(rootExitCode);
    else throw new Error('Windows root exit code missing from decoded evidence');
  });
  it('keeps historical absent exit status and unexited unknown status decodable', () => {
    expect(WindowsDrainEvidenceSchema.parse(drainEvidence)).not.toHaveProperty('rootExitCode');
    expect(decodeDrain(drainEvidence).type).toBe('drained');
    const unexited = { ...drainEvidence, rootExited: false, rootExitedAt: null, rootExitCode: null };
    expect(WindowsDrainEvidenceSchema.safeParse(unexited).success).toBe(true);
    expect(decodeDrain(unexited).type).toBe('drained');
  });
  it.each([-1, 0.5, 4294967296, '0', true])('rejects invalid Windows root exit code %s', rootExitCode => {
    const evidence = { ...drainEvidence, rootExitCode };
    expect(WindowsDrainEvidenceSchema.safeParse(evidence).success).toBe(false);
    expect(() => decodeDrain(evidence)).toThrow();
  });
  it.each([0, 1])('rejects known Windows root exit code %s without observed root exit', rootExitCode => {
    const evidence = { ...drainEvidence, rootExited: false, rootExitedAt: null, rootExitCode };
    expect(WindowsDrainEvidenceSchema.safeParse(evidence).success).toBe(false);
    expect(() => decodeDrain(evidence)).toThrow();
  });
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

describe('launch admission contract', () => {
  const spec = { ...owner, executable: 'C:\\node.exe', argv: [], cwd: 'C:\\fixture', env: {},
    boundaryHash: 'a'.repeat(64), authorization: { kind: 'user-task' as const, authorizationId: owner.actionId, taskHash: 'b'.repeat(64) },
    leaseTtlMs: 10000, deadline: 2000 };
  it('accepts explicit user-task authority and preserves its exact wire fields', async () => {
    const fixture = naturalDrainPeer();
    const authorize = vi.fn(async () => true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      expect(LaunchSpecSchema.parse(spec).authorization).toEqual(spec.authorization);
      const result = await createSupervisor({ helperPath: 'C:\\trusted\\supervisor.exe', authorize }).launchOwned({ ...spec, launchNotAfter: 1500 });
      expect(result.ok).toBe(true);
      expect(authorize).toHaveBeenCalledOnce();
      expect(fixture.controls[0].spec).toMatchObject({ authorization: spec.authorization, launchNotAfter: 1500, deadline: 2000 });
      fixture.complete();
    } finally { clock.mockRestore(); }
  });
  it.each([{ authorizationId: 'not-a-uuid' }, { taskHash: 'B'.repeat(64) }, { taskHash: 'b'.repeat(63) }, { qualificationRef: 'forged' }])(
    'rejects malformed user-task authority %j', change => {
      expect(LaunchSpecSchema.safeParse({ ...spec, authorization: { ...spec.authorization, ...change } }).success).toBe(false);
    });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2001, null])('rejects invalid launch cutoff %s', launchNotAfter => {
    expect(LaunchSpecSchema.safeParse({ ...spec, launchNotAfter }).success).toBe(false);
  });
  it('accepts historical specs without a cutoff and a cutoff equal to the task deadline', () => {
    expect(LaunchSpecSchema.safeParse(spec).success).toBe(true);
    expect(LaunchSpecSchema.safeParse({ ...spec, launchNotAfter: spec.deadline }).success).toBe(true);
  });
  it('rejects an expired cutoff before authorization without spawning', async () => {
    transport.spawn.mockClear();
    const authorize = vi.fn(async () => true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1500);
    try {
      const result = await createSupervisor({ helperPath: 'C:\\trusted\\supervisor.exe', authorize }).launchOwned({ ...spec, launchNotAfter: 1500 });
      expect(result).toMatchObject({ ok: false, error: { code: 'LAUNCH_WINDOW_EXPIRED' } });
      expect(authorize).not.toHaveBeenCalled(); expect(transport.spawn).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it('rechecks the cutoff after asynchronous authorization without changing the task deadline', async () => {
    transport.spawn.mockClear();
    let time = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    let release!: (approved: boolean) => void;
    const authorize = vi.fn((_approvedSpec: { deadline: number }) => new Promise<boolean>(resolve => { release = resolve; }));
    try {
      const pending = createSupervisor({ helperPath: 'C:\\trusted\\supervisor.exe', authorize }).launchOwned({ ...spec, launchNotAfter: 1500 });
      expect(authorize).toHaveBeenCalledOnce();
      time = 1500; release(true);
      expect(await pending).toMatchObject({ ok: false, error: { code: 'LAUNCH_WINDOW_EXPIRED' } });
      expect(transport.spawn).not.toHaveBeenCalled();
      expect(authorize.mock.calls[0][0].deadline).toBe(2000);
    } finally { clock.mockRestore(); }
  });
});
