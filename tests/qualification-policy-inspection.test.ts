import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {ChildOutput,LaunchSpec,OwnedExecution,Supervisor,WindowsDrainEvidenceSchema} from '../src/contracts/execution.ts';
import type {z} from 'zod';
const catalog=[{key:'plugins',stage:'experimental'},{key:'hooks',stage:'under development'},{key:'apps',stage:'stable'},{key:'old_feature',stage:'deprecated'},{key:'gone',stage:'removed'}];
const listing=()=>Buffer.from(catalog.map(f=>`${f.key.padEnd(24)} ${f.stage.padEnd(20)} false`).join('\n')+'\n');
async function module(){const files=import.meta.glob('../src/qualification/policy-inspection.ts');expect(Object.keys(files)).toHaveLength(1);return await files['../src/qualification/policy-inspection.ts']() as typeof import('../src/qualification/policy-inspection.ts');}
beforeEach(()=>vi.useFakeTimers({now:1000}));afterEach(()=>vi.useRealTimers());
function fixture(options:{stdout?:Buffer;stderr?:Buffer;stderrChunks?:Buffer[];drainStderr?:Buffer;drainExtra?:Buffer;exitCode?:number|null;omitExit?:boolean;drainFailure?:boolean;renewFailure?:boolean;invalidOwner?:boolean;incompleteDrain?:boolean;outputAt?:number}={}){
 const spec:LaunchSpec={runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'22222222-2222-4222-8222-222222222222',role:'qualification-policy-inspection',executable:'C:\\pinned\\codex.exe',argv:['-c','features.plugins=false','-c','features.hooks=false','-c','features.apps=false','-c','notify=[]','-c','web_search="disabled"','-c','model_provider="openai"','-c','forced_login_method="chatgpt"','-c','windows.sandbox="mxc"','-c','default_permissions="inspection"','-c','permissions.inspection={"filesystem"={":minimal"="read","D:\\\\fixture\\\\workspace"="write"},"network"={"enabled"=false,"allow_local_binding"=false,"allow_upstream_proxy"=false,"dangerously_allow_all_unix_sockets"=false,"dangerously_allow_non_loopback_proxy"=false,"domains"={}}}','-c','sqlite_home="D:\\\\fixture\\\\runtime-state"','-c','model="gpt-6-astra"','features','list'],cwd:'D:\\fixture\\workspace',env:{SystemRoot:'C:\\Windows'},boundaryHash:'a'.repeat(64),authorization:{kind:'qualification',requestId:'33333333-3333-4333-8333-333333333333',probeId:'auxiliary.preparation',fixtureRoots:['D:\\fixture']},stdin:'closed',leaseTtlMs:10000,deadline:31000};
 const owner={runId:spec.runId,generation:spec.generation,actionId:spec.actionId,role:spec.role};
 const receipt={schemaVersion:1 as const,...owner,environment:'windows' as const,pid:10,creationIdentity:'root-10',helperPid:11,helperCreationIdentity:'helper-11',jobIdentity:'job-1',boundaryHash:spec.boundaryHash,assignedBeforeResume:true as const,capturedAt:1000,...(options.invalidOwner?{actionId:'44444444-4444-4444-8444-444444444444'}:{})};
 const listeners=new Set<(output:ChildOutput)=>void>();let scheduled=false;
 const emit=(stream:'stdout'|'stderr',data:Buffer)=>{for(const listener of listeners)listener({stream,data});};
 const drain: z.infer<typeof WindowsDrainEvidenceSchema>={schemaVersion:1,...owner,reason:'root_exit',requestAcknowledged:false,requestedAt:1000,acknowledgedAt:null,rootExited:true,rootExitedAt:1001,...(options.omitExit?{}:{rootExitCode:options.exitCode===undefined?0:options.exitCode}),membershipEmpty:true,membershipObservedAt:1001,activeProcesses:0,unresolvedExecutions:[],outputComplete:true,unresolvedOutputStreams:[],outputCompletedAt:1001,childRanBeforeAssignment:false,completedAt:1001,...(options.incompleteDrain?{rootExited:false,rootExitedAt:null,rootExitCode:null,membershipEmpty:false,activeProcesses:1,unresolvedExecutions:[10]}:{})};
 const execution:OwnedExecution={describe:vi.fn(async()=>receipt),fence:vi.fn(async()=>{}),renewLease:vi.fn(async()=>{if(options.renewFailure)throw Error('SECRET_RENEW_ERROR');}),drain:vi.fn(async()=>{if(options.drainExtra)emit('stdout',options.drainExtra);if(options.drainStderr)emit('stderr',options.drainStderr);if(options.drainFailure)throw Error('SECRET_DRAIN_ERROR');return drain;}),onOutput:vi.fn(listener=>{listeners.add(listener);if(!scheduled){scheduled=true;setTimeout(()=>{if(options.stdout!==undefined)emit('stdout',options.stdout);if(options.stderr)emit('stderr',options.stderr);for(const chunk of options.stderrChunks??[])emit('stderr',chunk);},options.outputAt??1);}return()=>{listeners.delete(listener);};}),writeInput:vi.fn(async()=>({ok:true,value:undefined})),endInput:vi.fn(async()=>({ok:true,value:undefined}))};
 const supervisor:Supervisor={launchOwned:vi.fn(async()=>({ok:true,value:execution}))};const gate=vi.fn(()=>true);
 return {spec,receipt,drain,execution,supervisor,gate,input:{supervisor,spec,expectedCatalog:catalog,authorizeCurrent:gate,now:()=>Date.now(),maxOutputBytes:8192,renewalMs:100}};
}
async function settle<T>(promise:Promise<T>,ms=40000):Promise<T>{await vi.advanceTimersByTimeAsync(ms);return await promise;}

