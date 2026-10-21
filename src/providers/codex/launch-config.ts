import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { parse } from 'smol-toml';
import type { Result } from '../../contracts/common.ts';

// Harness-owned contract identity, independent of historical vendor schemas.
export const CODEX_CONFIG_SCHEMA = Object.freeze({version:'ouroboros-launch-1',sha256:createHash('sha256').update('ouroboros-launch-1:strict-controls-toml-permissions-auth-env').digest('hex')});
export type CodexConfigValue = string | boolean | number | readonly CodexConfigValue[] | {readonly [key:string]:CodexConfigValue};
export type CodexOverride = {key:string;value:CodexConfigValue};
export type CodexLaunchConfigInput = {entryPoint:'features'|'metadata'|'worker'|'verifier'|'strict-positive'|'strict-negative';schema:{version:string;sha256:string};baseline:{permission:{kind:'named-profile';name:string};overrides:readonly CodexOverride[]};verifier?:{cwd:string;command:readonly string[]}};
export type ValidatedCodexLaunchConfig = {
 entryPoint:CodexLaunchConfigInput['entryPoint'];argv:string[];argvHash:string;configurationHash:string;configuration:Record<string,unknown>;
 schema:typeof CODEX_CONFIG_SCHEMA;permission:{kind:'named-profile';name:string;mechanism:'default-permissions'|'sandbox-permission-profile';coverage:'requested'};
 mcp:{requestedDisabledIds:string[];effectiveState:'unknown';merge:'runtime-layers-unobserved'};
 strict:{enabled:boolean;approvedUnknownField:boolean};coverage:'structural-preflight-only';
};

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const table=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[null,Object.prototype].includes(Object.getPrototypeOf(value));
const safeSegment=(key:string)=>typeof key==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(key)&&!['__proto__','prototype','constructor'].includes(key);
const absolute=(path:unknown):path is string=>typeof path==='string'&&win32.isAbsolute(path)&&!path.startsWith('\\\\')&&!/[\u0000-\u001f\u007f]/.test(path)&&!path.split(/[\\/]/).some(part=>part==='.'||part==='..');
const loopbackProxy=(value:unknown):boolean=>{
 if(typeof value!=='string'||!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/.test(value))return false;
 try{const url=new URL(value);return Number(url.port)>0&&Number(url.port)<=65535&&!url.username&&!url.password;}catch{return false;}
};
function failure<T>(code:string):Result<T>{return {ok:false,error:{code:`LAUNCH_CONFIG_${code}`,message:'Codex launch configuration failed offline structural preflight',evidenceIds:[]}};}
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
function canonical(value:unknown):unknown{return Array.isArray(value)?value.map(canonical):table(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}

/** Closed TOML 1.0-compatible value subset. Null, dates, bigint, sparse arrays,
 * nonfinite/unsafe numbers and class instances are deliberately unsupported. */
export function encodeCodexConfigValue(value:CodexConfigValue):Result<string>{
 try{
  let nodes=0;const visit=(item:unknown,depth:number):string=>{
   if(++nodes>4096||depth>12)throw Error();
   if(typeof item==='string'){if(Buffer.byteLength(item)>16384)throw Error();return JSON.stringify(item);}
   if(typeof item==='boolean')return String(item);
   if(typeof item==='number'&&Number.isFinite(item)&&Math.abs(item)<=Number.MAX_SAFE_INTEGER&&!Object.is(item,-0))return String(item);
   if(Array.isArray(item)){if(item.length>1024||Object.keys(item).length!==item.length)throw Error();return `[${item.map(child=>visit(child,depth+1)).join(',')}]`;}
   if(table(item))return `{${Object.entries(item).map(([key,child])=>{if(Buffer.byteLength(key)>4096||['__proto__','prototype','constructor'].includes(key))throw Error();return `${JSON.stringify(key)}=${visit(child,depth+1)}`;}).join(',')}}`;
   throw Error();
  };
  const encoded=visit(value,0);const decoded=parse(`value=${encoded}`,{unsafeKeyBehaviour:'throw'});
  if(JSON.stringify(canonical(decoded.value))!==JSON.stringify(canonical(value)))return failure('VALUE_UNSUPPORTED');
  return {ok:true,value:encoded};
 }catch{return failure('VALUE_UNSUPPORTED');}
}

/** Builds only requested overrides. Layer merging and effective policy require
 * independently observed runtime evidence; this result authorizes no process. */
export function buildCodexLaunchConfig(input:CodexLaunchConfigInput):Result<ValidatedCodexLaunchConfig>{
 try{
  if(input.schema?.version!==CODEX_CONFIG_SCHEMA.version||input.schema.sha256!==CODEX_CONFIG_SCHEMA.sha256)return failure('SCHEMA_IDENTITY');
  if(!['features','metadata','worker','verifier','strict-positive','strict-negative'].includes(input.entryPoint))return failure('ENTRY_POINT');
  const permission=input.baseline?.permission;
  if(permission?.kind!=='named-profile'||!safeSegment(permission.name))return failure('PERMISSION_SELECTION');
  const overrides=input.baseline.overrides;
  if(!Array.isArray(overrides)||overrides.length>128)return failure('OVERRIDES_INVALID');
  const keys:string[]=[];const pairs:string[]=[];const config:Record<string,unknown>={};
  for(const override of overrides){
   if(typeof override?.key!=='string'||!override.key.split('.').every(safeSegment))return failure('KEY_UNSUPPORTED');
   const key=override.key;
   if(keys.some(other=>other===key||other.startsWith(`${key}.`)||key.startsWith(`${other}.`)))return failure('DUPLICATE_OR_CONFLICTING_CONTROL');
   keys.push(key);
   if(['sandbox_mode','sandbox_workspace_write','profile','profiles'].includes(key.split('.')[0]))return failure('LEGACY_PERMISSION_CONFLICT');
   const encoded=encodeCodexConfigValue(override.value);if(!encoded.ok)return encoded;
   const decoded=parse(`value=${encoded.value}`,{unsafeKeyBehaviour:'throw'}).value;
   let target=config;const segments=key.split('.');for(const segment of segments.slice(0,-1)){if(!Object.hasOwn(target,segment))target[segment]={};target=target[segment] as Record<string,unknown>;}
   target[segments.at(-1)!]=decoded;pairs.push('-c',`${key}=${encoded.value}`);
  }
  if(pairs.reduce((total,value)=>total+Buffer.byteLength(value),0)>131072)return failure('OVERRIDES_INVALID');
  // Validate our closed control vocabulary; vendor schema snapshots are reference evidence.
  if(config.web_search!==undefined&&config.web_search!=='disabled'||config.forced_login_method!==undefined&&config.forced_login_method!=='chatgpt'||table(config.windows)&&config.windows.sandbox!==undefined&&config.windows.sandbox!=='mxc'||config.model!==undefined&&(typeof config.model!=='string'||!config.model||Buffer.byteLength(config.model)>128)||config.model_reasoning_effort!==undefined&&(typeof config.model_reasoning_effort!=='string'||!config.model_reasoning_effort||Buffer.byteLength(config.model_reasoning_effort)>128))return failure('SCHEMA_INVALID');
  const allowedRoots=new Set(['windows','permissions','default_permissions','approval_policy','features','notify','web_search','model_provider','forced_login_method','model','model_reasoning_effort','sqlite_home','mcp_servers','shell_environment_policy']);
  if(Object.keys(config).some(key=>!allowedRoots.has(key)))return failure('SCHEMA_INVALID');
  const features=table(config.features)?config.features:{};
  if(Object.values(features).some(value=>typeof value!=='boolean'))return failure('SCHEMA_INVALID');
  if(Object.keys(features).some(key=>!['plugins','apps','hooks','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','remote_control','network_proxy'].includes(key)))return failure('CONTROL_UNSUPPORTED');
  if(config.approval_policy!==undefined&&config.approval_policy!=='on-request')return failure('APPROVAL_CONTROL');
  if(config.shell_environment_policy!==undefined){
   const policy=config.shell_environment_policy;
   const keys=['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'];
   if(!table(policy)||Object.keys(policy).sort().join()!=='exclude,experimental_use_profile,ignore_default_excludes,include_only,inherit,set'||policy.inherit!=='none'||policy.ignore_default_excludes!==false||policy.experimental_use_profile!==false||!Array.isArray(policy.exclude)||policy.exclude.length!==0||!Array.isArray(policy.include_only)||policy.include_only.length!==8||new Set(policy.include_only).size!==8||!keys.every(key=>(policy.include_only as unknown[]).includes(key))||!table(policy.set)||Object.keys(policy.set).sort().join()!==[...keys].sort().join()||Object.entries(policy.set).some(([key,path])=>key==='SystemDrive'?typeof path!=='string'||!(/^[A-Za-z]:$/).test(path):!absolute(path)))return failure('ENVIRONMENT_CONTROL');
  }
  if(config.model_provider!=='openai'||config.forced_login_method!=='chatgpt')return failure('SUBSCRIPTION_CONTROL');
  if(!table(config.windows)||config.windows.sandbox!=='mxc'||Object.keys(config.windows).some(key=>key!=='sandbox')||
    ['plugins','apps','hooks'].some(key=>features[key]!==false)||config.web_search!=='disabled'||!Array.isArray(config.notify)||config.notify.length!==0||
    ['browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','remote_control'].some(key=>features[key]!==undefined&&features[key]!==false))return failure('REQUIRED_CONTROL');
  if(!table(config.permissions)||Object.keys(config.permissions).length!==1||!Object.hasOwn(config.permissions,permission.name))return failure('PERMISSION_SELECTION');
  const profile=config.permissions[permission.name];
  if(!table(profile))return failure('PROFILE_INVALID');
  if(Object.keys(profile).some(key=>!['filesystem','network'].includes(key))||!table(profile.filesystem)||!table(profile.network))return failure('PROFILE_INVALID');
  if(Object.entries(profile.filesystem).some(([key,value])=>(key!==':minimal'&&!absolute(key))||typeof value!=='string'||!['read','write','deny'].includes(value))||profile.filesystem[':minimal']!=='read'||Object.keys(profile.filesystem).length<2)return failure('PROFILE_INVALID');
  const network=profile.network;
  if(Object.keys(network).some(key=>!['enabled','allow_local_binding','allow_upstream_proxy','dangerously_allow_all_unix_sockets','dangerously_allow_non_loopback_proxy','domains','proxy_url','enable_socks5','enable_socks5_udp'].includes(key))||typeof network.enabled!=='boolean'||typeof network.allow_local_binding!=='boolean'||['allow_upstream_proxy','dangerously_allow_all_unix_sockets','dangerously_allow_non_loopback_proxy'].some(key=>network[key]!==false)||['enable_socks5','enable_socks5_udp'].some(key=>network[key]!==undefined&&network[key]!==false)||!table(network.domains))return failure('PROFILE_INVALID');
  if(Object.entries(network.domains).some(([domain,value])=>!domain||/[\u0000-\u0020\u007f]/.test(domain)||typeof value!=='string'||!['allow','deny'].includes(value)))return failure('PROFILE_INVALID');
  // Pinned Windows MXC requires loopback binding for its managed proxy. It
  // permits loopback in that profile, so loopback denial uses network disabled.
  if(network.enabled===true&&(features.network_proxy!==true||network.allow_local_binding!==true||!loopbackProxy(network.proxy_url))||network.enabled===false&&(network.allow_local_binding!==false||network.proxy_url!==undefined||Object.values(network.domains).some(value=>value==='allow')))return failure('NETWORK_CONTROL');
  const mcpIds:string[]=[];
  if(config.mcp_servers!==undefined){
   if(!table(config.mcp_servers))return failure('MCP_CONTROL');
   for(const [id,server] of Object.entries(config.mcp_servers)){if(!safeSegment(id)||!table(server)||server.enabled!==false||Object.keys(server).some(key=>key!=='enabled'))return failure('MCP_CONTROL');mcpIds.push(id);}
  }
  if(input.entryPoint==='features'&&(!absolute(config.sqlite_home)||typeof config.model!=='string'||!config.model))return failure('REQUIRED_CONTROL');
  if(config.sqlite_home!==undefined&&!absolute(config.sqlite_home))return failure('REQUIRED_CONTROL');
  let argv:string[];const verifier=input.entryPoint==='verifier';
  if(verifier){
   if(Object.hasOwn(config,'default_permissions'))return failure('PERMISSION_SELECTION');
   const command=input.verifier;
   if(!command||!absolute(command.cwd)||!Array.isArray(command.command)||!command.command.length||command.command.length>128||!absolute(command.command[0])||command.command.some(arg=>typeof arg!=='string'||arg.includes('\0')||Buffer.byteLength(arg)>16384))return failure('VERIFIER_COMMAND');
   argv=[...pairs,'sandbox','--include-managed-config','--permission-profile',permission.name,'--cd',command.cwd,'--',...command.command];
  }else{
   if(input.verifier!==undefined||config.default_permissions!==permission.name)return failure('PERMISSION_SELECTION');
   argv=input.entryPoint==='features'?[...pairs,'features','list']:['app-server','--strict-config','--stdio',...pairs];
  }
  const negative=input.entryPoint==='strict-negative';if(negative)argv.push('-c','foo="bar"');
  if(argv.reduce((total,arg)=>total+Buffer.byteLength(arg),0)>262144)return failure('ARGV_INVALID');
  return {ok:true,value:frozen({entryPoint:input.entryPoint,argv,argvHash:hash(JSON.stringify(argv)),configurationHash:hash(JSON.stringify(canonical(config))),configuration:config,schema:{...CODEX_CONFIG_SCHEMA},
   permission:{...permission,mechanism:verifier?'sandbox-permission-profile':'default-permissions',coverage:'requested'},
   mcp:{requestedDisabledIds:mcpIds,effectiveState:'unknown',merge:'runtime-layers-unobserved'},strict:{enabled:input.entryPoint!=='features'&&!verifier,approvedUnknownField:negative},coverage:'structural-preflight-only'})};
 }catch{return failure('INPUT_INVALID');}
}

/** Validates an existing canonical recipe without interpreting CLI keys as TOML
 * key paths. Pinned Rust uses literal dot splitting, so quoted segments fail. */
export function prevalidateCodexLaunchArgv(input:{entryPoint:CodexLaunchConfigInput['entryPoint'];schema:{version:string;sha256:string};argv:readonly string[]}):Result<ValidatedCodexLaunchConfig>{
 try{
  if(!Array.isArray(input.argv)||input.argv.length>400||input.argv.some(arg=>typeof arg!=='string')||input.argv.reduce((total,arg)=>total+Buffer.byteLength(arg),0)>262144)return failure('ARGV_INVALID');
  const argv=[...input.argv];let settings:string[];let verifier:CodexLaunchConfigInput['verifier'];let profile:string|undefined;
  if(input.entryPoint==='features'){
   if(argv.at(-2)!=='features'||argv.at(-1)!=='list')return failure('ARGV_INVALID');settings=argv.slice(0,-2);
  }else if(input.entryPoint==='verifier'){
   const at=argv.indexOf('sandbox');if(at<0||argv[at+1]!=='--include-managed-config'||argv[at+2]!=='--permission-profile'||argv[at+4]!=='--cd'||argv[at+6]!=='--')return failure('ARGV_INVALID');
   settings=argv.slice(0,at);profile=argv[at+3];verifier={cwd:argv[at+5],command:argv.slice(at+7)};
  }else{
   if(argv[0]!=='app-server'||argv[1]!=='--strict-config'||argv[2]!=='--stdio')return failure('ARGV_INVALID');settings=argv.slice(3);
   if(input.entryPoint==='strict-negative'){if(settings.at(-2)!=='-c'||settings.at(-1)!=='foo="bar"')return failure('NEGATIVE_CONTROL');settings=settings.slice(0,-2);}
  }
  if(settings.length%2)return failure('ARGV_INVALID');const overrides:CodexOverride[]=[];
  for(let index=0;index<settings.length;index+=2){
   const payload=settings[index+1];if(settings[index]!=='-c'||/[\r\n]/.test(payload))return failure('ARGV_INVALID');
   const separator=payload.indexOf('=');if(separator<1)return failure('ARGV_INVALID');
   const key=payload.slice(0,separator);if(!key.split('.').every(safeSegment))return failure('KEY_UNSUPPORTED');
   let value:unknown;try{const decoded=parse(`value=${payload.slice(separator+1)}`,{unsafeKeyBehaviour:'throw'});if(Object.keys(decoded).length!==1)return failure('TOML_INVALID');value=decoded.value;}catch{return failure('TOML_INVALID');}
   if(key==='default_permissions'&&typeof value==='string')profile=value;overrides.push({key,value:value as CodexConfigValue});
  }
  if(!profile)return failure('PERMISSION_SELECTION');
  const result=buildCodexLaunchConfig({...input,baseline:{permission:{kind:'named-profile',name:profile},overrides},...(verifier?{verifier}:{})});
  if(result.ok&&JSON.stringify(result.value.argv)!==JSON.stringify(argv))return failure('NONCANONICAL_ARGV');return result;
 }catch{return failure('INPUT_INVALID');}
}

/** Shared non-secret restriction baseline. Profile/roots remain explicit input. */
export function restrictedCodexOverrides(input:{profileName:string;profile:CodexConfigValue;defaultPermissions:boolean;model?:string;effort?:string;sqliteHome?:string;mcpServerIds?:readonly string[];networkProxy?:boolean;shellEnvironmentPolicy?:CodexConfigValue}):CodexOverride[]{
 return [{key:'windows.sandbox',value:'mxc'},{key:`permissions.${input.profileName}`,value:input.profile},
  ...(input.defaultPermissions?[{key:'default_permissions',value:input.profileName}]:[]),
  {key:'features.plugins',value:false},{key:'features.apps',value:false},{key:'features.hooks',value:false},{key:'notify',value:[]},{key:'web_search',value:'disabled'},
  ...['browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','remote_control'].map(key=>({key:`features.${key}`,value:false})),
  {key:'approval_policy',value:'on-request'},
  {key:'model_provider',value:'openai'},{key:'forced_login_method',value:'chatgpt'},
  ...(input.shellEnvironmentPolicy!==undefined?[{key:'shell_environment_policy',value:input.shellEnvironmentPolicy}]:[]),
  ...(input.model!==undefined?[{key:'model',value:input.model}]:[]),...(input.effort!==undefined?[{key:'model_reasoning_effort',value:input.effort}]:[]),
  ...(input.sqliteHome!==undefined?[{key:'sqlite_home',value:input.sqliteHome}]:[]),...(input.networkProxy?[{key:'features.network_proxy',value:true}]:[]),
  ...(input.mcpServerIds??[]).map(id=>({key:`mcp_servers.${id}.enabled`,value:false})),
 ];
}
