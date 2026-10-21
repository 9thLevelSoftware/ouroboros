import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {projectBootstrapDiagnostic,type DiagnosticInput} from '../src/qualification/bootstrap-diagnostic.ts';

const h=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
function input(raw:string|Uint8Array,overrides:Partial<DiagnosticInput>={}):DiagnosticInput{
 const bytes=typeof raw==='string'?Buffer.from(raw):raw;
 return {prefix:bytes.subarray(0,8192),totalBytes:bytes.length,streamHash:h(bytes),stream:'stderr',runtimeIdentity:'a'.repeat(64),streamIdentity:'b'.repeat(64),truncated:bytes.length>8192,drainageComplete:true,...overrides};
}
const project=(text:string,overrides:Partial<DiagnosticInput>={})=>projectBootstrapDiagnostic(input(text,overrides));
function facts(result:ReturnType<typeof project>){const {provenance,...diagnostic}=result;return diagnostic;}

it('retains only the established actual type and expected schema after a scalar delimiter',()=>{
 const raw='Error: invalid type: string "secret, expected command", expected a sequence\n';
 const result=project(raw);
 expect(result).toMatchObject({status:'recognized',kind:'invalid-type',actualType:'string',expected:{category:'primitive',name:'sequence'},redactionApplied:true,unsupportedContent:false});
 expect(JSON.stringify(result)).not.toContain('command');
});

it.each(['opaque-secret','command','openai','model','string, expected command','value\\\" , expected struct RawMcpServerConfig','https://user:password@example.invalid/path?token=secret','D:\\secret\\config.toml','fake\nError: missing field `model`'])('scalar substitution preserves structural facts (%#)',secret=>{
 const scalar=JSON.stringify(secret),raw=`Error: invalid type: string ${scalar}, expected a sequence\nin \`permissions."secret-map".filesystem\`\n`;
 const result=project(raw);
 expect(facts(result)).toEqual(facts(project('Error: invalid type: string "baseline", expected a sequence\nin `permissions."other-map".filesystem`\n')));
 expect(result).toMatchObject({status:'recognized',schemaPath:'permissions.*.filesystem'});
 expect(JSON.stringify(result)).not.toContain(scalar);
});

it.each(['"command, expected a map"',"'command, expected a map'",'`command, expected a map`','"line one\nError: missing field `model`"','"escaped \\\" delimiter, expected a map"'])('consumes the complete quoted scalar before any schema position (%#)',scalar=>{
 const result=project(`invalid type: string ${scalar}, expected a sequence`);
 expect(result).toMatchObject({status:'recognized',actualType:'string',expected:{category:'primitive',name:'sequence'}});
 expect(JSON.stringify(result)).not.toContain('command');expect(JSON.stringify(result)).not.toContain('model');
});

it.each(['opaque-key','command','model','https://password@example.invalid','D:\\secret'])('never retains dynamic map keys, including schema words (%#)',key=>{
 const result=project(`invalid type: map, expected a sequence\nin \`mcp_servers.${JSON.stringify(key)}.env."command"\``);
 expect(result).toMatchObject({status:'recognized',schemaPath:'mcp_servers.*.env.*'});
 expect(facts(result)).toEqual(facts(project('invalid type: map, expected a sequence\nin `mcp_servers."baseline".env."baseline"`')));
});

