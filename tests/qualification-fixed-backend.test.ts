import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const driver = await import('./fixtures/boundary/campaign-boundary-driver.mjs').catch(() => ({} as any));
const endpoints = await import('./fixtures/boundary/controlled-endpoint.mjs').catch(() => ({} as any));
const backend = await import('../src/qualification/fixed-driver-backend.ts').catch(() => ({} as any));
const networkPlan={schemaVersion:1,proxy:{url:'http://localhost:38211',source:'documented-sandbox-managed',policyHash:'d'.repeat(64),provenanceHash:'c'.repeat(64)},directTcp:{host:'192.0.2.1',port:18472}};
const request = { role: 'worker', executionId: 'worker-1', operationId: 'worker.denied_source_write', operation: 'denied_source_write', fixtureRoot: 'D:\\disposable\\boundary', targetHash: 'a'.repeat(64),networkPlan };
function primitives(error?: string) {
 const files = new Map<string, string>(); const attempts: unknown[] = [];
 const touch = async (path: string, bytes?: string) => { attempts.push({ path, bytes }); if (error) throw Object.assign(Error('primitive failure'), { code: error }); if (bytes !== undefined) files.set(path, bytes); return files.get(path) ?? ''; };
 const socket = (options: unknown) => {
  attempts.push(options); const stream = new EventEmitter() as any;
  stream.destroy = () => {}; stream.end = (bytes: unknown) => { attempts.push(bytes); queueMicrotask(() => { stream.emit('data', Buffer.from('{"kind":"broker-result","mutated":true}\n')); stream.emit('end'); }); };
  stream.write=stream.end;
  queueMicrotask(() => error ? stream.emit('error', Object.assign(Error('connect failed'), { code: error })) : stream.emit('connect'));
  return stream;
 };
 const http = (options: unknown, second: any, third?: (r:any)=>void) => {
  const callback=typeof second==='function'?second:third!;
  attempts.push(options); const req = new EventEmitter() as any; req.destroy = () => {};
  req.end = () => queueMicrotask(() => {
   if (error) { req.emit('error', Object.assign(Error('http failed'), { code: error })); return; }
   const response = new EventEmitter() as any; response.statusCode = 200; callback(response);
   queueMicrotask(() => { response.emit('data', Buffer.from('OUROBOROS_ENDPOINT_V1')); response.emit('end'); });
  }); return req;
 };
 return { attempts, files, io: { proxyEnvironment:networkPlan.proxy.url,fs: { writeFile: touch, readFile: touch, symlink: async (target: string, link: string) => { attempts.push({ target, link }); if (error) throw Object.assign(Error('link unavailable'), { code: error }); } },
  net: { connect: socket }, http: { request: http }, setTimeout, clearTimeout } };
}
function pinnedManifest(){const source=Buffer.from('pinned fixture'),sha=createHash('sha256').update(source).digest('hex');return {source,manifest:backend.createFixedDriverManifestV2({fixtureRoot:request.fixtureRoot,targetHash:request.targetHash,node:{path:'D:\\trusted\\node.exe',sha256:sha},driver:{path:'D:\\trusted\\campaign-boundary-driver.mjs',sha256:sha},endpoint:{path:'D:\\trusted\\controlled-endpoint.mjs',sha256:sha},wrapperHash:'b'.repeat(64),networkPlan})};}
it('exports effect-free executable and endpoint factories plus owned backend', () => {
 expect(typeof driver.runCampaignBoundaryOperation).toBe('function'); expect(typeof endpoints.startControlledEndpoints).toBe('function'); expect(typeof backend.createFixedDriverBackend).toBe('function');
});
it('attempts the precreated junction write without creating a link inside the sandbox',async()=>{
 const p=primitives();p.io.fs.symlink=async()=>{throw Error('sandbox must not create links');};
 const result=await driver.runCampaignBoundaryOperation({...request,operation:'link_escape',operationId:'worker.link_escape'},p.io);
 expect(result).toMatchObject({attempted:true,effect:'allowed',origin:'filesystem'});expect(p.attempts).toEqual([{path:'D:\\disposable\\boundary\\workspace\\escape-link-worker\\sentinel.txt',bytes:driver.FIXED_WRITE}]);
});
it.each(['valid','missing-inspector','retargeted'] as const)('requires %s controller junction identity for traversal snapshots',async(kind)=>{
 const {manifest}=pinnedManifest();let reads=0;
 const io=backend.createFixedControllerIO({manifest,controllerExecutionId:'controller-snapshot',readFile:async()=>{reads++;return Buffer.from('sentinel');},...(kind==='missing-inspector'?{}:{realpath:async()=>kind==='retargeted'?'D:\\another-source':manifest.fixtureRoot+'\\source'}),service:()=>{throw Error('not a network operation');},now:()=>1,effectGate:()=>{}});
 const input={path:manifest.fixtureRoot+'\\source\\sentinel.txt',fixtureRoot:manifest.fixtureRoot,targetHash:manifest.targetHash,boundaryRole:'worker',boundaryExecutionId:'worker-root',probeId:'worker.link_escape',phase:'before'};
 if(kind==='valid'){expect(await io.snapshotSentinel(input)).toMatchObject({actualRead:true,linkTargetMatched:true});expect(reads).toBe(1);}else{await expect(io.snapshotSentinel(input)).rejects.toThrow('junction identity');expect(reads).toBe(0);}
});
it('constructs a direct pinned Node endpoint without treating node.exe as a script',()=>{
 const {manifest}=pinnedManifest(),owner={runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'33333333-3333-4333-8333-333333333333',role:'controller'};
 const options:any={manifest,launch:{...owner,executable:manifest.node.path,argvPrefix:[],cwd:manifest.fixtureRoot,env:{},boundaryHash:'b'.repeat(64),authorization:{kind:'qualification',requestId:owner.runId,probeId:'auxiliary.endpoint',fixtureRoots:[manifest.fixtureRoot]},leaseTtlMs:10000,deadline:123456},readResource:async()=>{throw Error('must not read');},supervisorFor:()=>{throw Error('must not launch');}};
 expect(backend.createControlledEndpointBackend(options).argv.slice(0,2)).toEqual(['--preserve-symlinks-main',manifest.endpoint.path]);
 options.launch.argvPrefix=['unapproved-wrapper'];expect(()=>backend.createControlledEndpointBackend(options)).toThrow('empty wrapper prefix');
});
it('keeps the actual executable neutral until its exact execute line',async()=>{
 const p=primitives('EACCES'),stdin=new EventEmitter(),records:string[]=[];
 const completion=driver.main(['verifier','execution-1','verifier.denied_source_write','denied_source_write',request.fixtureRoot,request.targetHash,'--channel','a'.repeat(64)],p.io,(line:string)=>records.push(line),stdin);
 await Promise.resolve();expect(p.attempts).toHaveLength(0);expect(JSON.parse(records[0])).toMatchObject({kind:'fixed-resource-ready',executionId:'execution-1'});
 stdin.emit('data',Buffer.from('execute\n'));await completion;expect(p.attempts).toHaveLength(1);expect(JSON.parse(records[1]).effect).toBe('blocked');
});
it('rejects arbitrary executable channel commands without attempting primitives',async()=>{
 const p=primitives(),stdin=new EventEmitter();
 const completion=driver.main(['verifier','execution-1','verifier.denied_source_write','denied_source_write',request.fixtureRoot,request.targetHash,'--channel','a'.repeat(64)],p.io,()=>{},stdin);
 stdin.emit('data',Buffer.from('write D:\\host\n'));await expect(completion).rejects.toThrow();expect(p.attempts).toHaveLength(0);
});
it('attempts the fixed write using filesystem primitives and attributes OS EACCES', async () => {
 const p = primitives('EACCES'); const result = await driver.runCampaignBoundaryOperation(request, p.io);
 expect(p.attempts).toEqual([{ path: 'D:\\disposable\\boundary\\source\\sentinel.txt', bytes: 'OUROBOROS_FIXED_WRITE_V1\r\n' }]);
 expect(result).toMatchObject({ attempted: true, effect: 'blocked', code: 'EACCES', origin: 'filesystem' });
});
it('attempts link traversal independently for verifier then worker in the same disposable fixture',async()=>{
 const p=primitives(),links=new Set<string>(),writes:string[]=[];
 p.io.fs.symlink=async(_target:string,link:string)=>{if(links.has(link))throw Object.assign(Error('already exists'),{code:'EEXIST'});links.add(link);};
 p.io.fs.writeFile=async(path:string)=>{writes.push(path);throw Object.assign(Error('denied'),{code:'EACCES'});};
 for(const role of ['verifier','worker'])expect(await driver.runCampaignBoundaryOperation({...request,role,executionId:role+'-1',operation:'link_escape',operationId:role+'.link_escape'},p.io)).toMatchObject({attempted:true,effect:'blocked',origin:'filesystem'});
 expect(writes).toHaveLength(2);expect(new Set(writes).size).toBe(2);
});
it('reports successful sensitive read without disclosing sentinel bytes', async () => {
 const p = primitives(); p.files.set('D:\\disposable\\boundary\\fake-credential\\sentinel.txt', 'FAKE_PRIVATE_MARKER');
 const result = await driver.runCampaignBoundaryOperation({ ...request, operation: 'denied_sensitive_read', operationId: 'worker.denied_sensitive_read' }, p.io);
 expect(result.sensitiveBytesRead).toBe(true); expect(JSON.stringify(result)).not.toContain('FAKE_PRIVATE_MARKER');
});
it('attributes permission denial to the attempted precreated junction target write', async () => {
 const p = primitives('EPERM'); const result = await driver.runCampaignBoundaryOperation({ ...request, operation: 'link_escape', operationId: 'worker.link_escape' }, p.io);
 expect(result).toMatchObject({ effect: 'blocked', origin: 'filesystem', code: 'EPERM' }); expect(p.attempts).toEqual([{path:'D:\\disposable\\boundary\\workspace\\escape-link-worker\\sentinel.txt',bytes:driver.FIXED_WRITE}]);
});
it.each(['allowed_proxy_network', 'denied_network', 'denied_direct_tcp', 'denied_loopback'] as const)('attempts fixed %s with raw network primitives', async operation => {
 const p = primitives('EACCES'); const result = await driver.runCampaignBoundaryOperation({ ...request, operation, operationId: `worker.${operation}` }, p.io);
 expect(result).toMatchObject({ attempted: true, effect: 'blocked', code: 'EACCES' }); expect(p.attempts).toHaveLength(1);
 const literal = operation === 'allowed_proxy_network' ? 'http://localhost:18471/allowed' : 'http://127.0.0.1:18472/denied';
 if (operation.includes('network')) expect(p.attempts[0]).toMatchObject({ hostname: 'localhost', port: 38211, path: literal, method: 'GET' });
 else expect(p.attempts[0]).toEqual({ host: operation==='denied_direct_tcp'?'192.0.2.1':'127.0.0.1', port: 18472 });
});
it.each(['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT'])('never claims missing broker %s as enforcement', async error => {
 const p = primitives(error); const result = await driver.runCampaignBoundaryOperation({ ...request, operation: 'broker_escape', operationId: 'worker.broker_escape' }, p.io);
 expect(result).toMatchObject({ attempted: true, effect: 'error', code: error, origin: 'broker' });
});
it('attempts one derived disposable pipe and sends only the fixed broker request', async () => {
 const p = primitives(); const result = await driver.runCampaignBoundaryOperation({ ...request, operation: 'broker_escape', operationId: 'worker.broker_escape' }, p.io);
 expect(result.effect).toBe('allowed'); expect(p.attempts[0]).toMatchObject({ path: expect.stringMatching(/^\\\\\.\\pipe\\ouroboros-boundary-[a-f0-9]{24}$/) });
 expect(JSON.parse(p.attempts[1] as string)).toEqual({ schemaVersion: 1, operation: 'write_source_sentinel' });
});
it('rejects arbitrary paths and mismatched probe identities before any primitive', async () => {
 const p = primitives(); await expect(driver.runCampaignBoundaryOperation({ ...request, fixtureRoot: 'D:\\fixture\\..\\host' }, p.io)).rejects.toThrow();
 await expect(driver.runCampaignBoundaryOperation({ ...request, operationId: 'verifier.denied_source_write' }, p.io)).rejects.toThrow(); expect(p.attempts).toHaveLength(0);
});
it('serves controlled fixed endpoints and exposes pending broker inventory without child dispatch', async () => {
 const servers: any[] = []; const events: any[] = []; const p = primitives();
 const create = (listener: Function) => { const server = new EventEmitter() as any; server.listener = listener; server.listen = (_options: unknown, ready: Function) => { server.addressValue = _options; queueMicrotask(() => ready()); }; server.close = (done: Function) => done(); servers.push(server); return server; };
 const service = await endpoints.startControlledEndpoints({ fixtureRoot: request.fixtureRoot, targetHash: request.targetHash, executionId: 'controller-service',networkPlan },
  { fs: p.io.fs, http: { createServer: create }, net: { createServer: create }, emit: (value: unknown) => events.push(value) });
 expect(events.filter(e => e.kind === 'ready')).toHaveLength(4); expect(service.inventory()).toMatchObject({ children: [], pending: [], stopped: false });
 const response = { writeHead: () => {}, end: (body: string) => { expect(body).toBe('OUROBOROS_ENDPOINT_V1'); } };
 servers[0].listener({ url: '/allowed', method: 'GET' }, response);
 const stream = new EventEmitter() as any; stream.end = () => {}; stream.destroy = () => {};
 servers[3].listener(stream); stream.emit('data', Buffer.from('{"schemaVersion":1,"operation":"write_source_sentinel"}\n'));
 await Promise.resolve(); await Promise.resolve();
 expect(p.files.get('D:\\disposable\\boundary\\source\\sentinel.txt')).toBe('OUROBOROS_FIXED_WRITE_V1\r\n');
 await service.stop(); expect(service.inventory()).toMatchObject({ children: [], pending: [], stopped: true });
});
it('observes live endpoint and named-pipe availability through independent controller primitives',async()=>{
 const p=primitives(),events:any[]=[];const create=()=>{const server=new EventEmitter()as any;server.listen=(_o:unknown,ready:Function)=>ready();server.close=(done:Function)=>done();return server;};
 const service=await endpoints.startControlledEndpoints({fixtureRoot:request.fixtureRoot,targetHash:request.targetHash,executionId:'controller-service',networkPlan},
  {...p.io,http:{...p.io.http,createServer:create},net:{...p.io.net,createServer:create},now:()=>25,emit:(value:unknown)=>events.push(value)});
 expect(await service.observe('allowed')).toMatchObject({available:true,actualAttempt:true,endpoint:'http://localhost:18471/allowed',observedFromMs:25,availableThroughMs:25});
 expect(await service.observe('broker')).toMatchObject({available:true,actualAttempt:true});expect(p.files.size).toBe(0);
 await service.stop();
});
it('retains an unresolved broker write in stop inventory until the primitive settles',async()=>{
 const servers:any[]=[];let release:()=>void=()=>{};const p=primitives();
 const create=(listener:Function)=>{const server=new EventEmitter()as any;server.listener=listener;server.listen=(_o:unknown,ready:Function)=>ready();server.close=(done:Function)=>done();servers.push(server);return server;};
 const service=await endpoints.startControlledEndpoints({fixtureRoot:request.fixtureRoot,targetHash:request.targetHash,executionId:'controller-service',networkPlan},
  {fs:{...p.io.fs,writeFile:()=>new Promise<void>(resolve=>{release=resolve;})},http:{createServer:create},net:{createServer:create},setTimeout:(callback:Function)=>{queueMicrotask(()=>callback());return 0;},clearTimeout:()=>{},emit:()=>{}});
 const socket=new EventEmitter()as any;socket.end=()=>{};socket.destroy=()=>socket.emit('close');servers[3].listener(socket);
 socket.emit('data',Buffer.from('{"schemaVersion":1,"operation":"write_source_sentinel"}\n'));await Promise.resolve();
 const stopped=await service.stop();expect(stopped.pending).toEqual(['broker-1']);expect(stopped.failed).toBe(true);release();await Promise.resolve();
});
it('creates a distinct controlled direct TCP listener and never substitutes a homemade proxy',async()=>{
 const p=primitives();const servers:any[]=[];const create=(listener:Function)=>{const server=new EventEmitter()as any;server.listener=listener;server.listen=(options:unknown,ready:Function)=>{server.addressValue=options;ready();};server.close=(done:Function)=>done();servers.push(server);return server;};
 const service=await endpoints.startControlledEndpoints({fixtureRoot:request.fixtureRoot,targetHash:request.targetHash,executionId:'controller-service',networkPlan},
  {...p.io,http:{...p.io.http,createServer:create},net:{...p.io.net,createServer:create},emit:()=>{}});
 expect(servers[2].addressValue).toEqual({host:'192.0.2.1',port:18472});expect(servers.some(s=>s.addressValue?.port===18470)).toBe(false);await service.stop();
});
it('refuses network attempts without approved managed proxy provenance or distinct nonloopback target',async()=>{
 const p=primitives();await expect(driver.runCampaignBoundaryOperation({...request,operation:'denied_network',operationId:'worker.denied_network',networkPlan:undefined},p.io)).rejects.toThrow();
 await expect(driver.runCampaignBoundaryOperation({...request,operation:'denied_direct_tcp',operationId:'worker.denied_direct_tcp',networkPlan:{...networkPlan,directTcp:{host:'127.0.0.1',port:18472}}},p.io)).rejects.toThrow();expect(p.attempts).toHaveLength(0);
});
it('refuses changed runtime HTTP_PROXY without probing or discovering replacement endpoints',async()=>{
 const p=primitives();p.io.proxyEnvironment='http://localhost:38212';const result=await driver.runCampaignBoundaryOperation({...request,operation:'denied_network',operationId:'worker.denied_network'},p.io);
 expect(result).toMatchObject({attempted:false,effect:'refused',code:'RUNTIME_PROXY_MISMATCH'});expect(p.attempts).toHaveLength(0);
});
it.each(['blocked-by-allowlist','blocked-by-denylist','blocked-by-method-policy','blocked-by-policy',undefined])('attributes only documented runtime proxy denial %s',async proxyError=>{
 const p=primitives();p.io.http.request=(_options:unknown,callback:Function)=>{const req=new EventEmitter()as any;req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const response=new EventEmitter()as any;response.statusCode=403;response.headers=proxyError?{'x-proxy-error':proxyError}:{};callback(response);queueMicrotask(()=>response.emit('end'));});return req;};
 const result=await driver.runCampaignBoundaryOperation({...request,operation:'denied_network',operationId:'worker.denied_network'},p.io);
 expect(result.effect).toBe(proxyError?'blocked':'error');if(proxyError)expect(result).toMatchObject({code:'HTTP_PROXY_DENIED',proxyError,runtimeProxyMatched:true,proxyProvenanceHash:networkPlan.proxy.provenanceHash});
});
it('binds the full worker and verifier catalog to the versioned network plan and pinned resources',()=>{
 const {manifest}=pinnedManifest();expect(manifest.commands).toHaveLength(22);expect(new Set(manifest.commands.map((c:any)=>c.probeId)).size).toBe(22);
 expect(manifest.proxy.url).toBe('http://localhost:38211');expect(manifest.endpoints).toContain('tcp://192.0.2.1:18472');expect(manifest.unsupportedBrokerSurfaces).toEqual(['privileged-host-brokers']);
 const owner={runId:'11111111-1111-4111-8111-111111111111',actionId:'22222222-2222-4222-8222-222222222222',generation:1,role:'worker'};
 const launch={...owner,executable:'D:\\trusted\\codex.exe',argvPrefix:['sandbox','--'],cwd:request.fixtureRoot+'\\workspace',env:{},boundaryHash:'b'.repeat(64),authorization:{kind:'qualification',requestId:owner.runId,probeId:request.operationId,fixtureRoots:[request.fixtureRoot]},leaseTtlMs:10000,deadline:Date.now()+10000};
 expect(JSON.parse(backend.buildFixedDriverLaunch(manifest,request,launch).argv.at(-1))).toEqual(networkPlan);
 const changed=structuredClone(manifest);changed.networkPlan.directTcp.host='192.0.2.2';expect(()=>backend.buildFixedDriverLaunch(changed,request,launch)).toThrow();
});
it.each(['codex-commandExecution','agent-text','missing-actual-gate'])('requires actual worker command provenance and immediate effect gate: %s',async provenance=>{
 const {source,manifest}=pinnedManifest(),p=primitives('EACCES');const commands:any[]=[];const gates:string[]=[];
 const io=backend.createFixedDriverBackend({manifest,request,readResource:async()=>source,effectGate:(phase:string)=>gates.push(phase),workerChannel:{executeFixedCommand:async(command:any)=>{commands.push(command);if(provenance!=='missing-actual-gate')command.beforeExecute();return {exitCode:0,stdout:JSON.stringify({kind:'boundary-operation',schemaVersion:1,...await driver.runCampaignBoundaryOperation(request,p.io)})+'\n',stderr:'',attempted:true,threadId:'thread',turnId:'turn',itemId:'command-item',provenance};}}});
 const result=await io.filesystem.write({role:'worker',executionId:request.executionId,operationId:request.operationId,boundary:'filesystem'});
 expect(result.effect).toBe(provenance==='codex-commandExecution'?'blocked':'error');expect(commands).toHaveLength(1);expect(commands[0].executable).toBe('D:\\trusted\\node.exe');expect(JSON.parse(commands[0].argv.at(-1))).toEqual(networkPlan);expect(gates[0]).toBe('TURN');
});
it('launches one neutral verifier resource and attempts only after literal channel execute', async () => {
 vi.useFakeTimers();try{
 const launches: any[] = []; const p = primitives('EACCES');
 const owner = { runId: '11111111-1111-4111-8111-111111111111', generation: 1, actionId: '22222222-2222-4222-8222-222222222222', role: 'verifier' };
 const r = { ...request, role: 'verifier', executionId: owner.actionId, operationId: 'verifier.denied_source_write' };
 const source=Buffer.from('pinned fixture'); const sha=createHash('sha256').update(source).digest('hex');
 const manifest=backend.createFixedDriverManifestV2({fixtureRoot:request.fixtureRoot,targetHash:request.targetHash,node:{path:'D:\\trusted\\node.exe',sha256:sha},driver:{path:'D:\\trusted\\campaign-boundary-driver.mjs',sha256:sha},endpoint:{path:'D:\\trusted\\controlled-endpoint.mjs',sha256:sha},wrapperHash:'b'.repeat(64),networkPlan});
 const identity = { ...owner, schemaVersion: 1, environment: 'windows', pid: 10, creationIdentity: 'root', helperPid: 11, helperCreationIdentity: 'helper', jobIdentity: 'job', boundaryHash: 'b'.repeat(64), assignedBeforeResume: true, capturedAt: 1 };
 let listener: Function; const capture: Uint8Array[]=[];
 const leaseSequences:number[]=[];
 const execution = { describe: async () => identity, fence: async () => {}, renewLease: async (sequence:number) => {leaseSequences.push(sequence);},
  drain: async () => ({ ...owner, rootExited: true, membershipEmpty: true, outputComplete: true }),
  onOutput: (callback: Function) => { listener=callback;queueMicrotask(()=>callback({stream:'stdout',data:Buffer.from(JSON.stringify({kind:'fixed-resource-ready',schemaVersion:1,executionId:owner.actionId,resourceHash:sha})+'\n')}));return()=>{}; },
  writeInput: async(bytes:Uint8Array) => {expect(Buffer.from(bytes).toString()).toBe('execute\n'); const outcome=await driver.runCampaignBoundaryOperation(r,p.io);listener({stream:'stdout',data:Buffer.from(JSON.stringify({kind:'boundary-operation',schemaVersion:1,...outcome})+'\n')});return {ok:true};},endInput:async()=>({ok:true}) };
 const adapters = backend.createFixedVerifierBackend({ supervisorFor:()=>({ launchOwned: async (spec: unknown) => { launches.push(spec); return { ok: true, value: execution }; } }),
  manifest,readResource:async()=>source,request:r,
  launch: { ...owner, executable: 'D:\\trusted\\codex.exe', argvPrefix: ['sandbox', '--'], cwd: 'D:\\disposable\\boundary\\workspace', env: {}, boundaryHash: 'b'.repeat(64), authorization: { kind: 'qualification', requestId: owner.runId, probeId: 'verifier.denied_source_write', fixtureRoots: [request.fixtureRoot] }, leaseTtlMs: 10000, deadline: Date.now() + 10000 },
 });
 const gates:string[]=[];const gate=(phase:string)=>{gates.push(phase);};
 const sink={write:(bytes:Uint8Array)=>{capture.push(bytes);},processCompleted:()=>{}};const process=adapters.process(sink,gate);
 const owned=await process.launch({intent:{owner},argv:adapters.argv,strictNegative:false});expect(p.attempts).toHaveLength(0);
 expect((await process.initialize()).kind).toBe('fixed-resource-ready');expect(p.attempts).toHaveLength(0);
 await vi.advanceTimersByTimeAsync(2000);expect(leaseSequences).toEqual([1]);
 const io=adapters.io(sink,owned,gate);
 const outcome = await io.filesystem.write({ role: 'verifier', executionId: owner.actionId, operationId: 'verifier.denied_source_write', boundary: 'filesystem', path: 'D:\\disposable\\boundary\\source\\sentinel.txt', bytes: 'OUROBOROS_FIXED_WRITE_V1\r\n' });
 expect(outcome).toMatchObject({ attempted: true, effect: 'blocked', code: 'EACCES' });
 expect(launches[0].argv.slice(0, 4)).toEqual(['sandbox', '--', 'D:\\trusted\\node.exe', '--preserve-symlinks-main']);
 expect(launches[0].stdin).toBe('pipe');expect(launches).toHaveLength(1);expect(capture).toHaveLength(2);
 expect(gates).toEqual(['BOOTSTRAP','VERIFIER','VERIFIER']);
 await process.fence();expect((await process.drain()).drain.outputComplete).toBe(true);
 await vi.advanceTimersByTimeAsync(2000);expect(leaseSequences).toEqual([1]);
 }finally{vi.useRealTimers();}
});

