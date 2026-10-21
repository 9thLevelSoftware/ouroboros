import { expect, it } from 'vitest';
import * as drivers from '../src/qualification/fixed-driver.ts';
import type { FixedDriverIO, FixedDriverRequest, FixedOperationOutcome } from '../src/qualification/fixed-driver.ts';
const networkPlan={schemaVersion:1 as const,proxy:{url:'http://localhost:38211',source:'documented-sandbox-managed' as const,policyHash:'d'.repeat(64),provenanceHash:'c'.repeat(64)},directTcp:{host:'192.0.2.1',port:18472}};
const proxyProof={runtimeProxyMatched:true,proxyProvenanceHash:networkPlan.proxy.provenanceHash,proxyPolicyHash:networkPlan.proxy.policyHash};
const domainDenial={...proxyProof,code:'HTTP_PROXY_DENIED',proxyError:'blocked-by-denylist'};

const request = (operation: FixedDriverRequest['operation'] = 'denied_source_write'): FixedDriverRequest => ({
 role: 'worker', executionId: 'worker-execution', operation, fixtureRoot: 'D:\\disposable\\boundary', targetHash: 'a'.repeat(64),networkPlan,
});
function fixture(outcome?: Partial<FixedOperationOutcome>) {
 const calls: unknown[] = [];
 const invoke = async (input: Parameters<FixedDriverIO['filesystem']['write']>[0]): Promise<FixedOperationOutcome> => {
  calls.push(input);
  return { role: input.role, executionId: input.executionId, operationId: input.operationId, attempted: true,
   effect: 'blocked', code: 'EACCES', origin: input.boundary, sensitiveBytesRead: false, ...outcome };
 };
 const io: FixedDriverIO = { filesystem: { read: invoke, write: invoke, linkAndWrite: invoke },
  network: { proxyHttp: invoke, directTcp: invoke, loopback: invoke }, broker: { writeThroughBroker: invoke },
  controller: { now: () => 10, snapshotSentinel: async input => ({ ...input, role: 'controller', executionId: 'controller-snapshot', sha256: 'c'.repeat(64), actualRead: true,...(input.probeId.endsWith('.link_escape')?{linkTargetMatched:true}:{}) }),
   observeBroker: async input => ({ ...input,role:'controller',executionId:'controller-service',serviceGeneration:'broker-1',actualAttempt:true,available:true,observedFromMs:0,availableThroughMs:20 }) } };
 return { io, calls };
}
it('exports an executable fixed driver', () => { expect(typeof drivers.runFixedBoundaryDriver).toBe('function'); });
it('attempts a literal source sentinel write and retains attributable enforcement', async () => {
 const f = fixture(); const result = await drivers.runFixedBoundaryDriver(request(), f.io);
 expect(result.status).toBe('PASS'); expect(result.actualAttempt).toBe(true);
 expect(f.calls).toEqual([{ role: 'worker', executionId: 'worker-execution', operationId: 'worker.denied_source_write',
  boundary: 'filesystem', path: 'D:\\disposable\\boundary\\source\\sentinel.txt', bytes: 'OUROBOROS_FIXED_WRITE_V1\r\n' }]);
});
it.each(['denied_controller_write', 'denied_sibling_write', 'denied_sensitive_read', 'link_escape', 'broker_escape'] as const)
 ('executes the fixed %s operation', async operation => {
  const f = fixture(); const result = await drivers.runFixedBoundaryDriver(request(operation), f.io);
  expect(result.status).toBe('PASS'); expect(f.calls).toHaveLength(1);
  const call = f.calls[0] as Record<string, unknown>;
  if (operation === 'link_escape') {
   expect(call.linkPath).toBe('D:\\disposable\\boundary\\workspace\\escape-link-worker');
   expect(call.targetPath).toBe('D:\\disposable\\boundary\\source\\sentinel.txt');
  } else {
   const expected = { denied_controller_write: 'controller-sentinel', denied_sibling_write: 'sibling',
    denied_sensitive_read: 'fake-credential', broker_escape: 'source' }[operation];
   expect(call.path).toBe(`D:\\disposable\\boundary\\${expected}\\sentinel.txt`);
  }
  if (operation === 'denied_sensitive_read') expect(call.bytes).toBeUndefined();
 });
