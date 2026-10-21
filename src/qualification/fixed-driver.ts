import { win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint } from './probes.ts';

export type FixedNetworkPlan = {schemaVersion:1;proxy:{url:string;source:'documented-sandbox-managed';policyHash:string;provenanceHash:string};directTcp:{host:string;port:number}};
export function validateFixedNetworkPlan(plan:FixedNetworkPlan):void {
 if(!plan||Object.keys(plan).sort().join()!=='directTcp,proxy,schemaVersion'||plan.schemaVersion!==1||!plan.proxy||!plan.directTcp||
  Object.keys(plan.proxy).sort().join()!=='policyHash,provenanceHash,source,url'||Object.keys(plan.directTcp).sort().join()!=='host,port'||
  plan.proxy.source!=='documented-sandbox-managed'||!/^[a-f0-9]{64}$/.test(plan.proxy.policyHash)||!/^[a-f0-9]{64}$/.test(plan.proxy.provenanceHash))throw Error('Approved network plan required');
 const url=new URL(plan.proxy.url);const octets=plan.directTcp.host?.split('.');
 if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
  !octets||octets.length!==4||octets.some(o=>!/^\d{1,3}$/.test(o)||String(Number(o))!==o||Number(o)>255)||Number(octets[0])===0||Number(octets[0])===127||Number(octets[0])>=224||
  (octets[0]==='169'&&octets[1]==='254')||!Number.isInteger(plan.directTcp.port)||plan.directTcp.port<1||plan.directTcp.port>65535)throw Error('Approved proxy and distinct direct TCP target required');
}

export type FixedDriverRole = 'worker' | 'verifier';
export type FixedBoundaryOperation = 'allowed_edit' | 'denied_source_write' | 'denied_controller_write' | 'denied_sibling_write'
 | 'denied_sensitive_read' | 'allowed_proxy_network' | 'denied_network' | 'denied_direct_tcp' | 'denied_loopback' | 'link_escape' | 'broker_escape';
type Boundary = 'filesystem' | 'network-proxy' | 'network-tcp' | 'network-loopback' | 'broker';
export type FixedOperationInput = {
 role: FixedDriverRole; executionId: string; operationId: string; boundary: Boundary;
 path?: string; bytes?: string; linkPath?: string; targetPath?: string; endpoint?: string; host?: string; port?: number;proxyEndpoint?:string;proxyProvenanceHash?:string;
};
/** IO adapters report the observed operation, never a qualification verdict. Only trusted adapters own these seams. */
export type FixedOperationOutcome = {
 role: FixedDriverRole; executionId: string; operationId: string; attempted: boolean;
 effect: 'allowed' | 'blocked' | 'refused' | 'error'; origin: Boundary | 'tool' | 'unknown'; code?: string; data?: string; sensitiveBytesRead?: boolean;
 runtimeProxyMatched?:boolean;proxyError?:string;proxyProvenanceHash?:string;proxyPolicyHash?:string;
};
export type EndpointAvailability = {
 role: 'controller'; executionId: string; endpoint: string; fixtureRoot: string; targetHash: string; actualAttempt: boolean; available: boolean;
 boundaryRole: FixedDriverRole; boundaryExecutionId: string; serviceGeneration: string; observedFromMs: number; availableThroughMs: number;networkPlanHash?:string;
};
export type EndpointAvailabilityInput = { endpoint: string; fixtureRoot: string; targetHash: string; boundaryRole: FixedDriverRole; boundaryExecutionId: string; phase: 'before' | 'after';networkPlanHash?:string };
export type SentinelSnapshotInput = { path: string; fixtureRoot: string; targetHash: string; boundaryRole: FixedDriverRole; boundaryExecutionId: string; probeId: string; phase: 'before' | 'after' };
export type SentinelSnapshot = SentinelSnapshotInput & { role: 'controller'; executionId: string; sha256: string; actualRead: boolean;linkTargetMatched?:boolean };
type Operation = (input: Readonly<FixedOperationInput>) => Promise<FixedOperationOutcome>;
export type FixedDriverIO = {
 filesystem: { read: Operation; write: Operation; linkAndWrite: Operation };
 network: { proxyHttp: Operation; directTcp: Operation; loopback: Operation };
 broker: { writeThroughBroker: Operation };
 /** Controller executes an independent availability check; the campaign must charge this action before invoking the driver. */
 controller?: { now(): number; observeEndpoint?(input: Readonly<EndpointAvailabilityInput>): Promise<EndpointAvailability>;
  observeBroker?(input: Readonly<EndpointAvailabilityInput>): Promise<EndpointAvailability>;
  snapshotSentinel?(input: Readonly<SentinelSnapshotInput>): Promise<SentinelSnapshot> };
};
export type FixedDriverRequest = { role: FixedDriverRole; executionId: string; operation: FixedBoundaryOperation; fixtureRoot: string; targetHash: string;networkPlan?:FixedNetworkPlan };
export type FixedDriverResult = {
 role: FixedDriverRole; executionId: string; probeId: string; status: 'PASS' | 'FAIL' | 'UNTESTED'; actualAttempt: boolean;
 result: 'allowed' | 'blocked' | 'refused' | 'not_attempted' | 'error'; reasonCode: string;
 operations: FixedOperationOutcome[]; availability?: EndpointAvailability; availabilityBefore?: EndpointAvailability; sentinelSnapshots: SentinelSnapshot[];
};
const operations: readonly string[] = ['allowed_edit', 'denied_source_write', 'denied_controller_write', 'denied_sibling_write',
 'denied_sensitive_read', 'allowed_proxy_network', 'denied_network', 'denied_direct_tcp', 'denied_loopback', 'link_escape', 'broker_escape'];
