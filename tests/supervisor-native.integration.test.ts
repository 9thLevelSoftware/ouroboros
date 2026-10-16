import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import { createSupervisor } from '../src/runtime/supervisor.ts';
import type { DrainEvidence, LaunchSpec, OwnedExecution, OwnershipReceipt } from '../src/contracts/execution.ts';

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 10000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error(`Timeout waiting for ${description}`);
    await delay(10);
  }
}

it('integrates actual TS/native framing, stdin, typed output and natural complete drainage', async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'ouroboros-client-native-'));
  const rootFile = resolve(fixtureRoot, 'root-heartbeat.txt');
  const helperPath = resolve('native/supervisor/target/debug/ouroboros-supervisor.exe');
  const fixturePath = resolve('tests/support/heartbeat-child.mjs');
  const owner = { runId: randomUUID(), generation: 1, actionId: randomUUID(), role: 'qualification' };
  const requestId = randomUUID();
  const spec: LaunchSpec = { ...owner, executable: process.execPath,
    argv: [fixturePath, 'client-integration', rootFile, resolve(fixtureRoot, 'unused-descendant.txt')],
    cwd: fixtureRoot, env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, stdin: 'pipe',
    boundaryHash: createHash('sha256').update(`disposable-client-native:${fixtureRoot}:${requestId}`).digest('hex'),
    authorization: { kind: 'qualification', requestId, probeId: 'ts-native-stdio-natural-exit', fixtureRoots: [fixtureRoot] },
    leaseTtlMs: 10000, deadline: Date.now() + 30000 };
  const declaredSpec = structuredClone(spec);
  let authorizationChecks = 0;
  let execution: OwnedExecution | undefined;
  let receipt: OwnershipReceipt | undefined;
  let evidence: DrainEvidence | undefined;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let unsubscribe: (() => void) | undefined;
  let completionObserved = false;
  try {
    const helperHash = createHash('sha256').update(await readFile(helperPath)).digest('hex');
    const supervisor = createSupervisor({ helperPath, authorize: async approved => {
      authorizationChecks++;
      return Object.isFrozen(approved) && approved.authorization.kind === 'qualification' &&
        approved.authorization.requestId === requestId && approved.authorization.probeId === 'ts-native-stdio-natural-exit' &&
        approved.authorization.fixtureRoots.length === 1 && approved.authorization.fixtureRoots[0] === fixtureRoot &&
        isDeepStrictEqual(approved, declaredSpec);
    } });
    const result = await supervisor.launchOwned(spec);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    execution = result.value;
    receipt = await execution.describe();
    expect(receipt).toMatchObject({ ...owner, environment: 'windows', boundaryHash: spec.boundaryHash, assignedBeforeResume: true });
    expect(receipt.creationIdentity).toMatch(/^[a-f0-9]{16}$/);
    expect(receipt.helperCreationIdentity).toMatch(/^[a-f0-9]{16}$/);
    expect(authorizationChecks).toBe(1);
    unsubscribe = execution.onOutput(output => {
      expect(Buffer.isBuffer(output.data)).toBe(true);
      expect(['stdout', 'stderr']).toContain(output.stream);
      if (output.stream === 'stdout') stdout = Buffer.concat([stdout, output.data]);
      else stderr = Buffer.concat([stderr, output.data]);
      if (stdout.length + stderr.length > 131072) throw new Error('Disposable integration output exceeded bound');
    });
    await waitUntil(() => stdout.toString().includes(`"readyPid":${receipt!.pid}`), 'real child readiness');
    const input = Buffer.from('{"type":"drained","probe":"opaque child input"}\u0000 ✓\n');
    expect(await execution.writeInput(input)).toEqual({ ok: true, value: undefined });
    const response = JSON.stringify({ responseBase64: input.toString('base64') });
    await waitUntil(() => stdout.toString().includes(response), 'real stdin response');
    expect(await execution.endInput()).toEqual({ ok: true, value: undefined });
    await waitUntil(() => stdout.toString().endsWith('FINAL-CLIENT-STDOUT') && stderr.toString() === 'FINAL-CLIENT-STDERR', 'final unterminated typed output');
    // Read-only PID existence checks never kill or identify ownership by name.
    // Waiting for helper exit makes drain() retrieve its natural terminal receipt.
    await waitUntil(() => !running(receipt!.helperPid), 'owned helper natural exit');
    await delay(10);
    evidence = await execution.drain('retrieve natural completion evidence');
    expect(evidence).toMatchObject({ ...owner, reason: 'root_exit', requestAcknowledged: false, acknowledgedAt: null,
      rootExited: true, membershipEmpty: true, activeProcesses: 0, unresolvedExecutions: [],
      outputComplete: true, unresolvedOutputStreams: [], childRanBeforeAssignment: false });
    expect(evidence.outputCompletedAt).not.toBeNull();
    expect(evidence.rootExitedAt).not.toBeNull();
    expect(running(receipt.pid)).toBe(false);
    const atDrain = (await stat(rootFile)).size;
    await delay(100);
    expect((await stat(rootFile)).size).toBe(atDrain);
    completionObserved = true;
    await writeFile(resolve(fixtureRoot, 'integration-receipt.json'), JSON.stringify({ helperPath, helperHash, fixtureRoot,
      authorizationKind: spec.authorization.kind, receipt, evidence, stdoutBytes: stdout.length, stderrBytes: stderr.length,
      rootHeartbeatBytesAfterDrain: atDrain, ownedHelperAbsent: true, ownedRootAbsent: true }, null, 2));
    console.info(`Native integration receipt: ${resolve(fixtureRoot, 'integration-receipt.json')}`);
  } finally {
    unsubscribe?.();
    if (execution && !completionObserved) {
      // Cleanup stays inside the captured OwnedExecution; no PID/name kill fallback.
      try { evidence = await execution.drain('disposable integration cleanup'); }
      finally {
        await writeFile(resolve(fixtureRoot, 'failure-cleanup.json'), JSON.stringify({ fixtureRoot, receipt, evidence,
          helperAbsent: receipt ? !running(receipt.helperPid) : null, rootAbsent: receipt ? !running(receipt.pid) : null }, null, 2));
      }
    }
  }
}, 40000);