it('exposes an immutable parsed endpoint launch with the exact original deadline used at native dispatch',async()=>{
 const {source,manifest}=pinnedManifest();const owner={runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'33333333-3333-4333-8333-333333333333',role:'controller'};
 const launch={...owner,executable:'D:\\trusted\\codex.exe',argvPrefix:['sandbox','--'],cwd:request.fixtureRoot+'\\workspace',env:{},boundaryHash:'b'.repeat(64),authorization:{kind:'qualification',requestId:owner.runId,probeId:'auxiliary.endpoint',fixtureRoots:[request.fixtureRoot]},leaseTtlMs:10000,deadline:123456};
 const order:string[]=[],actual:any[]=[];const adapter=backend.createControlledEndpointBackend({manifest,launch,readResource:async()=>{order.push('pin');return source;},supervisorFor:()=>({launchOwned:async(spec:any)=>{order.push('native');actual.push(structuredClone(spec));return {ok:false,error:{code:'TEST_REFUSAL',message:'injected refusal',evidenceIds:[]}};}})});
 expect(adapter.launch).toBeDefined();expect(adapter.launch.stdin).toBe('pipe');expect(adapter.launch.deadline).toBe(123456);expect(Object.isFrozen(adapter.launch)).toBe(true);expect(Object.isFrozen(adapter.launch.argv)).toBe(true);
 launch.deadline=999999;launch.argvPrefix.push('changed');manifest.endpoint.path='D:\\unapproved.mjs';
 expect(()=>{adapter.launch.deadline=888888;}).toThrow();expect(()=>adapter.launch.argv.push('changed')).toThrow();
 await expect(adapter.start({write:()=>{},processCompleted:()=>{}},()=>order.push('gate'))).rejects.toThrow('Endpoint launch refused');
 expect(actual).toEqual([adapter.launch]);expect(actual[0].deadline).toBe(123456);expect(order.slice(-2)).toEqual(['gate','native']);expect(order.filter(v=>v==='pin')).toHaveLength(3);
});
it('refuses endpoint resource tampering after declaration before gate or native creation',async()=>{
 const {source,manifest}=pinnedManifest();let gates=0,launches=0;const adapter=backend.createControlledEndpointBackend({manifest,launch:{runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'33333333-3333-4333-8333-333333333333',role:'controller',executable:'D:\\trusted\\codex.exe',argvPrefix:['sandbox','--'],cwd:request.fixtureRoot,env:{},boundaryHash:'b'.repeat(64),authorization:{kind:'qualification',requestId:'11111111-1111-4111-8111-111111111111',probeId:'auxiliary.endpoint',fixtureRoots:[request.fixtureRoot]},leaseTtlMs:10000,deadline:123456},readResource:async()=>Buffer.concat([source,Buffer.from('tampered')]),supervisorFor:()=>({launchOwned:async()=>{launches++;throw Error('must not launch');}})});
 expect(adapter.launch?.deadline).toBe(123456);await expect(adapter.start({write:()=>{},processCompleted:()=>{}},()=>{gates++;})).rejects.toThrow();expect(gates).toBe(0);expect(launches).toBe(0);
});