it.each(['invalid-toml','missing-profile-control','quoted-mcp-key','duplicate-control'])('refuses structurally unsafe %s before supervisor or authority calls',async fault=>{
 const m=await module(),f=fixture({stdout:listing()});const at=f.spec.argv.findIndex(value=>value.startsWith('permissions.inspection='));
 if(fault==='invalid-toml')f.spec.argv[at]='permissions.inspection={"filesystem":{}}';
 if(fault==='missing-profile-control')f.spec.argv[at]='permissions.inspection={"filesystem"={":minimal"="read","D:\\\\fixture\\\\workspace"="write"},"network"={"enabled"=false}}';
 if(fault==='quoted-mcp-key')f.spec.argv.splice(-2,0,'-c','mcp_servers."opaque-key".enabled=false');
 if(fault==='duplicate-control')f.spec.argv.splice(-2,0,'-c','features.plugins=false');
 const result=await m.runPolicyInspection(f.input);expect(result.status).toBe('REFUSED');expect(result.reasonCode).toBe('INVALID_INSPECTION_RECIPE');
 expect(f.supervisor.launchOwned).not.toHaveBeenCalled();expect(f.gate).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('opaque-key');
});

it('does not parse an expected-schema delimiter inside a quoted scalar',async()=>{
 const m=await module(),f=fixture({stderr:Buffer.from('Error: invalid type: string "secret, expected command", expected a sequence\n')}),r=await settle(m.runPolicyInspection(f.input),1000);
 expect(r.stderrDiagnostic.message).toBe('invalid type: string [redacted], expected a sequence');
 expect(r.stderrDiagnostic.message).not.toContain('command');
});