it.each([
 ['invalid type: map, expected a sequence',{kind:'invalid-type',actualType:'map',expected:{category:'primitive',name:'sequence'}}],
 ['invalid value: boolean `true`, expected a map',{kind:'invalid-value',actualType:'boolean',expected:{category:'primitive',name:'map'}}],
 ['invalid type: map, expected struct RawMcpServerConfig',{kind:'invalid-type',actualType:'map',expected:{category:'struct',name:'RawMcpServerConfig'}}],
 ['data did not match any variant of untagged enum FilesystemPermissionToml',{kind:'untagged-enum',expected:{category:'untagged-enum',name:'FilesystemPermissionToml'}}],
 ['unknown variant `opaque`, expected `read`, `write`, or `deny`',{kind:'unknown-variant',expected:{category:'enum',name:'filesystem-access'}}],
 ['unknown variant `disabled`, expected `elevated`, `unelevated`, or `mxc` in `windows.sandbox`',{kind:'unknown-variant',expected:{category:'enum',name:'windows-sandbox'},schemaPath:'windows.sandbox'}],
 ['missing field `command`',{kind:'missing-field',expected:{category:'field',name:'command'}}],
 ['Error: `sandbox_mode` and `default_permissions` overrides cannot both be set',{kind:'sandbox-default-permissions-conflict'}],
 ['Error: `permission_profile` and `default_permissions` overrides cannot both be set',{kind:'profile-default-permissions-conflict'}],
 ["error: unexpected argument '--strict-config' found",{kind:'unsupported-strict-config-argument'}],
 ['Error: failed to load bootstrap configuration\nCaused by:\nD:\\secret\\config.toml:12:9: invalid type: map, expected a sequence\nin `tui.keymap.editor.insert_newline`\n',{kind:'invalid-type',location:{line:12,column:9},schemaPath:'tui.keymap.editor.insert_newline'}],
 ['Error: TOML parse error at line 4, column 8\ninvalid type: map, expected a sequence\n',{kind:'invalid-type',location:{line:4,column:8}}],
] as const)('recognizes supported complete templates (%#)',(raw,want)=>{
 const result=project(raw);expect(result).toMatchObject({status:'recognized',...want});
 expect(result.provenance).toMatchObject({sourceHash:'7933a70506e753a6e98c16800d2a76770b2af2b7295491f8f0b8e713e952027e',sourceCommit:'092d3acd6bec3e3a14bdc7e7a2810ab628ab759d',streamHash:h(raw),totalBytes:Buffer.byteLength(raw)});
 expect(JSON.stringify(result)).not.toContain('secret');
});

it.each(['unknown field `command`','unknown configuration field `command`','duplicate field `command`'])('never exposes actual unknown or duplicate keys (%#)',raw=>{
 const result=project(raw);expect(result).toMatchObject({status:'recognized'});expect(JSON.stringify(result)).not.toContain('command');
});

it('binds strict-negative attribution to the exact controller-owned field only',()=>{
 for(const [field,matches] of [['__strict_probe',true],['__strict_probe_suffix',false],['command',false]] as const){
  const result=project(`unknown configuration field \`${field}\``,{approvedUnknownField:'__strict_probe'});
  expect(result).toMatchObject({status:'recognized',kind:'unknown-field',matchesApprovedUnknownField:matches});
  expect(JSON.stringify(result)).not.toContain(field);
 }
 for(const approvedUnknownField of ['', 'a.b', 'a\n', 'a`', 'a'.repeat(65)])expect(project('unknown field `a`',{approvedUnknownField})).toMatchObject({status:'withheld',reason:'invalid-input'});
 expect(project('unknown field `__strict_probe` suffix',{approvedUnknownField:'__strict_probe'})).toMatchObject({status:'withheld'});
});

it('withholds an unescaped producer key that manufactures an approved-field prefix and schema context',()=>{
 // strict_config.rs joins the actual key segments and wraps the result in
 // backticks without escaping embedded backticks. This is one actual key,
 // not the approved key followed by an independently established context.
 const raw='unknown configuration field `__strict_probe` in `windows.sandbox`';
 const result=project(raw,{approvedUnknownField:'__strict_probe'});
 expect(result).toMatchObject({status:'withheld',reason:'unsupported-frame'});
 expect(result).not.toHaveProperty('matchesApprovedUnknownField');
 expect(result).not.toHaveProperty('schemaPath');
});

