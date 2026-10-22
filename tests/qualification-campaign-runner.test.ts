import {loadCampaignTerminal} from '../src/qualification/campaign-terminal.ts';
import {fixtureCodexControls} from './helpers/codex-controls.ts';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openStore, type RunStore } from '../src/store/database.ts';
import {publishArtifact} from '../src/store/artifacts.ts';
import { QualificationCampaign, type BatchApproval, type CampaignAction } from '../src/qualification/campaign.ts';
import { targetFingerprint, type QualificationTarget } from '../src/qualification/ledger.ts';
import { fingerprint } from '../src/qualification/probes.ts';
import { approval, startupContext } from './helpers/codex-admission.ts';
import type { SessionRequest } from '../src/qualification/session-drivers.ts';
import {startupTargetHash,type StartupIntent } from '../src/qualification/codex-startup-authority.ts';
import { createSessionBackend } from '../src/qualification/session-driver-backend.ts';
import { dispatchCampaignBatch } from '../src/qualification/campaign-dispatch.ts';
import { createManagedPolicyConflictProjection } from '../src/qualification/startup-evidence.ts';

const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const h = 'a'.repeat(64);
const unwrap = (r: any): any => { if (!r.ok) throw Error(r.error.code); return r.value; };
function observedPolicy(s:any){
 const projection=createManagedPolicyConflictProjection({intentHash:fingerprint(s.request.intent),rawConfig:{config:{model_provider:'openai',default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{apps:false,hooks:false,plugins:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:false,remote_control:false},mcp_servers:{},web_search:'disabled',...fixtureCodexControls(),private_field:'PRIVATE_UNTRUSTED_SECRET'}},rawRequirements:{requirements:null}});
 const initialize=s.seam.initialize;s.seam.initialize=async()=>({...await initialize(),managedConflict:projection,policy:{configurationHash:fingerprint(projection.configuration),requirementsHash:fingerprint(projection.requirements),permissionsHash:projection.configuration.selectedPermissionsHash,environmentHash:s.request.intent.environmentHash,shellEnvironmentPolicyHash:projection.configuration.shellEnvironmentPolicyHash,account:'chatgpt',provider:'openai',observedAt:1006}});
 return projection;
}
async function fixture() {
 const modules = import.meta.glob('../src/qualification/campaign-runner.ts');
 expect(Object.keys(modules)).toHaveLength(1);
 const api = await modules['../src/qualification/campaign-runner.ts']() as any;
 const store = openStore(mkdtempSync(join(tmpdir(), 'ouroboros-composition-'))); stores.push(store);
 const runId = randomUUID(), repoId = randomUUID();
 unwrap(store.createRun(repoId, { schemaVersion: 1, id: runId, taskId: randomUUID(), phase: 'CREATED', blocker: null, generation: 0, baselineRef: null, candidateRef: null, sessionRef: null, repairCount: 0, cumulativeBudgets: { activeMs: 0, outputBytes: 0, tokens: null, requests: null, money: null }, pendingActionIds: [] }));
 const owner = unwrap(store.claim(repoId, runId)); let now = 1001; let allowed = true;
 const target: QualificationTarget = { schemaVersion: 1, provider: 'codex', environment: 'windows', runtime: { path: 'C:\\pinned\\codex.exe', version: '0.162.1', sha256: h }, adapter: { version: '1', sha256: startupContext.adapterHash }, helper: { path: startupContext.helper.path, version: '1', sha256: startupContext.helper.sha256 }, verifier: { path: 'C:\\pinned\\codex.exe', version: '0.162.1', sha256: h, wrapperHash: startupContext.verifierHash }, os: { platform: 'win32', architecture: 'x64', release: 'fixture', sha256: startupContext.osCapabilitiesHash }, policyHash: '9'.repeat(64), startupConfigHash: startupContext.configHash, model: 'fixture-model', effort: 'high' };
 const campaign = new QualificationCampaign(store, { now: () => now, authorizeCurrent: () => allowed });const campaignId=randomUUID();
 const identity = { schemaVersion: 2 as const, id:campaignId, owner, target, targetHash: targetFingerprint(target), controllerHash: startupContext.controllerHash, protocolHash: startupContext.protocolHash, driverHash: h,lineage:unwrap(campaign.lineage(campaignId)) };
 unwrap(campaign.create(identity));
 const batch: BatchApproval = { schemaVersion: 2, id: randomUUID(), campaignId: identity.id, owner, targetHash: identity.targetHash, fixtureHash: h, endpointHash: h, approvedAt: 1000, expiresAt: 30000, remaining: unwrap(campaign.snapshot(identity.id)).remaining, actions: [] };
 const calls: string[] = [];
 function session(probeId = 'worker.subscription_request', kind: CampaignAction['kind'] = 'probe', role: 'worker'|'verifier'|'startup-metadata' = 'worker') {
  const actionId = randomUUID(), cleanupId = randomUUID(), argv = ['app-server', '--strict-config', '--stdio'];
  const intent: StartupIntent = { schemaVersion: 2, phase: 'PRE_PROCESS', ...startupContext, runtime: target.runtime as StartupIntent['runtime'], environmentHash: h, boundaryHash: h, argumentsHash: createHash('sha256').update(JSON.stringify(argv)).digest('hex'), profile: role === 'verifier' ? 'verifier' : 'worker', sandbox: 'mxc', environmentKeys: ['SystemRoot'], issuedAt: 1000, expiresAt: 4000, owner: { runId, generation: owner.generation, actionId, role }, requestId: batch.id, workspace: 'C:\\fixture', configAncestry: ['C:\\', 'C:\\fixture'], authMode: 'managed-chatgpt', action: role === 'verifier' ? 'verifier' : role === 'startup-metadata' ? 'metadata' : 'worker-start', dispatchAuthorization: { kind: 'qualification', requestId: batch.id, probeId: kind === 'probe' ? probeId : `auxiliary.${kind}`, fixtureRoots: ['C:\\fixture'] }, dispatchHash: h, model: target.model, effort: target.effort };
  intent.budget = { activeMs: 2000, outputBytes: 50000, cleanupMs: 1000 };
  const request: SessionRequest = { intent, argv, admissions: {}, protectedInputs: { sentinel: h }, unrelated: { pid: 99, creationIdentity: 'unrelated', name: 'codex.exe' } };
  const recipe: any = { kind: kind.startsWith('strict') ? 'strict' : kind === 'metadata' ? 'metadata' : 'session', actionId, ...(kind === 'probe' ? { probeId } : {}), request };
  const owned: any = { schemaVersion: 1, ...intent.owner, environment: 'windows', pid: 10, creationIdentity: actionId, helperPid: 11, helperCreationIdentity: `${actionId}-helper`, jobIdentity: `${actionId}-job`, boundaryHash: h, assignedBeforeResume: true, capturedAt: 1001 };
  const admit = (phase: any, actualIntent = intent, actual?: any, observationHash?: string) => {
   const a = approval({ intent: actualIntent, ...(phase === 'BOOTSTRAP' ? {} : { ownership: actual, observationHash }) }, phase);
   for (const control of a.controls) control.lifecycle = ['bootstrap', 'thread-start', 'thread-resume', 'verifier'];
   return a;
  };
  const bind = () => { intent.dispatchHash = api.campaignRecipeHash(recipe); request.admissions.BOOTSTRAP = admit('BOOTSTRAP'); const action: CampaignAction = { id: actionId, kind, topLevel: kind === 'probe' || kind === 'metadata' || kind.startsWith('strict'), ...(kind === 'probe' ? { probeId } : {}), launchHash: intent.dispatchHash, admissionHash: fingerprint(request.admissions.BOOTSTRAP), maxMs: 36000, maxOutputBytes: 50000, cleanupId }; const cleanup: CampaignAction = { id: cleanupId, kind: 'cleanup', topLevel: false, launchHash: api.cleanupRecipeHash(batch.id, action), admissionHash: h, maxMs: 1000, maxOutputBytes: 10000 }; return [action, cleanup]; };
  const actions = bind(); batch.actions.push(...actions);
  let capture: any;
  const settings = () => ({ observationHash: h, account: 'chatgpt', provider: 'openai', model: target.model, effort: target.effort });
  const seam: any = {
   prepare: async () => { calls.push('prepare'); return { armedAt: now, paths: ['plugins','plugin-contributions','browser-native','browser-cdp','computer','mcp-ordinary','mcp-managed-cloud','mcp-plugin','remote-control','hooks','legacy-notify','apps','web'] }; },
   launch: async () => { calls.push('launch'); capture.write(Buffer.from('FAKE_SECRET')); now += 5; return owned; }, initialize: async () => { calls.push('initialize'); return settings(); },
   startThread: async () => { calls.push('thread'); return { ...settings(), threadId: 't' }; },
   startTurn: async () => { calls.push('turn'); return { threadId: 't', turnId: 'u', model: target.model, effort: target.effort, response: 'completed', events: [{ kind: 'thread-started', threadId: 't' }, ...['turn-started','item-started','item-completed','turn-completed'].map(kind => ({ kind, threadId: 't', turnId: 'u', ...(['item-started','item-completed'].includes(kind) ? { itemId: 'i' } : {}) }))] }; },
   fence: async () => { calls.push('fence'); return { ownership: owned, fenced: true }; },
   drain: async () => { calls.push('drain'); now += 3; return { ownership: owned, drain: { schemaVersion: 1, ...intent.owner, reason: 'finished', requestAcknowledged: true, requestedAt: now, acknowledgedAt: now, rootExited: true, rootExitedAt: now, membershipEmpty: true, membershipObservedAt: now, activeProcesses: 0, unresolvedExecutions: [], outputComplete: true, unresolvedOutputStreams: [], outputCompletedAt: now, childRanBeforeAssignment: false, completedAt: now } }; },
   reconcileBrokers: async () => { calls.push('brokers'); return { ownership: owned, inventoryComplete: true, active: [], unresolved: [] }; },
   strictOutcome: async () => { calls.push('strict-outcome'); return { exitCode: 1, stderr: 'unknown configuration field `foo` in -c/--config override', rpcCount: 0 }; },
  };
  const adapters: any = { process: (sink: any) => { capture = sink; return seam; }, currentAdmission: admit };
  return { recipe, request, owned, seam, adapters, actions, bind, admit, write: (bytes: string) => capture.write(Buffer.from(bytes)) };
 }
 const runner = () => new api.CampaignRunner(campaign, batch, { now: () => now, current: () => ({ fixtureHash: h, endpointHash: h, targetHash: identity.targetHash }), evidenceKind: 'fixture' });
 const endpoint=(recipe:any)=>({...recipe,launch:{runId,generation:owner.generation,actionId:recipe.actionId,role:'endpoint',executable:startupContext.node.path,argv:['C:\\fixture\\controlled-endpoint.mjs'],cwd:'C:\\fixture',env:{SystemRoot:'C:\\Windows'},boundaryHash:recipe.boundaryHash,authorization:{kind:'qualification',requestId:batch.id,probeId:'auxiliary.endpoint',fixtureRoots:['C:\\fixture']},stdin:'pipe',leaseTtlMs:1000,deadline:4000}});
 return { api, campaign, store, batch, identity, calls, session, runner,endpoint, approve: () => unwrap(campaign.approve(batch)), now: () => now, advance: (ms: number) => { now += ms; }, deny: () => { allowed = false; } };
}