it('strictly parses the complete padded catalog without returning any raw lines',async()=>{
 const m=await module(),r=m.parseFeatureListing(listing(),catalog);expect(r.ok).toBe(true);if(!r.ok)throw Error('expected listing');expect(r.value.features).toEqual({plugins:false,hooks:false,apps:false,old_feature:false,gone:false});expect(r.value.stdoutHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(r)).not.toContain('under development');
});
it.each(['missing','duplicate','unknown','stage','bool','newline','utf8','enabled'] as const)('rejects %s feature output',async kind=>{
 const m=await module();let bytes=listing();if(kind==='missing')bytes=Buffer.from(bytes.toString().split('\n').slice(1).join('\n'));if(kind==='duplicate')bytes=Buffer.concat([bytes,bytes.subarray(0,bytes.indexOf(10)+1)]);if(kind==='unknown')bytes=Buffer.from(bytes.toString().replace('gone','SECRET_UNKNOWN_FEATURE'));if(kind==='stage')bytes=Buffer.from(bytes.toString().replace('experimental','stable'));if(kind==='bool')bytes=Buffer.from(bytes.toString().replace('false','False'));if(kind==='newline')bytes=bytes.subarray(0,-1);if(kind==='utf8')bytes=Buffer.concat([Buffer.from([0xc3,0x28]),bytes]);if(kind==='enabled')bytes=Buffer.from(bytes.toString().replace('false','true'));const r=m.parseFeatureListing(bytes,catalog);expect(r.ok).toBe(false);expect(JSON.stringify(r)).not.toContain('SECRET_UNKNOWN_FEATURE');
});
it('waits the short grace then always fences/drains the exact diagnostic without stdin or RPC',async()=>{
 const m=await module(),f=fixture({stdout:listing()}),result=await settle(m.runPolicyInspection(f.input),1000);expect(result.status).toBe('PASS');expect(result.ownership).toEqual(f.receipt);expect(result.drain).toEqual(f.drain);expect(result.stdoutBytes).toBe(listing().length);expect(f.execution.fence).toHaveBeenCalledTimes(1);expect(f.execution.drain).toHaveBeenCalledTimes(1);expect(f.execution.writeInput).not.toHaveBeenCalled();expect(f.execution.endInput).not.toHaveBeenCalled();expect(f.gate).toHaveBeenCalledTimes(2);
});
it.each([1,null,undefined])('never accepts missing/null/nonzero root exit code %s',async exitCode=>{
 const m=await module(),f=fixture({stdout:listing(),exitCode,omitExit:exitCode===undefined}),r=await settle(m.runPolicyInspection(f.input),1000);expect(r.status).toBe('FAIL');expect(r.reasonCode).toBe('ROOT_EXIT_UNCONFIRMED');
});
it('waits the original deadline on empty output and still drains',async()=>{
 const m=await module(),f=fixture(),pending=m.runPolicyInspection(f.input);await vi.advanceTimersByTimeAsync(29999);expect(f.execution.drain).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(2);const r=await pending;expect(r.status).toBe('FAIL');expect(r.reasonCode).toBe('INSPECTION_DEADLINE');expect(f.execution.drain).toHaveBeenCalledTimes(1);
});
it('rejects an extra fragment received during drainage and finalizes the final output',async()=>{
 const m=await module(),f=fixture({stdout:listing(),drainExtra:Buffer.from('SECRET_TRAILING_FRAGMENT')}),r=await settle(m.runPolicyInspection(f.input),1000);expect(r.status).toBe('FAIL');expect(r.stdoutBytes).toBe(listing().length+24);expect(JSON.stringify(r)).not.toContain('SECRET_TRAILING_FRAGMENT');
});
it('stops promptly on malformed output, stderr, and raw overflow while counting terminal bytes',async()=>{
 const m=await module();for(const which of ['malformed','stderr','overflow']){const f=fixture({stdout:which==='malformed'?Buffer.from('SECRET_BAD_LINE\n'):listing(),...(which==='stderr'?{stderr:Buffer.from('SECRET_STDERR')}:{}),drainExtra:Buffer.from('x')});if(which==='overflow')f.input.maxOutputBytes=10;const r=await settle(m.runPolicyInspection(f.input),1000);expect(r.status).toBe('FAIL');expect(JSON.stringify(r)).not.toContain('SECRET_');expect(f.execution.fence).toHaveBeenCalledTimes(1);expect(f.execution.drain).toHaveBeenCalledTimes(1);}
});
it('fails renewal and unknown drainage without leaking thrown diagnostics',async()=>{
 const m=await module(),f=fixture({renewFailure:true}),r=await settle(m.runPolicyInspection(f.input),1000);expect(r.status).toBe('FAIL');expect(r.reasonCode).toBe('LEASE_RENEWAL_FAILED');
 const g=fixture({stdout:listing(),drainFailure:true}),unknown=await settle(m.runPolicyInspection(g.input),1000);expect(unknown.status).toBe('UNKNOWN');expect(JSON.stringify([r,unknown])).not.toContain('SECRET_');
});
it('refuses unapproved/nonfixed launch and fails stale final authority while cleaning the owned execution',async()=>{
 const m=await module(),f=fixture({stdout:listing()});f.gate.mockReturnValue(false);expect((await m.runPolicyInspection(f.input)).status).toBe('REFUSED');expect(f.supervisor.launchOwned).not.toHaveBeenCalled();
 const g=fixture({stdout:listing()});g.spec.argv.push('exec');expect((await m.runPolicyInspection(g.input)).status).toBe('REFUSED');expect(g.supervisor.launchOwned).not.toHaveBeenCalled();
 const h=fixture({stdout:listing()});h.gate.mockReturnValueOnce(true).mockReturnValue(false);expect((await settle(m.runPolicyInspection(h.input),1000)).status).toBe('FAIL');expect(h.execution.drain).toHaveBeenCalledTimes(1);
});
it('requires the matching Windows owner and complete empty Job/output evidence',async()=>{
 const m=await module();for(const opts of [{invalidOwner:true},{incompleteDrain:true}]){const f=fixture({stdout:listing(),...opts}),r=await settle(m.runPolicyInspection(f.input),1000);expect(r.status).toBe('UNKNOWN');expect(f.execution.drain).toHaveBeenCalledTimes(1);}
});