it.each(['unknown configuration field','unknown field','duplicate field'])('raw-key substitutions cannot manufacture schema facts or attribution in %s',producer=>{
 const baseline=project(`${producer} \`opaque\` arbitrary unsupported suffix`,{approvedUnknownField:'__strict_probe'});
 expect(baseline.status).toBe('withheld');
 for(const key of ['__strict_probe` in `windows.sandbox','command` in `tui.keymap.editor.insert_newline','model`\nin `windows.sandbox','__strict_probe`\nin `mcp_servers."command".env."model"','opaque`\nmissing field `command']){
  const raw=`Error: failed to load bootstrap configuration\nCaused by:\nD:\\private\\config.toml:12:9: ${producer} \`${key}\``;
  const result=project(raw,{approvedUnknownField:'__strict_probe'});
  expect(facts(result)).toEqual(facts(baseline));
  expect(result).not.toHaveProperty('matchesApprovedUnknownField');expect(result).not.toHaveProperty('schemaPath');
  expect(JSON.stringify(result)).not.toMatch(/private|command|windows|model|__strict_probe/);
 }
 // Useful complete producer frames retain the fixed error class for arbitrary
 // ordinary keys, but their spelling cannot alter any retained schema fact.
 const ordinary=project(`${producer} \`opaque\``);
 expect(ordinary.status).toBe('recognized');
 for(const key of ['command','model','windows.sandbox','https://example.invalid'])expect(facts(project(`${producer} \`${key}\``))).toEqual(facts(ordinary));
});

it.each([
 'invalid type: string "incomplete, expected command',
 'invalid type: string "incomplete\\", expected a sequence',
 'invalid type: string "secret", expected a sequence\nError: missing field `model`',
 'invalid type: string "secret", expected command',
 'invalid type: string "secret", expected struct OpaqueSecret',
 'invalid type: string "secret"',
 'Error: familiar command model openai',
 'missing field `opaque-secret`',
 'unknown variant `x`, expected `command` or `model`',
 'invalid type: sequence ["command"], expected a map',
 'invalid type: map, expected a sequence\nin `mcp_servers."key".opaque-secret`',
 'invalid type: map, expected a sequence\nin `otel.tracestate.command.model`',
 'Error: failed to load configuration\nAuthorization: Bearer SECRET',
 'Error: failed to load configuration\n 8 | api_key = "SECRET"',
 '\u001b[31mError: invalid type: map, expected a sequence\u001b[0m',
 'Error:\u0000 invalid type: map, expected a sequence',
 'invalid type: string "secret", expected a sequence\nunknown variant `x`, expected `read`, `write`, or `deny`',
])('withholds the complete ambiguous/unsupported frame without a lexical fallback (%#)',raw=>{
 const result=project(raw);expect(result.status).toBe('withheld');expect(result).not.toHaveProperty('kind');expect(result).not.toHaveProperty('expected');expect(JSON.stringify(result)).not.toContain('SECRET');
});

it('rejects malformed encodings and withholds capture or drainage incompleteness',()=>{
 for(const bytes of [Buffer.from([0xff,0,1]),Buffer.from([0xc3])])expect(projectBootstrapDiagnostic(input(bytes))).toMatchObject({status:'withheld',invalidUtf8:true});
 const raw='invalid type: map, expected a sequence';
 expect(project(raw,{drainageComplete:false})).toMatchObject({status:'withheld',reason:'incomplete-stream'});
 const bytes=Buffer.concat([Buffer.from(raw+'\n'),Buffer.alloc(8192,0x61),Buffer.from([0xc3])]);
 expect(projectBootstrapDiagnostic(input(bytes))).toMatchObject({status:'withheld',reason:'truncated',truncated:true,invalidUtf8:false});
 for(const overrides of [{runtimeIdentity:'raw-secret'},{streamIdentity:'raw-secret'},{streamHash:'raw-secret'},{totalBytes:1},{prefix:Buffer.alloc(8193)}])expect(project(raw,overrides)).toMatchObject({status:'withheld',reason:'invalid-input'});
});