it('runs concrete session effects through durable dispatch, protected publication and reserved cleanup', async () => {
 const f = await fixture(), s = f.session(); f.approve();
 const result = await f.runner().runSession(s.recipe, s.adapters);
 expect(result).toMatchObject({ status: 'PASS', evidenceKind: 'fixture', unknown: false });
 expect(f.calls).toEqual(['prepare','launch','initialize','thread','turn','fence','drain','brokers']);
 const records = unwrap(f.store.listQualifications()).filter((r: any) => r.kind === 'CAMPAIGN_DISPATCH' || r.kind === 'CAMPAIGN_RESULT');
 expect(records.map((r: any) => r.kind)).toEqual(['CAMPAIGN_DISPATCH','CAMPAIGN_DISPATCH','CAMPAIGN_RESULT','CAMPAIGN_RESULT']);
 const operation = result.evidence.find((r: any) => r.category === 'operation');
 const artifact = unwrap(f.store.loadArtifact(operation.id)); const text = readFileSync(join(f.store.root, 'artifacts', artifact.sha256), 'utf8');
 expect(JSON.parse(text)).toMatchObject({ schemaVersion: 2, kind: 'campaign-probe', probeId: 'worker.subscription_request', actualAttempt: true, evidenceKind: 'fixture' });
 expect(text).not.toContain('FAKE_SECRET');
 expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.actions).toBe(2);
 expect(unwrap(f.campaign.aggregate(f.identity.id)).every((p: any) => p.status === 'UNTESTED')).toBe(true);
});
it('dispatches an explicitly approved complete batch once and refuses its replay',async()=>{
 const f=await fixture(),s=f.session();f.approve();const runner=f.runner();
 expect(await dispatchCampaignBatch(runner,[{kind:'session',recipe:s.recipe,adapters:s.adapters}])).toMatchObject({status:'PASS',results:[{status:'PASS',evidenceKind:'fixture'}]});
 const calls=f.calls.length;
 expect(await dispatchCampaignBatch(runner,[{kind:'session',recipe:s.recipe,adapters:s.adapters}])).toMatchObject({status:'REFUSED',results:[]});expect(f.calls).toHaveLength(calls);
 expect(await dispatchCampaignBatch(f.runner(),[{kind:'session',recipe:s.recipe,adapters:s.adapters}])).toMatchObject({status:'REFUSED',results:[]});expect(f.calls).toHaveLength(calls);
});
it('retains a schema-checked startup-proof artifact under its exact action without relabeling fixture evidence',async()=>{
 const f=await fixture(),s=f.session();f.approve();const result=await f.runner().runSession(s.recipe,s.adapters);
 const proof=result.evidence.find((entry:any)=>entry.category==='startup-proof');expect(proof).toBeDefined();
 const artifact=unwrap(f.store.loadArtifact(proof!.id)),body=JSON.parse(readFileSync(join(f.store.root,'artifacts',artifact.sha256),'utf8'));
 expect(artifact.actionId).toBe(s.recipe.actionId);expect(body).toMatchObject({kind:'startup-session-proof',evidenceKind:'simulation',intent:{owner:{actionId:s.recipe.actionId}},status:'PASS'});
 expect(body.intent.dispatchHash).toBe(s.recipe.request.intent.dispatchHash);expect(JSON.stringify(body)).not.toContain('FAKE_SECRET');
 const persisted=unwrap(f.store.listQualifications()).find((entry:any)=>entry.kind==='CAMPAIGN_RESULT'&&entry.actionId===s.recipe.actionId);expect(persisted.payload.usage.evidence).toContainEqual(proof);
});
it('publishes actual managed-conflict projections beside the exact session startup proof',async()=>{
 const f=await fixture(),s=f.session(),projection=observedPolicy(s);f.approve();const result=await f.runner().runSession(s.recipe,s.adapters);
 expect(result).toMatchObject({status:'PASS',unknown:false});const startup=result.evidence.find((entry:any)=>entry.category==='startup-proof'),conflict=result.evidence.find((entry:any)=>entry.category==='managed-conflict');expect(startup).toBeDefined();expect(conflict).toBeDefined();
 const record=unwrap(f.store.loadArtifact(conflict.id)),body=JSON.parse(readFileSync(join(f.store.root,'artifacts',record.sha256),'utf8'));
 expect(body).toMatchObject({kind:'managed-policy-conflict',evidenceKind:'fault_injection',targetHash:f.batch.targetHash,intentHash:fingerprint(s.request.intent),policyEvidence:{id:startup.id,sha256:startup.sha256},outcomes:projection.outcomes});expect(record.actionId).toBe(s.recipe.actionId);expect(JSON.stringify(body)).not.toContain('PRIVATE_UNTRUSTED_SECRET');
});
it('publishes terminal metadata policy and conflict proof with actual dispatches and no thread authority',async()=>{
 const f=await fixture(),s=f.session('','metadata','startup-metadata');observedPolicy(s);f.approve();const result=await f.runner().runMetadata(s.recipe,s.adapters);
 expect(result).toMatchObject({status:'PASS',unknown:false,catalogProbe:false});const ref=result.evidence.find((entry:any)=>entry.category==='startup-proof');expect(ref).toBeDefined();const body=JSON.parse(readFileSync(join(f.store.root,'artifacts',ref.sha256),'utf8'));
 expect(body).toMatchObject({initialized:true,threadStarted:false,status:'PASS',policy:{environmentHash:s.request.intent.environmentHash},intent:{action:'metadata',owner:{role:'startup-metadata'}}});expect(body.dispatches.map((entry:any)=>entry.kind)).toEqual(['launch','initialize','fence','drain','broker-reconcile']);expect(result.evidence.some((entry:any)=>entry.category==='managed-conflict')).toBe(true);expect(f.calls).toEqual(['launch','initialize','fence','drain','brokers']);
});
it.each(['intent','policy','missing-policy'])('refuses managed-conflict publication with mismatched %s provenance',async(fault)=>{
 const f=await fixture(),s=f.session('','metadata','startup-metadata');observedPolicy(s);const initialize=s.seam.initialize;
 s.seam.initialize=async()=>{const actual=await initialize();if(fault==='intent')actual.managedConflict={...actual.managedConflict,intentHash:'0'.repeat(64)};else if(fault==='policy')actual.policy={...actual.policy,configurationHash:'0'.repeat(64)};else delete actual.policy;return actual;};
 f.approve();const result=await f.runner().runMetadata(s.recipe,s.adapters);
 expect(result.status).toBe('FAIL');expect(result.evidence.some((entry:any)=>entry.category==='managed-conflict')).toBe(false);expect(f.calls).toEqual(['launch','initialize','fence','drain','brokers']);
});
it('refuses a stale later admission before any earlier process starts',async()=>{
 const f=await fixture(),a=f.session(),b=f.session('worker.correlated_lifecycle');f.approve();b.adapters.currentAdmission=()=>undefined;
 expect(await dispatchCampaignBatch(f.runner(),[{kind:'session',recipe:a.recipe,adapters:a.adapters},{kind:'session',recipe:b.recipe,adapters:b.adapters}])).toEqual({status:'REFUSED',results:[]});expect(f.calls).toEqual([]);
});
it('refuses cancellation without its concrete observer before starting an unrelated process',async()=>{
 const f=await fixture(),unrelated=f.session('','metadata','startup-metadata'),primary=f.session('controller.foreground_cancel');primary.recipe.request.unrelatedActionId=unrelated.recipe.actionId;delete primary.recipe.request.unrelated;
 expect(await dispatchCampaignBatch(f.runner(),[{kind:'unrelated',recipe:unrelated.recipe,adapters:unrelated.adapters,steps:[{kind:'session',recipe:primary.recipe,adapters:primary.adapters}]}])).toEqual({status:'REFUSED',results:[]});expect(f.calls).toEqual([]);
});
it.each(['missing','changed','unapproved'] as const)('preflights the whole %s batch before its first process',async(fault)=>{
 const f=await fixture(),a=f.session(),b=f.session('worker.correlated_lifecycle');if(fault!=='unapproved')f.approve();if(fault==='changed')b.recipe.request.argv.push('changed');
 const steps=[{kind:'session' as const,recipe:a.recipe,adapters:a.adapters},...(fault==='missing'?[]:[{kind:'session' as const,recipe:b.recipe,adapters:b.adapters}])];
 expect(await dispatchCampaignBatch(f.runner(),steps)).toEqual({status:'REFUSED',results:[]});expect(f.calls).toEqual([]);
});
it('stops the selected batch after its first non-PASS and retains that failure',async()=>{
 const f=await fixture(),a=f.session(),b=f.session('worker.correlated_lifecycle');a.seam.initialize=async()=>{throw Error('fake-secret');};f.approve();
 const result=await dispatchCampaignBatch(f.runner(),[{kind:'session',recipe:a.recipe,adapters:a.adapters},{kind:'session',recipe:b.recipe,adapters:b.adapters}]);
 expect(result).toMatchObject({status:'STOPPED',results:[{status:'FAIL'}]});expect(f.calls.filter(call=>call==='launch')).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('fake-secret');
});
it('rejects exact recipe substitution without effects or approval mutation', async () => {
 const f = await fixture(), s = f.session(); f.approve(); s.request.argv.push('-c', 'unexpected=true');
 const before = structuredClone(f.batch);
 expect(await f.runner().runSession(s.recipe, s.adapters)).toMatchObject({ status: 'REFUSED' });
 expect(f.calls).toEqual([]); expect(f.batch).toEqual(before);
});
it('rechecks current authority after awaits and before a later concrete effect', async () => {
 const f = await fixture(), s = f.session(); f.approve(); s.seam.initialize = async () => { f.advance(30000); return { observationHash: h, account: 'chatgpt', provider: 'openai', model: 'fixture-model', effort: 'high' }; };
 const result = await f.runner().runSession(s.recipe, s.adapters);
 expect(result.status).not.toBe('PASS'); expect(f.calls).not.toContain('thread');
 expect(f.calls).toContain('drain'); expect(unwrap(f.campaign.snapshot(f.identity.id)).reconciliationRequired).toBe(true);
});
it('charges raw output before discarding it and retains unknown reservations on overflow', async () => {
 const f = await fixture(), s = f.session(); f.approve(); s.seam.launch = async () => { f.calls.push('launch'); s.write('x'.repeat(50001)); return s.owned; };
 const result = await f.runner().runSession(s.recipe, s.adapters);
 expect(result).toMatchObject({ unknown: true }); expect(unwrap(f.campaign.snapshot(f.identity.id)).reconciliationRequired).toBe(true);
 expect(unwrap(f.campaign.snapshot(f.identity.id)).reserved.actions).toBeGreaterThanOrEqual(1);
 expect(f.calls).not.toContain('thread'); expect(f.calls).toContain('drain');
});
it('permits exact owned terminal cleanup after ordinary approval expiry', async () => {
 const f = await fixture(), s = f.session(); f.approve(); const original = s.seam.startTurn;
 s.seam.startTurn = async () => { const turn = await original(); f.advance(29000); f.deny(); return turn; };
 await f.runner().runSession(s.recipe, s.adapters);
 expect(f.calls).toContain('drain'); expect(unwrap(f.store.loadAction(s.actions[1].id)).state).toBe('OBSERVED');
});
it('terminal metadata dispatch never creates a worker thread or reusable session authority', async () => {
 const f = await fixture(), s = f.session('', 'metadata', 'startup-metadata'); f.approve();
 expect(await f.runner().runMetadata(s.recipe, s.adapters)).toMatchObject({ status: 'PASS', catalogProbe: false });
 expect(f.calls).toEqual(['launch','initialize','fence','drain','brokers']);
 expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.actions).toBe(2);
});
it.each(['clean','unfamiliar-version','notification','request','invalid-identity','truncated-final-frame','late-error','output-drain-failure'])('terminal metadata campaign records %s actual wire/output behavior',async(fault)=>{
 const f=await fixture(),s=f.session('', 'metadata', 'startup-metadata');
 s.request.intent.workspace='C:\\fixture\\workspace';s.request.intent.configAncestry=['C:\\','C:\\fixture','C:\\fixture\\workspace'];s.request.intent.profile='ouroboros_worker';
 const env={SystemRoot:'C:\\Windows'};s.request.intent.environmentHash=createHash('sha256').update(JSON.stringify(env)).digest('hex');f.batch.actions.splice(0,f.batch.actions.length,...s.bind());
 const listeners=new Set<any>(),frames:any[]=[],terminal:string[]=[];
 const raw=(data:Uint8Array)=>{for(const listener of listeners)listener({stream:'stdout',data});};const emit=(frame:unknown)=>raw(Buffer.from(JSON.stringify(frame)+'\n'));
 const execution:any={describe:async()=>s.owned,onOutput:(listener:any)=>{listeners.add(listener);return()=>listeners.delete(listener);},renewLease:async()=>{},endInput:async()=>({ok:true,value:undefined}),fence:async()=>{terminal.push('fence');},drain:async()=>{terminal.push('drain');if(fault==='truncated-final-frame')raw(Buffer.from('{"id":'));if(fault==='late-error')emit({method:'error',params:{error:{codexErrorInfo:'unauthorized'}}});const result=await s.seam.drain();return fault==='output-drain-failure'?{...result.drain,outputComplete:false,unresolvedOutputStreams:['stdout']}:result.drain;},writeInput:async(bytes:Uint8Array)=>{const frame=JSON.parse(Buffer.from(bytes).toString());frames.push(frame);if(!frame.id)return {ok:true,value:undefined};let result:unknown;
  switch(frame.method){case 'initialize':result={userAgent:fault==='unfamiliar-version'?'codex/9.9.9':'codex/0.162.1',codexHome:'C:\\fixture\\home',platformFamily:'windows',platformOs:fault==='invalid-identity'?'linux':'windows'};break;case 'account/read':result={account:{type:'chatgpt',email:'private@example.test',planType:'plus'},requiresOpenaiAuth:true};break;case 'config/read':result={config:{model:'fixture-model',model_reasoning_effort:'high',model_provider:'openai',default_permissions:'ouroboros_worker',windows:{sandbox:'mxc'},features:{plugins:false,hooks:false,apps:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:false,remote_control:false},mcp_servers:{},notify:[],web_search:'disabled'}};break;case 'configRequirements/read':result={requirements:null};break;default:throw Error('UNAPPROVED_TEST_WIRE');}
  if(frame.method==='configRequirements/read'&&['notification','request'].includes(fault))emit({method:'thread/started',params:{thread:{id:'unapproved'}},...(fault==='request'?{id:'server-request'}:{})});emit({id:frame.id,result});return {ok:true,value:undefined};}};
 const backend=createSessionBackend({supervisor:{launchOwned:async()=>({ok:true,value:execution})},env,fixture:{root:'C:\\fixture',controlHash:s.request.intent.controlHash,monitorActionId:s.request.intent.owner.actionId,activityDriver:{path:'C:\\fixture\\activity.mjs',sha256:h},canaries:[],protectedFiles:{},heartbeat:'C:\\fixture\\heartbeat',checkpoint:'C:\\fixture\\checkpoint'},now:f.now,timeoutMs:50,currentAdmission:s.admit});
 f.approve();const result=await f.runner().runMetadata(s.recipe,{currentAdmission:s.admit,process:(capture:any,gate:any)=>{const process=backend.process(capture,gate);return {...process,reconcileBrokers:s.seam.reconcileBrokers};}});
 expect(result.status).toBe(['clean','unfamiliar-version'].includes(fault)?'PASS':'FAIL');expect(terminal).toEqual(['fence','drain']);expect(frames.every(frame=>['initialize','initialized','account/read','config/read','configRequirements/read'].includes(frame.method))).toBe(true);expect(frames.some(frame=>frame.id==='server-request')).toBe(false);
});
it('composes independent strict launches as four auxiliary actions without catalog inflation', async () => {
 const f = await fixture(), p = f.session('', 'strict-positive'), n = f.session('', 'strict-negative');
 n.request.intent.argumentsHash = createHash('sha256').update(JSON.stringify([...n.request.argv, '-c', 'foo="bar"'])).digest('hex');
 const replaced = n.bind(); f.batch.actions.splice(2, 2, ...replaced); f.approve();
 const result = await f.runner().runStrictPair({ positive: p.recipe, negative: n.recipe }, { positive: p.adapters, negative: n.adapters });
 expect(result).toMatchObject({ status: 'PASS', catalogProbe: false });
 expect(f.calls.filter(c => c === 'launch')).toHaveLength(2); expect(f.calls.filter(c => c === 'drain')).toHaveLength(2);
 expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.actions).toBe(4);
 expect(unwrap(f.campaign.aggregate(f.identity.id)).every((p: any) => !p.actionIds.length)).toBe(true);
});
it('gates the fixed verifier operation after actual owned initialization and publishes the real driver result', async () => {
 const f = await fixture(), s = f.session('verifier.denied_source_write', 'probe', 'verifier');
 s.recipe.kind = 'fixed'; delete s.recipe.probeId; s.recipe.boundary = { role: 'verifier', executionId: s.owned.creationIdentity, operation: 'denied_source_write', fixtureRoot: 'C:\\fixture', targetHash: f.identity.targetHash };
 const replaced = s.bind(); f.batch.actions.splice(0, 2, ...replaced); f.approve();
 const operation = async (input: any) => { f.calls.push('boundary'); return { role: input.role, executionId: input.executionId, operationId: input.operationId, attempted: true, effect: 'blocked', origin: 'filesystem', code: 'EACCES' }; };
 const io: any = { filesystem: { write: operation }, network: {}, broker: {}, controller: { now: f.now, snapshotSentinel: async (input: any) => ({ ...input, role: 'controller', executionId: 'controller-snapshot', actualRead: true, sha256: h }) } };
 expect(await f.runner().runFixed(s.recipe, { ...s.adapters, io: () => io })).toMatchObject({ status: 'PASS', actualAttempt: true });
 expect(f.calls.indexOf('initialize')).toBeLessThan(f.calls.indexOf('boundary')); expect(f.calls).not.toContain('thread');
});
it('charges a service lifetime across nested probes, then separately charges its terminal cleanup', async () => {
 const f = await fixture(), s = f.session();
 const service: any = f.endpoint({ kind: 'endpoint', actionId: randomUUID(), endpoint: 'http://localhost:18471/allowed', fixtureRoot: 'C:\\fixture', executionId: 'service-1', generation: 'generation-1', boundaryHash: h });
 const action: CampaignAction = { id: service.actionId, kind: 'endpoint', topLevel: false, auxiliaryFor:s.actions[0].id,auxiliaryRole:'endpoint', launchHash:f.api.campaignRecipeHash(service), admissionHash:h,maxMs:36000, maxOutputBytes: 10000, cleanupId: randomUUID() };
 f.batch.actions.unshift(action, { id: action.cleanupId!, kind: 'cleanup', topLevel: false, launchHash: f.api.cleanupRecipeHash(f.batch.id, action), admissionHash: h, maxMs: 1000, maxOutputBytes: 10000 }); f.approve();
 const runner = f.runner(); let started = 0;
 const serviceOwned = { ...s.owned, actionId: service.actionId, role: 'endpoint', creationIdentity: 'service-root', helperCreationIdentity: 'service-helper', jobIdentity: 'service-job' };
 const result = await runner.withEndpoint(service, { launch:service.launch,start: async () => { started = f.now(); f.calls.push('service-start'); return { executionId: service.executionId, generation: service.generation, ownership: serviceOwned }; }, stop: async () => { f.calls.push('service-stop'); const terminal = await s.seam.drain(); return { executionId: service.executionId, generation: service.generation, ownership: serviceOwned, drain: { ...terminal.drain, actionId: service.actionId, role: 'endpoint' }, terminated: true, outputComplete: true }; } }, async () => { const r = await runner.runSession(s.recipe, s.adapters); f.advance(10); return r; });
 expect(result.status).toBe('PASS'); expect(f.calls[0]).toBe('service-start'); expect(f.calls.indexOf('service-stop')).toBeGreaterThan(f.calls.indexOf('turn'));
 const consumed = unwrap(f.campaign.snapshot(f.identity.id)).consumed;
 expect(consumed.actions).toBe(4); expect(consumed.activeMs).toBeGreaterThan(f.now() - started);
});
it('an auxiliary start failure fences the campaign and prevents the nested probe', async () => {
 const f = await fixture(), s = f.session(); const service: any = f.endpoint({ kind: 'endpoint', actionId: randomUUID(), endpoint: 'http://localhost:18471/allowed', fixtureRoot: 'C:\\fixture', executionId: 'service-1', generation: 'g', boundaryHash: h });
 const action: CampaignAction = { id: service.actionId, kind: 'endpoint', topLevel: false, auxiliaryFor:s.actions[0].id,auxiliaryRole:'endpoint', launchHash:f.api.campaignRecipeHash(service), admissionHash:h,maxMs:36000, maxOutputBytes: 10000, cleanupId: randomUUID() };
 f.batch.actions.unshift(action, { id: action.cleanupId!, kind: 'cleanup', topLevel: false, launchHash: f.api.cleanupRecipeHash(f.batch.id, action), admissionHash: h, maxMs: 1000, maxOutputBytes: 10000 }); f.approve();
 let nested = false;
 expect(await f.runner().withEndpoint(service, { launch:service.launch,start: async () => { throw Error('unavailable'); }, stop: async () => { throw Error('no receipt'); } }, async () => { nested = true; return {}; })).toMatchObject({ status: 'FAIL', unknown: true });
 expect(nested).toBe(false); expect(unwrap(f.campaign.snapshot(f.identity.id)).reconciliationRequired).toBe(true);
});
it('runs a neutral verifier channel only after actual readiness and verifier admission, without fabricated account metadata', async () => {
 const f = await fixture(), s = f.session('verifier.denied_source_write', 'probe', 'verifier');
 s.recipe.kind = 'fixed'; delete s.recipe.probeId;
 s.recipe.channel = { resourceHash: h };
 s.recipe.boundary = { role: 'verifier', executionId: s.request.intent.owner.actionId, operation: 'denied_source_write', fixtureRoot: 'C:\\fixture', targetHash: f.identity.targetHash };
 const replaced = s.bind(); f.batch.actions.splice(0, 2, ...replaced); f.approve();
 s.seam.initialize = async () => { f.calls.push('ready'); return { kind: 'fixed-resource-ready', resourceHash: h, executionId: s.request.intent.owner.actionId, observationHash: h }; };
 const operation = async (input: any) => { f.calls.push('boundary'); return { role: input.role, executionId: input.executionId, operationId: input.operationId, attempted: true, effect: 'blocked', origin: 'filesystem', code: 'EACCES' }; };
 const io: any = { filesystem: { write: operation }, network: {}, broker: {}, controller: { now: f.now, snapshotSentinel: async (input: any) => ({ ...input, role: 'controller', executionId: 'snapshot', actualRead: true, sha256: h }) } };
 expect(await f.runner().runFixed(s.recipe, { ...s.adapters, mode: 'verifier-channel', io: (_capture: any, actualOwned: any) => { expect(actualOwned.creationIdentity).toBe(s.owned.creationIdentity); return io; } })).toMatchObject({ status: 'PASS', actualAttempt: true });
 expect(f.calls).toEqual(['launch','ready','boundary','fence','drain','brokers']);
});
it.each(['denied_network','broker_escape'])('refuses uncharged endpoint availability before a fixed %s root is created', async operationName => {
 const f = await fixture(), s = f.session(`verifier.${operationName}`, 'probe', 'verifier');
 s.recipe.kind = 'fixed'; delete s.recipe.probeId;
 s.recipe.boundary = { role: 'verifier', executionId: s.request.intent.owner.actionId, operation: operationName, fixtureRoot: 'C:\\fixture', targetHash: f.identity.targetHash };
 const replaced = s.bind(); f.batch.actions.splice(0, 2, ...replaced); f.approve();
 const io: any = { filesystem: {}, network: { proxyHttp: async (input: any) => ({ role: input.role, executionId: input.executionId, operationId: input.operationId, attempted: true, effect: 'blocked', origin: 'network-proxy', code: 'EACCES' }) }, broker: {}, controller: { now: f.now, observeEndpoint: async (input: any) => ({ ...input, role: 'controller', executionId: 'unowned-service', serviceGeneration: 'g', actualAttempt: true, available: true, observedFromMs: 0, availableThroughMs: 100000 }) } };
 expect(await f.runner().runFixed(s.recipe, { ...s.adapters, io: () => io })).toMatchObject({ status: 'REFUSED' });
 expect(f.calls).toEqual([]);
});
it('supplies a current effect gate to prevent root creation after asynchronous backend preparation', async () => {
 const f = await fixture(), s = f.session(); f.approve();
 let gateSupplied = false; let reachedKernel = false;
 const adapters = { ...s.adapters, process: (_capture: any, gate: any) => { gateSupplied = typeof gate === 'function'; return { ...s.seam, launch: async () => { await Promise.resolve(); f.advance(30000); gate('BOOTSTRAP'); reachedKernel = true; return s.owned; } }; } };
 expect(await f.runner().runSession(s.recipe, adapters)).toMatchObject({ status: 'FAIL', unknown: true });
 expect(gateSupplied).toBe(true); expect(reachedKernel).toBe(false); expect(f.calls).toContain('drain');
});
it.each(['denied_network','denied_direct_tcp'])('publishes independent network evidence only for the active charged service generation: %s', async operationName => {
 const f = await fixture(), s = f.session(`verifier.${operationName}`, 'probe', 'verifier');
 s.recipe.kind = 'fixed'; delete s.recipe.probeId; s.recipe.channel = { resourceHash: h };
 s.recipe.boundary = { role: 'verifier', executionId: s.request.intent.owner.actionId, operation: operationName, fixtureRoot: 'C:\\fixture', targetHash: f.identity.targetHash,networkPlan:{schemaVersion:1,proxy:{url:'http://localhost:18473/',source:'documented-sandbox-managed',policyHash:h,provenanceHash:h},directTcp:{host:'192.0.2.1',port:18472}} };
 const replaced = s.bind(); f.batch.actions.splice(0, 2, ...replaced);
 const service: any = f.endpoint({ kind: 'endpoint', actionId: randomUUID(), endpoint: operationName==='denied_direct_tcp'?'tcp://192.0.2.1:18472':'http://127.0.0.1:18472/denied',networkPlan:s.recipe.boundary.networkPlan, fixtureRoot: 'C:\\fixture', executionId: 'charged-service', generation: 'g', boundaryHash: h });
 const serviceAction: CampaignAction = { id: service.actionId, kind: 'endpoint', topLevel: false, auxiliaryFor:s.actions[0].id,auxiliaryRole:'endpoint', launchHash:f.api.campaignRecipeHash(service), admissionHash:h,maxMs:36000, maxOutputBytes: 10000, cleanupId: randomUUID() };
 f.batch.actions.unshift(serviceAction, { id: serviceAction.cleanupId!, kind: 'cleanup', topLevel: false, launchHash: f.api.cleanupRecipeHash(f.batch.id, serviceAction), admissionHash: h, maxMs: 1000, maxOutputBytes: 10000 }); f.approve();
 const serviceOwned = { ...s.owned, actionId: service.actionId, role: 'endpoint', pid: 20, helperPid: 21, creationIdentity: 'service-root', helperCreationIdentity: 'service-helper', jobIdentity: 'service-job' };
 s.seam.initialize = async () => ({ kind: 'fixed-resource-ready', resourceHash: h, executionId: s.request.intent.owner.actionId, observationHash: h });
 const operation=async(input:any)=>{f.advance(4);return {role:input.role,executionId:input.executionId,operationId:input.operationId,attempted:true,effect:'blocked',origin:operationName==='denied_network'?'network-proxy':'network-tcp',code:operationName==='denied_network'?'HTTP_PROXY_DENIED':'EACCES',proxyError:'blocked-by-allowlist',runtimeProxyMatched:true,proxyProvenanceHash:h,proxyPolicyHash:h};}; const io:any={filesystem:{},network:{proxyHttp:operation,directTcp:operation},broker:{},controller:{now:f.now,observeEndpoint:async(input:any)=>({...input,role:'controller',executionId:service.executionId,serviceGeneration:service.generation,actualAttempt:true,available:true,observedFromMs:1001,availableThroughMs:f.now()+1})}};
 const runner = f.runner(); const result = await runner.withEndpoint(service, { launch:service.launch,start: async () => ({ executionId: service.executionId, generation: service.generation, ownership: serviceOwned }), stop: async () => { const terminal = await s.seam.drain(); return { executionId: service.executionId, generation: service.generation, ownership: serviceOwned, drain: { ...terminal.drain, actionId: service.actionId, role: 'endpoint' }, terminated: true, outputComplete: true }; } }, () => runner.runFixed(s.recipe, { ...s.adapters, mode: 'verifier-channel', io: () => io }));
 expect(result.nested).toMatchObject({ status: 'PASS' });
 expect(result.nested.evidence.map((ref: any) => ref.category)).toContain('network');
 expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.actions).toBe(4);
});
it('charges an independently owned guardian lifetime and its cleanup around nested work',async()=>{
 const f=await fixture(),s=f.session(),id=randomUUID(),cleanupId=randomUUID();
 const recipe:any={kind:'auxiliary',actionId:id,role:'guardian',launch:{...s.request.intent.owner,actionId:id,role:'qualification-guardian',executable:f.identity.target.helper.path,argv:['--qualification-observer-v1'],cwd:s.request.intent.workspace,env:{SystemRoot:'C:\\Windows'},boundaryHash:h,authorization:{kind:'qualification',requestId:f.batch.id,probeId:'auxiliary.guardian',fixtureRoots:['C:\\fixture']},stdin:'pipe',leaseTtlMs:1000,deadline:5000},executableHash:f.identity.target.helper.sha256,resources:[{path:'C:\\trusted\\controller.mjs',sha256:h}]};
 const action:any={id,kind:'preparation',topLevel:false,auxiliaryFor:s.actions[0].id,auxiliaryRole:recipe.role,launchHash:f.api.campaignRecipeHash(recipe),admissionHash:h,maxMs:5000,maxOutputBytes:20000,cleanupId};
 f.batch.actions.unshift(action,{id:cleanupId,kind:'cleanup',topLevel:false,launchHash:f.api.cleanupRecipeHash(f.batch.id,action),admissionHash:h,maxMs:1000,maxOutputBytes:10000});f.approve();
 const runner=f.runner();expect(typeof runner.withAuxiliary).toBe('function');let stopped=false;
 const resource={owner:{...recipe.launch,executable:undefined,argv:undefined},identity:{pid:50,creationIdentity:'guardian-50'},launchHash:action.launchHash,createdAt:f.now()};
 resource.owner={runId:recipe.launch.runId,generation:recipe.launch.generation,actionId:id,role:recipe.launch.role} as any;
 const result=await runner.withAuxiliary(recipe,{start:async(_capture:any,gate:any)=>{gate();return resource;},stop:async(actual:any,_capture:any,gate:any)=>{gate();expect(actual.identity).toEqual({pid:50,creationIdentity:'guardian-50'});stopped=true;return {...actual,exited:true,exitCode:0,outputComplete:true,completedAt:f.now()};}},async()=>{const nested=await runner.runSession(s.recipe,s.adapters);f.advance(20);return nested;});
 expect(result).toMatchObject({status:'PASS',catalogProbe:false,nested:{status:'PASS'}});expect(stopped).toBe(true);expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.actions).toBe(4);
});
it('sums distinct integral helper and root lifetime meters instead of concurrent controller wall time',async()=>{
 const f=await fixture(),s=f.session();f.approve();let capture:any;
 const adapters={...s.adapters,process:(sink:any)=>{capture=sink;return {...s.seam,launch:async()=>{f.advance(5);return s.owned;},drain:async()=>{const terminal=await s.seam.drain();expect(typeof capture.processCompleted).toBe('function');capture.processCompleted({kind:'root',identity:{pid:s.owned.pid,creationIdentity:s.owned.creationIdentity},activeMs:20});capture.processCompleted({kind:'helper',identity:{pid:s.owned.helperPid,creationIdentity:s.owned.helperCreationIdentity},activeMs:30});return terminal;}};}};
 const result=await f.runner().runSession(s.recipe,adapters);expect(result.status).toBe('PASS');expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.activeMs).toBeGreaterThanOrEqual(50);
});
it('attempts known owned endpoint drainage under cleanup even when its startup handshake failed',async()=>{
 const f=await fixture(),s=f.session();const recipe:any=f.endpoint({kind:'endpoint',actionId:randomUUID(),endpoint:'http://localhost:18471/allowed',fixtureRoot:'C:\\fixture',executionId:'failed-service',generation:'g',boundaryHash:h});
 const action:any={id:recipe.actionId,kind:'endpoint',topLevel:false,auxiliaryFor:s.actions[0].id,auxiliaryRole:'endpoint',launchHash:f.api.campaignRecipeHash(recipe),admissionHash:h,maxMs:36000,maxOutputBytes:10000,cleanupId:randomUUID()};f.batch.actions.unshift(action,{id:action.cleanupId,kind:'cleanup',topLevel:false,launchHash:f.api.cleanupRecipeHash(f.batch.id,action),admissionHash:h,maxMs:1000,maxOutputBytes:10000});f.approve();
 const ownership={...s.owned,actionId:recipe.actionId,role:'endpoint',pid:20,helperPid:21,creationIdentity:'failed-root',helperCreationIdentity:'failed-helper'};const resource={executionId:recipe.executionId,generation:recipe.generation,ownership};let drained=false;
 const result=await f.runner().withEndpoint(recipe,{launch:recipe.launch,start:async()=>{throw Error('ready failed');},recoverOwned:()=>resource,stop:async()=>{drained=true;const terminal=await s.seam.drain();return {...resource,drain:{...terminal.drain,actionId:recipe.actionId,role:'endpoint'},terminated:true,outputComplete:true};}},async()=>{throw Error('must not run');});
 expect(result.status).toBe('FAIL');expect(drained).toBe(true);expect(unwrap(f.store.loadAction(action.cleanupId)).state).toBe('OBSERVED');
});
it.each([true,false])('binds the approved primary intent before dispatching the exact observation topology: %s',async matching=>{
 const f=await fixture(),s=f.session(),cleanupId=randomUUID();
 const make=(role:string)=>{const id=randomUUID();const recipe:any={kind:'auxiliary',actionId:id,role,bindingHash:h,launch:{...s.request.intent.owner,actionId:id,role:`qualification-${role}`,executable:role==='guardian'?f.identity.target.helper.path:s.request.intent.node.path,argv:role==='guardian'?['--qualification-observer-v1']:['C:\\trusted\\controller.mjs'],cwd:s.request.intent.workspace,env:{SystemRoot:'C:\\Windows'},boundaryHash:h,authorization:{kind:'qualification',requestId:f.batch.id,probeId:`auxiliary.${role}`,fixtureRoots:['C:\\fixture']},stdin:'pipe',leaseTtlMs:1000,deadline:5000},executableHash:role==='guardian'?f.identity.target.helper.sha256:s.request.intent.node.sha256,resources:[{path:'C:\\trusted\\controller.mjs',sha256:h}]};const action:any={id,kind:'preparation',topLevel:false,auxiliaryFor:s.actions[0].id,auxiliaryRole:recipe.role,launchHash:f.api.campaignRecipeHash(recipe),admissionHash:h,maxMs:5000,maxOutputBytes:20000,cleanupId};return {recipe,action};};
 const g=make('guardian'),c=make('controller');f.batch.actions=f.batch.actions.filter(a=>a.id!==s.actions[1].id);s.actions[0].cleanupId=cleanupId;f.batch.actions.unshift(g.action,c.action,{id:cleanupId,kind:'cleanup',topLevel:false,launchHash:f.api.cleanupRecipeHash(f.batch.id,[g.action,c.action,s.actions[0]]),admissionHash:h,maxMs:1000,maxOutputBytes:20000});f.approve();
 const resource=(entry:any,pid:number)=>({owner:{runId:f.batch.owner.runId,generation:f.batch.owner.generation,actionId:entry.action.id,role:entry.recipe.launch.role},identity:{pid,creationIdentity:`observed-${pid}`},launchHash:entry.action.launchHash,createdAt:f.now()});const resources={guardian:resource(g,50),controller:resource(c,51)};
 const runner=f.runner();expect(typeof runner.withObservation).toBe('function');let stopped=0;
 const result=await runner.withObservation({guardian:g.recipe,controller:c.recipe,primary:s.recipe},{primaryIntentHash:matching?fingerprint(s.request.intent):'0'.repeat(64),start:async(_captures:any,gates:any)=>{gates.guardian();gates.controller();expect(unwrap(f.store.loadAction(g.action.id)).state).toBe('DISPATCHED');expect(unwrap(f.store.loadAction(c.action.id)).state).toBe('DISPATCHED');return resources;},stop:async(actual:any,_captures:any,gates:any)=>{gates.guardian();gates.controller();stopped++;return Object.fromEntries(Object.entries(actual).map(([kind,r]:any)=>[kind,{...r,exited:true,exitCode:0,outputComplete:true,completedAt:f.now()}]));}},async()=>runner.runSession(s.recipe,s.adapters));
 if(!matching){expect(result.status).toBe('REFUSED');expect(f.calls).toEqual([]);return;} expect(result).toMatchObject({status:'PASS',nested:{status:'PASS'}});expect(stopped).toBe(1);expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.actions).toBe(4);expect(unwrap(f.store.loadAction(cleanupId)).state).toBe('OBSERVED');
});
it('records successful cleanup independently so an approved corrective probe can clear the only failed result',async()=>{
 const f=await fixture(),bad=f.session('worker.allowed_edit');bad.seam.snapshotProtected=async()=>bad.request.protectedInputs;bad.seam.readEdit=async()=>'wrong edit';f.approve();
 const failed=await f.runner().runSession(bad.recipe,bad.adapters);expect(failed).toMatchObject({status:'FAIL',unknown:false});
 const cleanup=unwrap(f.store.listQualifications()).find((r:any)=>r.kind==='CAMPAIGN_RESULT'&&r.actionId===bad.actions[1].id);expect(cleanup.payload.usage.status).toBe('PASS');
 const ref=failed.evidence.find((e:any)=>e.category==='operation');unwrap(f.campaign.reconcile(f.identity.id,{id:randomUUID(),owner:f.batch.owner,evidenceIds:[ref.id],targetHash:f.identity.targetHash}));
 const rotate=()=>{f.batch.id=randomUUID();f.batch.actions=[];f.batch.remaining=unwrap(f.campaign.snapshot(f.identity.id)).remaining;f.batch.approvedAt=f.now();f.batch.expiresAt=f.now()+30000;};rotate();
 const good=f.session('worker.allowed_edit');good.seam.snapshotProtected=async()=>good.request.protectedInputs;good.seam.readEdit=async()=>'QUALIFIED_EDIT\r\n';f.batch.correction={candidateId:randomUUID(),affectedActionId:bad.actions[0].id,evidenceIds:[ref.id]};f.approve();
 expect(await f.runner().runSession(good.recipe,good.adapters)).toMatchObject({status:'PASS',unknown:false});expect(unwrap(f.campaign.snapshot(f.identity.id)).correctionRequired).toBe(false);
 rotate();delete f.batch.correction;f.session();expect(f.campaign.approve(f.batch).ok).toBe(true);
});
it('holds a separately charged metadata root as the exact unrelated process and retires its registry before terminal return',async()=>{
 const f=await fixture(),s=f.session('','metadata','startup-metadata');f.approve();const runner=f.runner();expect(typeof runner.withUnrelated).toBe('function');expect(typeof runner.ownedUnrelated).toBe('function');
 expect(runner.ownedUnrelated(s.actions[0].id)).toBeUndefined();
 const result=await runner.withUnrelated(s.recipe,s.adapters,async(actual:any)=>{expect(actual).toEqual({actionId:s.actions[0].id,pid:s.owned.pid,creationIdentity:s.owned.creationIdentity,name:'codex.exe'});expect(runner.ownedUnrelated(s.actions[0].id)).toEqual(actual);expect(f.calls).not.toContain('thread');return true;});
 expect(result).toMatchObject({status:'PASS',nested:true});expect(runner.ownedUnrelated(s.actions[0].id)).toBeUndefined();expect(f.calls).toEqual(['launch','initialize','fence','drain','brokers']);expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.actions).toBe(2);
});
it('projects broker inventory scope from the current owned campaign service registry only',async()=>{
 const f=await fixture(),s=f.session('','metadata','startup-metadata');f.approve();const runner=f.runner();expect(typeof runner.ownedBrokerRegistry).toBe('function');expect(runner.ownedBrokerRegistry(s.request.intent)).toBeUndefined();
 await runner.withUnrelated(s.recipe,s.adapters,async()=>{expect(runner.ownedBrokerRegistry(s.request.intent)).toEqual({schemaVersion:1,scope:'campaign-owned-controlled-services',source:'campaign-owned-resource-registry',owner:s.request.intent.owner,targetHash:startupTargetHash(s.request.intent),controlHash:s.request.intent.controlHash,registeredActionIds:[]});return true;});
 expect(runner.ownedBrokerRegistry(s.request.intent)).toBeUndefined();
});
it('resolves a referenced unrelated process from the held owned root during the nested session',async()=>{
 const f=await fixture(),held=f.session('','metadata','startup-metadata'),s=f.session();held.owned.pid=50;held.owned.helperPid=51;held.owned.creationIdentity='held-root-50';held.owned.helperCreationIdentity='held-helper-51';
 delete s.request.unrelated;s.request.unrelatedActionId=held.actions[0].id;const replaced=s.bind();f.batch.actions.splice(2,2,...replaced);f.approve();const runner=f.runner();let resolved:any;
 const original=s.seam.prepare;s.seam.prepare=async(input:any)=>{resolved=input.unrelated;return original(input);};
 const result=await runner.withUnrelated(held.recipe,held.adapters,()=>runner.runSession(s.recipe,s.adapters));
 expect(result).toMatchObject({status:'PASS',nested:{status:'PASS'}});expect(resolved).toEqual({pid:50,creationIdentity:'held-root-50',name:'codex.exe'});expect(unwrap(f.campaign.snapshot(f.identity.id)).consumed.actions).toBe(4);
});
it.each([{reserve:35997,allowed:false},{reserve:36000,allowed:true}])('requires the declared integral process lifetime reserve before any runtime effect: $allowed',async({reserve,allowed})=>{
 const f=await fixture(),s=f.session();s.request.intent.expiresAt=4000;const actions=s.bind();actions[0].maxMs=reserve;f.batch.actions.splice(0,2,...actions);f.approve();const result=await f.runner().runSession(s.recipe,s.adapters);
 expect(result.status).toBe(allowed?'PASS':'REFUSED');if(!allowed)expect(f.calls).toEqual([]);
});
it('retains conservative raw output when an auxiliary recovery has exact lifetime but no raw meter',async()=>{
 const f=await fixture(),s=f.session(),id=randomUUID(),cleanupId=randomUUID();const recipe:any={kind:'auxiliary',actionId:id,role:'guardian',launch:{...s.request.intent.owner,actionId:id,role:'qualification-guardian',executable:f.identity.target.helper.path,argv:['--qualification-observer-v1'],cwd:s.request.intent.workspace,env:{SystemRoot:'C:\\Windows'},boundaryHash:h,authorization:{kind:'qualification',requestId:f.batch.id,probeId:'auxiliary.guardian',fixtureRoots:['C:\\fixture']},stdin:'pipe',leaseTtlMs:1000,deadline:4000},executableHash:f.identity.target.helper.sha256,resources:[{path:'C:\\trusted\\controller.mjs',sha256:h}]};
 const action:any={id,kind:'preparation',topLevel:false,auxiliaryFor:s.actions[0].id,auxiliaryRole:'guardian',launchHash:f.api.campaignRecipeHash(recipe),admissionHash:h,maxMs:5000,maxOutputBytes:20000,cleanupId};f.batch.actions.unshift(action,{id:cleanupId,kind:'cleanup',topLevel:false,launchHash:f.api.cleanupRecipeHash(f.batch.id,action),admissionHash:h,maxMs:1000,maxOutputBytes:10000});f.approve();
 const owner={runId:f.batch.owner.runId,generation:f.batch.owner.generation,actionId:id,role:'qualification-guardian'},identity={pid:50,creationIdentity:'guardian-50'},resource={owner,identity,launchHash:action.launchHash,createdAt:f.now()};await f.runner().withAuxiliary(recipe,{start:async()=>resource,stop:async()=>({...resource,exited:true,exitCode:0,outputComplete:true,completedAt:f.now()})},async()=>{throw Error('injected primary uncertainty');});
 const body={schemaVersion:2,kind:'campaign-recovery',campaignId:f.identity.id,batchId:f.batch.id,actionId:id,launchHash:action.launchHash,targetHash:f.identity.targetHash,owner:f.batch.owner,reconciled:true,rootExited:true,outputComplete:true,membershipEmpty:true,brokersReconciled:true,observation:{kind:'auxiliary-exit',launchHash:action.launchHash,owner,identity,createdAt:resource.createdAt,completedAt:f.now(),activeMs:0,exitCode:0,outputComplete:true},usage:{elapsedMs:0,outputBytes:0,status:'FAIL',evidenceKind:'fixture'}};
 const artifact=unwrap(await publishArtifact(f.store,(async function*(){yield Buffer.from(JSON.stringify(body));})(),{schemaVersion:1,id:randomUUID(),owner:f.batch.owner,actionId:id,mediaType:'application/json',secrets:[]}));unwrap(f.campaign.resolveUnknown(f.batch.id,id,{id:randomUUID(),evidence:[{id:artifact.id,sha256:artifact.sha256}]}));const row=unwrap(f.store.listQualifications()).find((entry:any)=>entry.kind==='CAMPAIGN_RESULT'&&entry.actionId===id);expect(row.payload.usage.outputBytes).toBe(action.maxOutputBytes);
});

