import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { buildCodexLaunchConfig, encodeCodexConfigValue, prevalidateCodexLaunchArgv, restrictedCodexOverrides, CODEX_CONFIG_SCHEMA, type CodexLaunchConfigInput, type CodexOverride, type CodexConfigValue } from '../src/providers/codex/launch-config.ts';

const profile = {filesystem:{':minimal':'read','C:\\work':'write','C:\\controller':'deny'},network:{enabled:false,allow_local_binding:false,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains:{}}};
function input(entryPoint:CodexLaunchConfigInput['entryPoint']='features'):CodexLaunchConfigInput {
 return {entryPoint,schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name:'ouroboros_worker'},overrides:[
  {key:'windows.sandbox',value:'mxc'},{key:'permissions.ouroboros_worker',value:structuredClone(profile)},
  ...(entryPoint==='verifier'?[]:[{key:'default_permissions',value:'ouroboros_worker'}]),
  {key:'features.plugins',value:false},{key:'features.apps',value:false},{key:'features.hooks',value:false},
  {key:'notify',value:[]},{key:'web_search',value:'disabled'},
  ...['browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','remote_control'].map(key=>({key:`features.${key}`,value:false})),
  {key:'approval_policy',value:'on-request'},{key:'model_provider',value:'openai'},{key:'forced_login_method',value:'chatgpt'},
  {key:'model',value:'gpt-6-astra'},{key:'model_reasoning_effort',value:'ultra'},{key:'sqlite_home',value:'C:\\state'},
 ]},...(entryPoint==='verifier'?{verifier:{cwd:'C:\\work',command:['C:\\node.exe','C:\\driver.mjs','allowed_edit','C:\\fixture']}}:{})};
}
function accepted(value:CodexLaunchConfigInput){const result=buildCodexLaunchConfig(value);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.code);return result.value;}
function rejected(value:CodexLaunchConfigInput,code:string){const result=buildCodexLaunchConfig(value);expect(result).toMatchObject({ok:false,error:{code}});expect(JSON.stringify(result)).not.toContain('SECRET');}