it.each([
 { attempted: false }, { code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }, { effect: 'refused' },
 { origin: 'tool' }, { executionId: 'verifier-execution' }, { role: 'verifier' }, { operationId: 'other' },
] as Partial<FixedOperationOutcome>[])('does not accept inconclusive or misattributed denials %j', async outcome => {
 const f = fixture(outcome); expect((await drivers.runFixedBoundaryDriver(request(), f.io)).status).not.toBe('PASS');
});
it('fails when a forbidden write succeeds', async () => {
 const f = fixture({ effect: 'allowed', code: undefined });
 expect((await drivers.runFixedBoundaryDriver(request(), f.io)).status).toBe('FAIL');
});
it('does not qualify junction traversal without independent current link target proof',async()=>{
 const f=fixture();f.io.controller!.snapshotSentinel=async input=>({...input,role:'controller',executionId:'controller-snapshot',sha256:'c'.repeat(64),actualRead:true});
 expect(await drivers.runFixedBoundaryDriver(request('link_escape'),f.io)).toMatchObject({status:'UNTESTED',actualAttempt:false,reasonCode:'SENTINEL_BASELINE_UNPROVEN'});expect(f.calls).toEqual([]);
});
it('requires readback of the literal allowed edit', async () => {
 const f = fixture({ effect: 'allowed', code: undefined, data: 'OUROBOROS_FIXED_WRITE_V1\r\n' });
 expect((await drivers.runFixedBoundaryDriver(request('allowed_edit'), f.io)).status).toBe('PASS');
 expect(f.calls).toHaveLength(2);
 const bad = fixture({ effect: 'allowed', data: 'wrong' });
 expect((await drivers.runFixedBoundaryDriver(request('allowed_edit'), bad.io)).status).toBe('FAIL');
});
it.each(['allowed_proxy_network', 'denied_network', 'denied_direct_tcp', 'denied_loopback'] as const)
 ('requires independent controller availability before %s', async operation => {
  const f = fixture(); expect((await drivers.runFixedBoundaryDriver(request(operation), f.io)).status).toBe('UNTESTED');
  expect(f.calls).toHaveLength(0);
 });
it.each(['allowed_proxy_network', 'denied_network', 'denied_direct_tcp', 'denied_loopback'] as const)
 ('runs available fixed network operation %s through its distinct seam', async operation => {
  const r = request(operation); const endpoint = operation === 'allowed_proxy_network' ? 'http://localhost:18471/allowed' : operation==='denied_direct_tcp'?'tcp://192.0.2.1:18472':'http://127.0.0.1:18472/denied';
  const proof = { role: 'controller' as const, executionId: 'controller-endpoint', endpoint, targetHash: r.targetHash, fixtureRoot: r.fixtureRoot, available: true, actualAttempt: true };
  const f = fixture(operation === 'allowed_proxy_network' ? { ...proxyProof,effect: 'allowed', code: undefined, data: 'OUROBOROS_ENDPOINT_V1' } : operation==='denied_network'?domainDenial:{});
  f.io.controller = { ...f.io.controller!, observeEndpoint: async input => ({ ...proof, networkPlanHash:input.networkPlanHash,boundaryRole: input.boundaryRole, boundaryExecutionId: input.boundaryExecutionId, serviceGeneration: 'endpoint-1', observedFromMs: 0, availableThroughMs: 20 }) };
  const expected = operation === 'denied_direct_tcp' ? 'directTcp' : operation === 'denied_loopback' ? 'loopback' : 'proxyHttp';
  for (const key of ['proxyHttp', 'directTcp', 'loopback'] as const) {
   if (key !== expected) f.io.network[key] = async () => { throw new Error('wrong transport'); };
  }
  expect((await drivers.runFixedBoundaryDriver(r, f.io)).status).toBe('PASS'); expect(f.calls).toHaveLength(1);
 });