it.each([true,false])('requires durable typed terminal ownership and both meters for successor batches: %s',async complete=>{
 const f=await fixture(),s=f.session();(f.batch as any).schemaVersion=3;f.approve();
 const adapters={...s.adapters,process:(capture:any)=>({...s.adapters.process(capture,()=>{}),drain:async()=>{const terminal=await s.seam.drain();if(complete){capture.processCompleted({kind:'root',identity:{pid:s.owned.pid,creationIdentity:s.owned.creationIdentity},activeMs:1});capture.processCompleted({kind:'helper',identity:{pid:s.owned.helperPid,creationIdentity:s.owned.helperCreationIdentity},activeMs:1});}return terminal;}})};
 const result=await f.runner().runSession(s.recipe,adapters);
 expect(f.calls).toEqual(['prepare','launch','initialize','thread','turn','fence','drain','brokers']);
 expect(result.status).toBe(complete?'PASS':'FAIL');expect(result.unknown).toBe(!complete);
 if(complete){const terminal=loadCampaignTerminal(f.store,f.batch,s.actions[0],result.evidence);expect(terminal.resource.kind).toBe('owned-execution');expect(terminal.processMeters).toHaveLength(2);}else expect(result.evidence.some((ref:any)=>ref.category==='terminal-observation')).toBe(false);
});