describe('offline Codex launch configuration',()=>{
 it('restriction recipe explicitly disables supported browser computer and remote surfaces before startup',()=>{
  const overrides=restrictedCodexOverrides({profileName:'ouroboros_worker',profile,defaultPermissions:true});
  for(const key of ['browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','remote_control'])expect(overrides).toContainEqual({key:`features.${key}`,value:false});
  expect(overrides).toContainEqual({key:'approval_policy',value:'on-request'});
  expect(buildCodexLaunchConfig({entryPoint:'worker',schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name:'ouroboros_worker'},overrides}}).ok).toBe(true);
 });
 it('builds canonical features argv from an explicit restricted baseline',()=>{
  const result=accepted(input());
  expect(result.argv.slice(0,6)).toEqual(['-c','windows.sandbox="mxc"','-c','permissions.ouroboros_worker={"filesystem"={":minimal"="read","C:\\\\work"="write","C:\\\\controller"="deny"},"network"={"enabled"=false,"allow_local_binding"=false,"allow_upstream_proxy"=false,"dangerously_allow_all_unix_sockets"=false,"dangerously_allow_non_loopback_proxy"=false,"domains"={}}}','-c','default_permissions="ouroboros_worker"']);
  expect(result.argv.slice(-2)).toEqual(['features','list']);
 });
 it.each(['metadata','worker','strict-positive'] as const)('uses the supported app-server flags for %s',entryPoint=>{
  const result=accepted(input(entryPoint));expect(result.argv.slice(0,5)).toEqual(['app-server','--strict-config','--stdio','-c','windows.sandbox="mxc"']);
  expect(result.permission).toMatchObject({kind:'named-profile',mechanism:'default-permissions',coverage:'requested'});
  expect(result.strict).toEqual({enabled:true,approvedUnknownField:false});
 });
 it('places sandbox profile flags after global overrides and command bytes after the separator',()=>{
  const result=accepted(input('verifier')),at=result.argv.indexOf('sandbox');
  expect(result.argv.slice(at)).toEqual(['sandbox','--include-managed-config','--permission-profile','ouroboros_worker','--cd','C:\\work','--','C:\\node.exe','C:\\driver.mjs','allowed_edit','C:\\fixture']);
  expect(result.argv).not.toContain('default_permissions="ouroboros_worker"');expect(result.argv).not.toContain('--strict-config');
  expect(result.permission.mechanism).toBe('sandbox-permission-profile');
 });
 it('injects exactly one valid-TOML unknown field into the identical accepted strict baseline',()=>{
  const positive=accepted(input('strict-positive')),negative=accepted(input('strict-negative'));
  expect(negative.argv).toEqual([...positive.argv,'-c','foo="bar"']);expect(parse(negative.argv.at(-1)!)).toEqual({foo:'bar'});
  expect(negative.configurationHash).toBe(positive.configurationHash);expect(negative.argvHash).not.toBe(positive.argvHash);
  expect(negative.strict.approvedUnknownField).toBe(true);expect(positive.strict.approvedUnknownField).toBe(false);
  expect(prevalidateCodexLaunchArgv({entryPoint:'strict-negative',schema:CODEX_CONFIG_SCHEMA,argv:negative.argv}).ok).toBe(true);
  expect(prevalidateCodexLaunchArgv({entryPoint:'strict-positive',schema:CODEX_CONFIG_SCHEMA,argv:negative.argv})).toMatchObject({ok:false,error:{code:'LAUNCH_CONFIG_SCHEMA_INVALID'}});
 });
 it.each(['version','sha256'] as const)('requires the harness structural contract identity %s',key=>{const candidate=input();candidate.schema={...CODEX_CONFIG_SCHEMA,[key]:'SECRET'};rejected(candidate,'LAUNCH_CONFIG_SCHEMA_IDENTITY');});
 it.each(['features.plugins','features.apps','features.hooks','notify','windows.sandbox','web_search'])('fails closed when %s is missing',key=>{
  const candidate=input();candidate.baseline.overrides=candidate.baseline.overrides.filter(item=>item.key!==key);rejected(candidate,'LAUNCH_CONFIG_REQUIRED_CONTROL');
 });
 it.each(['model_provider','forced_login_method'])('requires the explicit managed subscription restriction %s',key=>{
  const candidate=input();candidate.baseline.overrides=candidate.baseline.overrides.filter(item=>item.key!==key);rejected(candidate,'LAUNCH_CONFIG_SUBSCRIPTION_CONTROL');
 });
 it.each([{key:'web_search',value:'SECRET'},{key:'model_reasoning_effort',value:0},{key:'windows.sandbox',value:'SECRET'},{key:'forced_login_method',value:'SECRET'}])('validates schema-constrained override $key',override=>{
  const candidate=input();candidate.baseline.overrides=candidate.baseline.overrides.map(item=>item.key===override.key?override:item);rejected(candidate,'LAUNCH_CONFIG_SCHEMA_INVALID');
 });
 it('retains nonempty model-advertised reasoning effort without inventing an enum or entitlement',()=>{
  const candidate=input();candidate.baseline.overrides=candidate.baseline.overrides.map(item=>item.key==='model_reasoning_effort'?{key:item.key,value:'future-effort'}:item);
  expect(accepted(candidate).configuration.model_reasoning_effort).toBe('future-effort');
 });
 it.each(['sandbox_mode','sandbox_workspace_write','profile','profiles.legacy'])('rejects legacy permission/config profile mixing for %s',key=>{
  const candidate=input();candidate.baseline.overrides=[...candidate.baseline.overrides,{key,value:'SECRET'}];rejected(candidate,'LAUNCH_CONFIG_LEGACY_PERMISSION_CONFLICT');
 });
 it.each([{key:'features.apps',value:false},{key:'features',value:{apps:false}}])('rejects duplicate or parent-child overlap before interpreting $key',override=>{
  const candidate=input();candidate.baseline.overrides=[...candidate.baseline.overrides,override];rejected(candidate,'LAUNCH_CONFIG_DUPLICATE_OR_CONFLICTING_CONTROL');
 });
 it.each(['mcp_servers."SECRET".enabled','mcp_servers.a..enabled','features.__proto__','model=SECRET'])('refuses unsupported literal CLI path %s without echoing it',key=>{
  const candidate=input();candidate.baseline.overrides=[...candidate.baseline.overrides,{key,value:false}];rejected(candidate,'LAUNCH_CONFIG_KEY_UNSUPPORTED');
 });
 it.each([null,undefined,BigInt(1),new Date(),NaN,Infinity,-0,Number.MAX_SAFE_INTEGER+1,new Array(1)])('rejects unsupported TOML input %s rather than dropping it',value=>{
  expect(encodeCodexConfigValue(value as CodexConfigValue)).toMatchObject({ok:false,error:{code:'LAUNCH_CONFIG_VALUE_UNSUPPORTED'}});
 });
 it('round trips quoted Windows paths, equals signs, controls, arrays and inline tables through TOML',()=>{
  const value={path:'C:\\folder "quoted"\\file=one',text:'tab\tnewline\nbackspace\b',list:['one',true,3,0.25],empty:[]};
  const result=encodeCodexConfigValue(value);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.code);
  expect(parse(`value=${result.value}`).value).toEqual(value);
 });
 it.each(['filesystem','network','extends','unknown','mode','path'])('closes the permissive permission schema gap for %s',fault=>{
  const candidate=input();const selected=candidate.baseline.overrides.find(item=>item.key==='permissions.ouroboros_worker')!.value as any;
  if(fault==='filesystem')selected.filesystem['C:\\work']='SECRET';if(fault==='network')delete selected.network.enabled;
  if(fault==='extends')selected.extends=':workspace';if(fault==='unknown')selected.SECRET=true;if(fault==='mode')selected.network.proxy_url='SECRET';if(fault==='path')selected.filesystem.SECRET='write';
  rejected(candidate,fault==='mode'?'LAUNCH_CONFIG_NETWORK_CONTROL':'LAUNCH_CONFIG_PROFILE_INVALID');
 });
 it('rejects mismatched or multiple named profiles and sandbox/default selector conflicts',()=>{
  const mismatched=input();mismatched.baseline.permission.name='other';rejected(mismatched,'LAUNCH_CONFIG_PERMISSION_SELECTION');
  const multiple=input();multiple.baseline.overrides=[...multiple.baseline.overrides,{key:'permissions.other',value:profile}];rejected(multiple,'LAUNCH_CONFIG_PERMISSION_SELECTION');
  const sandbox=input('verifier');sandbox.baseline.overrides=[...sandbox.baseline.overrides,{key:'default_permissions',value:'ouroboros_worker'}];rejected(sandbox,'LAUNCH_CONFIG_PERMISSION_SELECTION');
 });
 it('does not infer an empty or complete effective MCP inventory from requested overrides',()=>{
  const absent=accepted(input());expect(absent.mcp).toEqual({requestedDisabledIds:[],effectiveState:'unknown',merge:'runtime-layers-unobserved'});
  const candidate=input();candidate.baseline.overrides=[...candidate.baseline.overrides,{key:'mcp_servers',value:{}}];expect(accepted(candidate).mcp.effectiveState).toBe('unknown');
  candidate.baseline.overrides=[...input().baseline.overrides,{key:'mcp_servers.bambu.enabled',value:false}];expect(accepted(candidate).mcp).toEqual({requestedDisabledIds:['bambu'],effectiveState:'unknown',merge:'runtime-layers-unobserved'});
 });
 it('rejects enabled MCP servers and credential/provider overrides without exposing values',()=>{
  const candidate=input();candidate.baseline.overrides=[...candidate.baseline.overrides,{key:'mcp_servers.SECRET.enabled',value:true}];rejected(candidate,'LAUNCH_CONFIG_MCP_CONTROL');
  candidate.baseline.overrides=[...input().baseline.overrides,{key:'model_providers.openai.api_key',value:'SECRET'}];
  const result=buildCodexLaunchConfig(candidate);expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('SECRET');
 });
 it('requires a network proxy request with any enabled network policy',()=>{
  const candidate=input();const selected=candidate.baseline.overrides.find(item=>item.key==='permissions.ouroboros_worker')!.value as any;selected.network.enabled=true;selected.network.domains={'example.com':'allow'};
  rejected(candidate,'LAUNCH_CONFIG_NETWORK_CONTROL');candidate.baseline.overrides=[...candidate.baseline.overrides,{key:'features.network_proxy',value:true}];
  selected.network.allow_local_binding=true;selected.network.proxy_url='http://127.0.0.1:18473';selected.network.enable_socks5=false;selected.network.enable_socks5_udp=false;
  expect(accepted(candidate).configuration.permissions).toBeDefined();
 });
 it('requires the supported MXC loopback proxy contract and a separate disabled profile',()=>{
  const candidate=input();const network=(candidate.baseline.overrides.find(item=>item.key==='permissions.ouroboros_worker')!.value as any).network;
  network.allow_local_binding=true;rejected(candidate,'LAUNCH_CONFIG_NETWORK_CONTROL');network.allow_local_binding=false;
  network.proxy_url='http://127.0.0.1:18473';rejected(candidate,'LAUNCH_CONFIG_NETWORK_CONTROL');network.enabled=true;
  candidate.baseline.overrides=[...candidate.baseline.overrides,{key:'features.network_proxy',value:true}];
  rejected(candidate,'LAUNCH_CONFIG_NETWORK_CONTROL');network.allow_local_binding=true;expect(accepted(candidate).configuration.permissions).toBeDefined();
  for(const url of ['http://example.com:18473','http://user:password@127.0.0.1:18473','http://127.0.0.1:18473/path','http://127.0.0.1:18473?key=value','https://127.0.0.1:18473']){network.proxy_url=url;rejected(candidate,'LAUNCH_CONFIG_NETWORK_CONTROL');}
 });
 it('rejects malformed TOML without Codex raw-string fallback or dependency messages',()=>{
  const valid=accepted(input());const argv=[...valid.argv];argv[3]='permissions.ouroboros_worker={"SECRET":true}';
  const result=prevalidateCodexLaunchArgv({entryPoint:'features',schema:CODEX_CONFIG_SCHEMA,argv});expect(result).toMatchObject({ok:false,error:{code:'LAUNCH_CONFIG_TOML_INVALID'}});expect(JSON.stringify(result)).not.toContain('SECRET');
 });
 it('bounds raw argv before parsing and refuses an unbounded verifier command',()=>{
  expect(prevalidateCodexLaunchArgv({entryPoint:'features',schema:CODEX_CONFIG_SCHEMA,argv:['-c','model="'+ 'x'.repeat(262144)+'"','features','list']})).toMatchObject({ok:false,error:{code:'LAUNCH_CONFIG_ARGV_INVALID'}});
  const candidate=input('verifier');candidate.verifier!.command=['C:\\node.exe',...new Array(128).fill('argument')];rejected(candidate,'LAUNCH_CONFIG_VERIFIER_COMMAND');
 });
 it('rejects injected keys, unsupported entry flags and noncanonical raw literals',()=>{
  const valid=accepted(input());
  for(const payload of ['model="safe" # SECRET','model="safe"\nSECRET=true','model=safe']){
   const argv=[...valid.argv];argv[21]=payload;expect(prevalidateCodexLaunchArgv({entryPoint:'features',schema:CODEX_CONFIG_SCHEMA,argv}).ok).toBe(false);
  }
  expect(prevalidateCodexLaunchArgv({entryPoint:'features',schema:CODEX_CONFIG_SCHEMA,argv:['--strict-config',...valid.argv]}).ok).toBe(false);
 });
 it('returns immutable snapshots and hashes which distinguish argv from canonical configuration',()=>{
  const candidate=input();const first=accepted(candidate);const before=first.configurationHash;
  (candidate.baseline.overrides[1].value as any).filesystem['C:\\work']='deny';expect(first.configurationHash).toBe(before);expect((first.configuration.permissions as any).ouroboros_worker.filesystem['C:\\work']).toBe('write');
  expect(Object.isFrozen(first.argv)).toBe(true);expect(Object.isFrozen(first.configuration)).toBe(true);
  expect(first.argvHash).toBe(createHash('sha256').update(JSON.stringify(first.argv)).digest('hex'));
  const reordered=input();reordered.baseline.overrides=[...reordered.baseline.overrides].reverse();expect(accepted(reordered).configurationHash).toBe(first.configurationHash);expect(accepted(reordered).argvHash).not.toBe(first.argvHash);
 });
 it('uses one restriction factory for the same validated baseline',()=>{
  const candidate=input();candidate.baseline.overrides=restrictedCodexOverrides({profileName:'ouroboros_worker',profile,defaultPermissions:true,model:'gpt-6-astra',effort:'ultra',sqliteHome:'C:\\state'});
  expect(accepted(candidate).argv).toEqual(accepted(input()).argv);
 });
 it('round trips every historical override byte and reports its proven quoted CLI-key defect',()=>{
  const approved=JSON.parse(readFileSync(new URL('./fixtures/codex/approved-features-recipe.json',import.meta.url),'utf8')) as {argv:string[]};
  const rebuilt:string[]=[];for(let index=0;index<approved.argv.length-2;index+=2){
   const payload=approved.argv[index+1],separator=payload.indexOf('='),encoded=encodeCodexConfigValue(parse(`value=${payload.slice(separator+1)}`).value as CodexConfigValue);
   expect(encoded.ok).toBe(true);if(!encoded.ok)throw Error(encoded.error.code);rebuilt.push('-c',`${payload.slice(0,separator)}=${encoded.value}`);
  }
  rebuilt.push('features','list');expect(rebuilt).toEqual(approved.argv);
  expect(prevalidateCodexLaunchArgv({entryPoint:'features',schema:CODEX_CONFIG_SCHEMA,argv:rebuilt})).toMatchObject({ok:false,error:{code:'LAUNCH_CONFIG_KEY_UNSUPPORTED'}});
  const changed:number[]=[];const corrected=rebuilt.map((arg,index)=>{const fixed=arg.replace(/^mcp_servers\."([A-Za-z0-9_-]+)"\.enabled=/,'mcp_servers.$1.enabled=');if(fixed!==arg)changed.push(index);return fixed;});
  expect(changed).toEqual([27,29,31,33]);expect(changed.map(index=>rebuilt[index].split('.')[1])).toEqual(['"bambu"','"node_repl"','"openscad"','"supabase"']);
  const result=prevalidateCodexLaunchArgv({entryPoint:'features',schema:CODEX_CONFIG_SCHEMA,argv:corrected});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.code);
  expect(result.value.argv).toEqual(corrected);expect(result.value.mcp.requestedDisabledIds).toEqual(['bambu','node_repl','openscad','supabase']);expect(result.value.mcp.effectiveState).toBe('unknown');
 });
});