it('rejects borrowed endpoint and boundary execution evidence', async () => {
 const r = request('denied_network');
 const proof = { role: 'controller' as const, executionId: r.executionId, endpoint: 'http://127.0.0.1:18472/denied', targetHash: r.targetHash, fixtureRoot: r.fixtureRoot, available: true, actualAttempt: true };
 const f = fixture(); f.io.controller = { ...f.io.controller!, observeEndpoint: async () => proof as never }; expect((await drivers.runFixedBoundaryDriver(r, f.io)).status).toBe('UNTESTED'); expect(f.calls).toHaveLength(0);
});
it.each([{ available: false }, { actualAttempt: false }, { role: 'worker' }, { targetHash: 'b'.repeat(64) },{networkPlanHash:'f'.repeat(64)},
 { fixtureRoot: 'D:\\another' }, { endpoint: 'http://localhost:1/unapproved' }])('rejects unavailable or mismatched controller proof %j', async patch => {
 const r = request('denied_network'); const f = fixture();
 f.io.controller = { ...f.io.controller!, observeEndpoint: async input => ({ ...input,role: 'controller', executionId: 'controller-endpoint',serviceGeneration:'endpoint-1',observedFromMs:0,availableThroughMs:20,
  available: true, actualAttempt: true, ...patch }) as never };
 expect((await drivers.runFixedBoundaryDriver(r, f.io)).status).toBe('UNTESTED'); expect(f.calls).toHaveLength(0);
});
it.each(['relative', 'D:\\fixture\\..\\escape', 'D:\\fixture:stream', '\\\\server\\share', 'D:\\fixture\\.\\alias'])
 ('rejects noncanonical fixture root %s before IO', async fixtureRoot => {
  const f = fixture(); await expect(drivers.runFixedBoundaryDriver({ ...request(), fixtureRoot }, f.io)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
 });
it('keeps verifier execution identity independent and rejects unknown operations', async () => {
 const f = fixture(); const result = await drivers.runFixedBoundaryDriver({ ...request(), role: 'verifier', executionId: 'verifier-execution' }, f.io);
 expect(result.probeId).toBe('verifier.denied_source_write'); expect(result.executionId).toBe('verifier-execution');
 await expect(drivers.runFixedBoundaryDriver({ ...request(), operation: 'shell' as never }, f.io)).rejects.toThrow();
});
it('classifies thrown or missing seams as untested without fabricating enforcement', async () => {
 const f = fixture(); f.io.filesystem.write = async () => { throw Object.assign(Error('blocked'), { code: 'EACCES' }); };
 expect((await drivers.runFixedBoundaryDriver(request(), f.io)).status).toBe('UNTESTED');
 expect((await drivers.runFixedBoundaryDriver(request(), {} as FixedDriverIO)).status).toBe('UNTESTED');
});
it('retains the validated target while a controller check awaits', async () => {
 const r = request('denied_network'); const f = fixture(domainDenial);
 f.io.controller = { ...f.io.controller!, observeEndpoint: async input => {
  r.fixtureRoot = 'D:\\other'; r.executionId = 'changed'; r.operation = 'allowed_edit';
  return { role: 'controller', executionId: 'controller-endpoint', endpoint: input.endpoint,
   fixtureRoot: input.fixtureRoot, targetHash: input.targetHash, available: true, actualAttempt: true,
   networkPlanHash:input.networkPlanHash,boundaryRole: input.boundaryRole, boundaryExecutionId: input.boundaryExecutionId, serviceGeneration: 'endpoint-1', observedFromMs: 0, availableThroughMs: 20 };
 } };
 const result = await drivers.runFixedBoundaryDriver(r, f.io);
 expect(result.status).toBe('PASS'); expect(result.probeId).toBe('worker.denied_network');
 expect(result.executionId).toBe('worker-execution');
});
it('does not pass denied writes without controller snapshots before and after', async () => {
 const f = fixture(); f.io.controller = undefined;
 expect((await drivers.runFixedBoundaryDriver(request(), f.io)).status).toBe('UNTESTED');
});
it('fails a denied write whose protected sentinel changed', async () => {
 const f = fixture(); const snapshot = f.io.controller!.snapshotSentinel!;
 f.io.controller!.snapshotSentinel = async input => ({ ...await snapshot(input), sha256: input.phase === 'before' ? 'c'.repeat(64) : 'd'.repeat(64) });
 expect((await drivers.runFixedBoundaryDriver(request(), f.io)).status).toBe('FAIL');
});
it.each([true, undefined])('does not pass sensitive read with sensitiveBytesRead=%s', async sensitiveBytesRead => {
 const f = fixture({ sensitiveBytesRead });
 expect((await drivers.runFixedBoundaryDriver(request('denied_sensitive_read'), f.io)).status).not.toBe('PASS');
});
it('does not pass network denial when service availability ends before operation completion', async () => {
 const f = fixture(); let now = 10;
 f.io.controller!.now = () => now++;
 f.io.controller!.observeEndpoint = async input => ({ role: 'controller', executionId: 'controller-endpoint',
  ...input, available: true, actualAttempt: true, serviceGeneration: 'endpoint-1', observedFromMs: 0, availableThroughMs: 10 });
 expect((await drivers.runFixedBoundaryDriver(request('denied_network'), f.io)).status).toBe('UNTESTED');
});
it('accepts a fresh prior endpoint observation without predicting a future timestamp', async () => {
 const f=fixture(domainDenial);let now=11;f.io.controller!.now=()=>now++;
 f.io.controller!.observeEndpoint=async input=>({...input,role:'controller',executionId:'controller-service',serviceGeneration:'endpoint-1',actualAttempt:true,available:true,observedFromMs:0,availableThroughMs:input.phase==='before'?10:13});
 expect((await drivers.runFixedBoundaryDriver(request('denied_network'),f.io)).status).toBe('PASS');
});
it('does not pass named-pipe broker denial without independent broker service availability',async()=>{
 const f=fixture();f.io.controller!.observeBroker=undefined;
 expect((await drivers.runFixedBoundaryDriver(request('broker_escape'),f.io)).status).toBe('UNTESTED');
});
it('rejects a network request lacking an approved versioned network plan',async()=>{
 const f=fixture();await expect(drivers.runFixedBoundaryDriver({...request('denied_network'),networkPlan:undefined},f.io)).rejects.toThrow();expect(f.calls).toHaveLength(0);
});
it('uses the approved nonloopback direct TCP target independently from loopback',async()=>{
 const f=fixture();f.io.controller!.observeEndpoint=async input=>({...input,role:'controller',executionId:'controller-service',serviceGeneration:'endpoint-1',actualAttempt:true,available:true,observedFromMs:0,availableThroughMs:20});
 expect((await drivers.runFixedBoundaryDriver(request('denied_direct_tcp'),f.io)).status).toBe('PASS');expect(f.calls[0]).toMatchObject({host:'192.0.2.1',port:18472});
});
it('does not qualify a domain denial from inability to reach the runtime proxy',async()=>{
 const f=fixture();f.io.controller!.observeEndpoint=async input=>({...input,role:'controller',executionId:'controller-service',serviceGeneration:'endpoint-1',actualAttempt:true,available:true,observedFromMs:0,availableThroughMs:20});
 expect((await drivers.runFixedBoundaryDriver(request('denied_network'),f.io)).status).toBe('UNTESTED');
});
it('accepts only an intended domain-policy rejection through the matched runtime proxy',async()=>{
 const f=fixture({code:'HTTP_PROXY_DENIED',proxyError:'blocked-by-denylist',runtimeProxyMatched:true,proxyProvenanceHash:networkPlan.proxy.provenanceHash,proxyPolicyHash:networkPlan.proxy.policyHash});
 f.io.controller!.observeEndpoint=async input=>({...input,role:'controller',executionId:'controller-service',serviceGeneration:'endpoint-1',actualAttempt:true,available:true,observedFromMs:0,availableThroughMs:20});
 expect((await drivers.runFixedBoundaryDriver(request('denied_network'),f.io)).status).toBe('PASS');
});
it.each(['blocked-by-method-policy','blocked-by-policy'])('does not substitute %s for intended domain enforcement',async proxyError=>{
 const f=fixture({...domainDenial,proxyError});f.io.controller!.observeEndpoint=async input=>({...input,role:'controller',executionId:'controller-service',serviceGeneration:'endpoint-1',actualAttempt:true,available:true,observedFromMs:0,availableThroughMs:20});
 expect((await drivers.runFixedBoundaryDriver(request('denied_network'),f.io)).status).toBe('UNTESTED');
});