const bytes = 'OUROBOROS_FIXED_WRITE_V1\r\n';
const allowedEndpoint = 'http://localhost:18471/allowed';
const deniedEndpoint = 'http://127.0.0.1:18472/denied';
function validate(request: FixedDriverRequest): void {
 const root = request.fixtureRoot;
 if (!['worker', 'verifier'].includes(request.role) || !operations.includes(request.operation) ||
  typeof request.executionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.executionId) || !/^[a-f0-9]{64}$/.test(request.targetHash) ||
  typeof root !== 'string' || !/^[A-Za-z]:\\[^\\]/.test(root) || root.includes('/') || root.slice(2).includes(':') ||
  root.split('\\').slice(1).some(part => !part || part === '.' || part === '..' || /[. ]$|[<>"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
  throw new Error('Invalid fixed boundary request');
 }
 if(['allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback'].includes(request.operation))validateFixedNetworkPlan(request.networkPlan!);
 else if(request.networkPlan)validateFixedNetworkPlan(request.networkPlan);
}

/** Executes fixed literal canary operations only. It neither launches processes nor opens host/network resources itself. */
export async function runFixedBoundaryDriver(request: FixedDriverRequest, io: FixedDriverIO): Promise<FixedDriverResult> {
 validate(request);
 // Copy caller inputs before any asynchronous seam; subsequent caller mutation cannot retarget an operation.
 const r = Object.freeze(structuredClone(request));
 const probeId = `${r.role}.${r.operation === 'allowed_edit' && r.role === 'verifier' ? 'allowed_command' : r.operation}`;
 const observations: FixedOperationOutcome[] = [];
 const snapshots: SentinelSnapshot[] = [];
 let availability: EndpointAvailability | undefined;
 let availabilityBefore: EndpointAvailability | undefined;
 const result = (status: FixedDriverResult['status'], actualAttempt: boolean, effect: FixedDriverResult['result'], reasonCode: string): FixedDriverResult => ({
  role: r.role, executionId: r.executionId, probeId, status, actualAttempt, result: effect, reasonCode,
  operations: structuredClone(observations), sentinelSnapshots: structuredClone(snapshots), ...(availability ? { availability: structuredClone(availability) } : {}),
  ...(availabilityBefore ? { availabilityBefore: structuredClone(availabilityBefore) } : {}),
 });
 const invoke = async (operation: Operation | undefined, input: FixedOperationInput): Promise<FixedOperationOutcome | undefined> => {
  try {
   if (typeof operation !== 'function') return undefined;
   const observed = await operation(Object.freeze(input));
   if (!observed || observed.role !== input.role || observed.executionId !== input.executionId || observed.operationId !== input.operationId ||
    typeof observed.attempted !== 'boolean' || !['allowed', 'blocked', 'refused', 'error'].includes(observed.effect)) return undefined;
   const copied = structuredClone(observed); observations.push(copied); return copied;
  } catch { return undefined; }
 };
 const base = { role: r.role, executionId: r.executionId, operationId: probeId };
 const endpointProof = async (endpoint: string, phase: 'before' | 'after', broker = false): Promise<EndpointAvailability | undefined> => {
  try {
   const observer = broker ? io.controller?.observeBroker : io.controller?.observeEndpoint;
   const proof = await observer?.(Object.freeze({ endpoint, fixtureRoot: r.fixtureRoot, targetHash: r.targetHash,
    boundaryRole: r.role, boundaryExecutionId: r.executionId, phase,...(!broker?{networkPlanHash:fingerprint(r.networkPlan)}:{}) }));
   if (!proof || proof.role !== 'controller' || !proof.executionId || proof.executionId === r.executionId || proof.endpoint !== endpoint ||
    proof.targetHash !== r.targetHash || proof.fixtureRoot !== r.fixtureRoot || proof.boundaryRole !== r.role || proof.boundaryExecutionId !== r.executionId ||
    proof.actualAttempt !== true || proof.available !== true || typeof proof.serviceGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proof.serviceGeneration) || !Number.isFinite(proof.observedFromMs) || !Number.isFinite(proof.availableThroughMs) ||
    (!broker&&proof.networkPlanHash!==fingerprint(r.networkPlan))||
    proof.observedFromMs < 0 || proof.availableThroughMs < proof.observedFromMs) return undefined;
   return structuredClone(proof);
  } catch { return undefined; }
 };
 let input: FixedOperationInput;
 let operation: Operation | undefined;
 if (['allowed_proxy_network', 'denied_network', 'denied_direct_tcp', 'denied_loopback'].includes(r.operation)) {
  const endpoint = r.operation === 'allowed_proxy_network' ? allowedEndpoint : r.operation==='denied_direct_tcp'?`tcp://${r.networkPlan!.directTcp.host}:${r.networkPlan!.directTcp.port}`:deniedEndpoint;
  availabilityBefore = await endpointProof(endpoint, 'before');
  if (!availabilityBefore) return result('UNTESTED', false, 'not_attempted', 'ENDPOINT_AVAILABILITY_UNPROVEN');
  const proxy = ['allowed_proxy_network', 'denied_network'].includes(r.operation);
  input = { ...base, boundary: proxy ? 'network-proxy' : r.operation === 'denied_direct_tcp' ? 'network-tcp' : 'network-loopback',
   ...(proxy ? { endpoint,proxyEndpoint:r.networkPlan!.proxy.url,proxyProvenanceHash:r.networkPlan!.proxy.provenanceHash } : r.operation==='denied_direct_tcp'?{host:r.networkPlan!.directTcp.host,port:r.networkPlan!.directTcp.port}:{ host: '127.0.0.1', port: 18472 }) };
  operation = proxy ? io.network?.proxyHttp : r.operation === 'denied_direct_tcp' ? io.network?.directTcp : io.network?.loopback;
 } else {
  const root = r.operation === 'denied_source_write' ? 'source' : r.operation === 'denied_controller_write' ? 'controller-sentinel'
   : r.operation === 'denied_sibling_write' ? 'sibling' : r.operation === 'denied_sensitive_read' ? 'fake-credential' : 'workspace';
  const path = win32.join(r.fixtureRoot, root, root === 'workspace' ? 'allowed.txt' : 'sentinel.txt');
  if (r.operation === 'link_escape') {
   input = { ...base, boundary: 'filesystem', linkPath: win32.join(r.fixtureRoot, 'workspace', `escape-link-${r.role}`),
    targetPath: win32.join(r.fixtureRoot, 'source', 'sentinel.txt'), bytes };
   operation = io.filesystem?.linkAndWrite;
  } else if (r.operation === 'broker_escape') {
   input = { ...base, boundary: 'broker', path: win32.join(r.fixtureRoot, 'source', 'sentinel.txt'), bytes };
   operation = io.broker?.writeThroughBroker;
   const endpoint = `\\\\.\\pipe\\ouroboros-boundary-${createHash('sha256').update(`${r.fixtureRoot}\n${r.targetHash}`).digest('hex').slice(0,24)}`;
   availabilityBefore = await endpointProof(endpoint,'before',true);
   if (!availabilityBefore) return result('UNTESTED',false,'not_attempted','BROKER_AVAILABILITY_UNPROVEN');
  } else {
   input = { ...base, boundary: 'filesystem', path, ...(r.operation === 'denied_sensitive_read' ? {} : { bytes }) };
   operation = r.operation === 'denied_sensitive_read' ? io.filesystem?.read : io.filesystem?.write;
  }
 }
 const snapshot = async (phase: 'before' | 'after'): Promise<SentinelSnapshot | undefined> => {
  const path = input.targetPath ?? input.path!;
  try {
   const proof = await io.controller?.snapshotSentinel?.(Object.freeze({ path, fixtureRoot: r.fixtureRoot, targetHash: r.targetHash,
    boundaryRole: r.role, boundaryExecutionId: r.executionId, probeId, phase }));
   if (!proof || proof.role !== 'controller' || !proof.executionId || proof.executionId === r.executionId || proof.path !== path ||
    proof.fixtureRoot !== r.fixtureRoot || proof.targetHash !== r.targetHash || proof.boundaryRole !== r.role || proof.boundaryExecutionId !== r.executionId ||
    proof.probeId !== probeId || proof.phase !== phase || proof.actualRead !== true || !/^[a-f0-9]{64}$/.test(proof.sha256)||r.operation==='link_escape'&&proof.linkTargetMatched!==true) return undefined;
   const copied = structuredClone(proof); snapshots.push(copied); return copied;
  } catch { return undefined; }
 };
 const protectedSentinel = (!availabilityBefore || r.operation === 'broker_escape') && r.operation !== 'allowed_edit';
 const before = protectedSentinel ? await snapshot('before') : undefined;
 if (protectedSentinel && !before) return result('UNTESTED', false, 'not_attempted', 'SENTINEL_BASELINE_UNPROVEN');
 let startedAt: number | undefined;
 if (availabilityBefore) {
  try { startedAt = io.controller?.now(); } catch { /* Missing trusted time cannot qualify a network attempt. */ }
  if (startedAt === undefined || !Number.isFinite(startedAt) || availabilityBefore.observedFromMs > startedAt)
   return result('UNTESTED', false, 'not_attempted', 'ENDPOINT_WINDOW_UNPROVEN');
 }
 const observed = await invoke(operation, input);
 if (availabilityBefore) {
  let completedAt: number | undefined;
  try { completedAt = io.controller?.now(); } catch { /* Retain operation evidence below. */ }
  availability = await endpointProof(availabilityBefore.endpoint, 'after', r.operation === 'broker_escape');
  if (!availability || completedAt === undefined || !Number.isFinite(completedAt) || completedAt < startedAt! ||
   availability.executionId !== availabilityBefore.executionId || availability.serviceGeneration !== availabilityBefore.serviceGeneration ||
   availability.observedFromMs > startedAt! || availability.availableThroughMs < completedAt)
   return result('UNTESTED', observed?.attempted === true, 'error', 'ENDPOINT_WINDOW_UNPROVEN');
 }
 if (protectedSentinel) {
  const after = await snapshot('after');
  if (!after) return result('UNTESTED', observed?.attempted === true, 'error', 'SENTINEL_FINAL_UNPROVEN');
  if (before!.sha256 !== after.sha256) return result('FAIL', observed?.attempted === true, 'error', 'SENTINEL_CHANGED');
 }
 if (!observed) return result('UNTESTED', false, 'error', 'OPERATION_EVIDENCE_UNAVAILABLE');
 if (!observed.attempted) return result('UNTESTED', false, 'not_attempted', 'OPERATION_NOT_ATTEMPTED');
 if (r.operation === 'denied_sensitive_read' && observed.sensitiveBytesRead !== false)
  return result(observed.sensitiveBytesRead === true ? 'FAIL' : 'UNTESTED', true, 'error', 'SENSITIVE_READ_UNPROVEN');
 const allowed = r.operation === 'allowed_edit' || r.operation === 'allowed_proxy_network';
 if (observed.effect === 'allowed') {
  if (!allowed) return result('FAIL', true, 'allowed', 'FORBIDDEN_OPERATION_SUCCEEDED');
  if (r.operation === 'allowed_edit') {
   const readback = await invoke(io.filesystem?.read, { ...base, operationId: `${probeId}.readback`, boundary: 'filesystem', path: input.path });
   if (!readback || !readback.attempted || readback.effect !== 'allowed') return result('UNTESTED', true, 'error', 'READBACK_UNPROVEN');
   if (readback.data !== bytes) return result('FAIL', true, 'error', 'READBACK_MISMATCH');
  } else if (observed.data !== 'OUROBOROS_ENDPOINT_V1'||observed.runtimeProxyMatched!==true||observed.proxyProvenanceHash!==r.networkPlan!.proxy.provenanceHash||observed.proxyPolicyHash!==r.networkPlan!.proxy.policyHash) return result('UNTESTED', true, 'error', 'ENDPOINT_RESPONSE_UNPROVEN');
  return result('PASS', true, 'allowed', 'FIXED_OPERATION_ALLOWED');
 }
 if(r.operation==='denied_network'){
  const domain=observed.effect==='blocked'&&observed.origin==='network-proxy'&&observed.code==='HTTP_PROXY_DENIED'&&['blocked-by-allowlist','blocked-by-denylist'].includes(observed.proxyError??'')&&observed.runtimeProxyMatched===true&&observed.proxyProvenanceHash===r.networkPlan!.proxy.provenanceHash&&observed.proxyPolicyHash===r.networkPlan!.proxy.policyHash;
  return result(domain?'PASS':'UNTESTED',true,domain?'blocked':'error',domain?'ATTRIBUTABLE_DOMAIN_ENFORCEMENT':'DOMAIN_ENFORCEMENT_UNPROVEN');
 }
 if (observed.effect === 'blocked' && observed.origin === input.boundary && ['EACCES', 'EPERM'].includes(observed.code ?? ''))
  return result(allowed ? 'FAIL' : 'PASS', true, 'blocked', 'ATTRIBUTABLE_ENFORCEMENT');
 return result('UNTESTED', true, observed.effect === 'refused' ? 'refused' : 'error', 'ENFORCEMENT_UNPROVEN');
}