it('accepts only exact pinned dotted feature keys',async()=>{
 const m=await module(),extended=[...catalog,{key:'guardianv2.thread_context',stage:'experimental'}],bytes=Buffer.concat([listing(),Buffer.from('guardianv2.thread_context  experimental  false\n')]);
 const result=m.parseFeatureListing(bytes,extended);expect(result.ok).toBe(true);if(result.ok)expect(result.value.features['guardianv2.thread_context']).toBe(false);
 expect(m.parseFeatureListing(Buffer.from(bytes.toString().replace('guardianv2.thread_context','guardianv2.other')),extended).ok).toBe(false);
});

it('reconciles a fence acknowledgment lost to exact natural terminal drainage and preserves nonterminal failure',async()=>{
 const m=await module(),f=fixture({stdout:listing()});vi.mocked(f.execution.fence).mockRejectedValue(Error('Execution completed before control acknowledgment'));
 const safe=await settle(m.runPolicyInspection(f.input),1000);expect(safe.status).toBe('PASS');expect(safe.fenceReconciledByTerminal).toBe(true);expect(f.execution.fence).toHaveBeenCalledTimes(1);expect(f.execution.drain).toHaveBeenCalledTimes(1);
 const g=fixture({stdout:listing()});g.drain.reason='policy_inspection_stop';vi.mocked(g.execution.fence).mockRejectedValue(Error('SECRET_FENCE_ERROR'));
 const failed=await settle(m.runPolicyInspection(g.input),1000);expect(failed.status).toBe('FAIL');expect(failed.reasonCode).toBe('FENCE_FAILED');expect(failed.fenceReconciledByTerminal).toBeUndefined();expect(JSON.stringify(failed)).not.toContain('SECRET_FENCE_ERROR');
});

it('retains unknown launch failures and cleans a late owned handle without retrying',async()=>{
 const m=await module(),f=fixture();vi.mocked(f.supervisor.launchOwned).mockResolvedValue({ok:false,error:{code:'SECRET_NATIVE_ERROR',message:'SECRET_NATIVE_MESSAGE',evidenceIds:[]}});
 const failed=await m.runPolicyInspection(f.input);expect(failed.status).toBe('UNKNOWN');expect(failed.recoveryRequiresApproval).toBe(true);expect(JSON.stringify(failed)).not.toContain('SECRET_');
 const g=fixture();vi.mocked(g.supervisor.launchOwned).mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true,value:g.execution}),30001)));
 const late=await settle(m.runPolicyInspection(g.input),31000);expect(late.status).toBe('UNKNOWN');expect(g.supervisor.launchOwned).toHaveBeenCalledTimes(1);expect(g.execution.fence).toHaveBeenCalledTimes(1);expect(g.execution.drain).toHaveBeenCalledTimes(1);
});

it.each([
 ['Error: invalid type: map, expected a sequence\n','invalid type: map, expected a sequence','invalid-type'],
 ['Error: failed to load bootstrap configuration\ninvalid type: string "opaque-secret", expected struct RawMcpServerConfig\nin `mcp_servers."opaque-key"`\n','invalid type: string [redacted], expected struct RawMcpServerConfig\nin `mcp_servers.*`','invalid-type'],
 ['Error: `sandbox_mode` and `default_permissions` overrides cannot both be set\n','`sandbox_mode` and `default_permissions` overrides cannot both be set','sandbox-default-permissions-conflict'],
 ["error: unexpected argument '--strict-config' found\n","unexpected argument '--strict-config' found",'unsupported-strict-config-argument'],
] as const)('persists useful typed projections without changing stderr failure classification (%#)',async(raw,message,kind)=>{
 const m=await module(),f=fixture({stderr:Buffer.from(raw)}),result=await settle(m.runPolicyInspection(f.input),1000);
 expect(result.status).toBe('FAIL');expect(result.reasonCode).toBe('UNEXPECTED_STDERR');expect(result.stderrDiagnostic.message).toBe(message);
 expect(result.stderrDiagnostic.bootstrapDiagnostic).toMatchObject({status:'recognized',kind,provenance:{streamHash:createHash('sha256').update(raw).digest('hex'),totalBytes:Buffer.byteLength(raw),semantics:'diagnostic-only'}});
 const persisted=JSON.parse(JSON.stringify(result));expect(persisted.stderrDiagnostic.bootstrapDiagnostic.status).toBe('recognized');expect(JSON.stringify(persisted)).not.toContain('opaque-');
});

it('is invariant across byte partitions including split UTF-8 and drainage, with no dynamic names retained',async()=>{
 const m=await module(),raw=Buffer.from('Error: failed to load bootstrap configuration\ninvalid type: string "é, expected command", expected a sequence\nin `mcp_servers."model".env."command"`\n');
 const whole=await settle(m.runPolicyInspection(fixture({stderr:raw}).input),1000);
 const cuts=[0,1,22,raw.indexOf(0xc3)+1,raw.length-1,raw.length];
 // A zero-byte prefix needs complete stdout to reach cleanup; otherwise the
 // process correctly waits its deadline before terminal output is requested.
 for(const cut of cuts){const f=fixture({stdout:listing(),stderrChunks:[raw.subarray(0,cut)],drainStderr:raw.subarray(cut)}),result=await settle(m.runPolicyInspection(f.input),1000);
  expect(result.stderrHash).toBe(whole.stderrHash);expect(result.stderrBytes).toBe(raw.length);expect(result.stderrDiagnostic).toEqual(whole.stderrDiagnostic);
  expect(result.stderrDiagnostic.invalidUtf8).toBe(false);expect(JSON.stringify(result.stderrDiagnostic)).not.toContain('command');
 }
 expect(whole.stderrDiagnostic.message).toBe('invalid type: string [redacted], expected a sequence\nin `mcp_servers.*.env.*`');
});

it.each([
 'Error: invalid type: string "secret", expected a sequence\nError: missing field `command`\n',
 'Error: failed to load configuration\nAuthorization: Bearer opaque-token\n',
 'invalid type: map, expected a sequence\nin `otel.tracestate.command.model`\n',
 'invalid type: string "unterminated, expected command',
 'unknown configuration field `__strict_probe` in `windows.sandbox`',
 '\u001b[31mError: invalid type: map, expected a sequence\u001b[0m',
])('persists withholding for an unsupported complete frame (%#)',async raw=>{
 const m=await module(),result=await settle(m.runPolicyInspection(fixture({stderr:Buffer.from(raw)}).input),1000);
 expect(result.reasonCode).toBe('UNEXPECTED_STDERR');expect(result.stderrDiagnostic.message).toBe('[stderr withheld]');expect(result.stderrDiagnostic.bootstrapDiagnostic.status).toBe('withheld');expect(result.stderrDiagnostic.unsupportedContent).toBe(true);
 expect(JSON.stringify(result.stderrDiagnostic)).not.toMatch(/opaque-|command|tracestate|secret/);
});

it('withholds invalid original UTF-8 without replacement text',async()=>{
 const m=await module();for(const bytes of [Buffer.from([0xc3]),Buffer.from([0xff,0x00,0x01])]){const result=await settle(m.runPolicyInspection(fixture({stderr:bytes}).input),1000);expect(result.stderrDiagnostic).toMatchObject({invalidUtf8:true,redactionApplied:true,message:'[stderr withheld]'});}
});

it('caps capture at 8192 bytes while hashing and counting every later drainage byte',async()=>{
 const m=await module(),raw=Buffer.from('Error: invalid type: string "'+('opaque-overflow-value '.repeat(3000))),tail=Buffer.from('opaque-tail'),f=fixture({stderr:raw,drainStderr:tail});f.drain.reason='policy_inspection_stop';f.drain.rootExitCode=1;
 const result=await settle(m.runPolicyInspection(f.input),1000);expect(result.status).toBe('FAIL');expect(result.reasonCode).toBe('OUTPUT_LIMIT');
 expect(result.stderrDiagnostic).toMatchObject({truncated:true,message:'[stderr withheld]',bootstrapDiagnostic:{status:'withheld',reason:'truncated'}});expect(result.stderrDiagnostic.message.length).toBeLessThanOrEqual(4096);
 expect(result.stderrBytes).toBe(raw.length+tail.length);expect(result.stderrHash).toBe(createHash('sha256').update(raw).update(tail).digest('hex'));expect(JSON.stringify(result)).not.toContain('opaque-');
});

it('marks capture truncation without misclassifying a valid split UTF-8 cap tail',async()=>{
 const m=await module(),raw=Buffer.concat([Buffer.alloc(8191,0x61),Buffer.from('é')]),f=fixture({stderr:raw});f.input.maxOutputBytes=262144;
 const result=await settle(m.runPolicyInspection(f.input),1000);expect(result.reasonCode).toBe('UNEXPECTED_STDERR');expect(result.stderrDiagnostic).toMatchObject({truncated:true,invalidUtf8:false,message:'[stderr withheld]'});
});

it('withholds otherwise supported stderr when complete drainage was not established',async()=>{
 const m=await module(),f=fixture({stderr:Buffer.from('invalid type: map, expected a sequence\n'),incompleteDrain:true}),result=await settle(m.runPolicyInspection(f.input),1000);
 expect(result.status).toBe('UNKNOWN');expect(result.outputComplete).toBe(false);expect(result.stderrDiagnostic.bootstrapDiagnostic).toMatchObject({status:'withheld',reason:'incomplete-stream'});expect(result.stderrDiagnostic.message).toBe('[stderr withheld]');
});

