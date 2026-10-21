import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Release strings are observations. Admission depends on capabilities and the
 * exact executable bytes captured for this run, never a release allowlist. */
export function supportedNodeVersion(version:string):boolean {
  const match=/^v?(\d+)\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.exec(version);
  return !!match&&Number.isSafeInteger(Number(match[1]))&&Number(match[1])>=24;
}
export function nodeRuntimeCapabilities():boolean {
  return supportedNodeVersion(process.versions.node)&&typeof structuredClone==='function'&&typeof AbortSignal.any==='function'&&typeof TextDecoder==='function'&&typeof process.hrtime.bigint==='function';
}
export function resolveExecutable(path:string):string { return realpathSync.native(path); }
export function executableHash(path:string):string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
/** Passive package metadata is only a version observation. It is never trusted
 * instead of the binary digest, and ordinary runs need no extra probe process. */
export function installedCodexVersion(executable:string):string {
  let directory=dirname(executable);
  for(let depth=0;depth<10;depth++){
    try{const bytes=readFileSync(join(directory,'package.json'));if(bytes.length<=65536){const value=JSON.parse(bytes.toString('utf8'));if(typeof value.name==='string'&&/^@openai\/codex(?:-|$)/.test(value.name)&&typeof value.version==='string'&&/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version))return value.version;}}catch{/* Missing metadata leaves an explicit unknown observation. */}
    const parent=dirname(directory);if(parent===directory)break;directory=parent;
  }
  return 'unobserved';
}
export function codexVersionObservation(userAgent:unknown):string {
  return typeof userAgent==='string'&&userAgent.length<=256?(/^codex\/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/.exec(userAgent)?.[1]??'unobserved'):'unobserved';
}
export function nativeDependencyFailure(error:unknown):Error|undefined {
  const value=error as {code?:unknown;message?:unknown};
  if(value?.code==='ERR_DLOPEN_FAILED'||typeof value?.message==='string'&&/NODE_MODULE_VERSION|Could not locate the bindings file|not a valid Win32 application|invalid ELF header/i.test(value.message))return Object.assign(new Error('DEPENDENCY_REBUILD_REQUIRED: rebuild or reinstall better-sqlite3 for the selected Node runtime (npm rebuild better-sqlite3), then retry. No dependencies were changed automatically.'),{code:'DEPENDENCY_REBUILD_REQUIRED'});
  return undefined;
}
export function runtimeCompatibilityDiagnostic(code:string):string|undefined {
  if(code==='NODE_CAPABILITY_UNSUPPORTED')return 'Select Node 24 or newer with structuredClone, AbortSignal.any, TextDecoder, and the monotonic clock APIs, then start a new run.';
  if(code==='EXECUTABLE_CHANGED_DURING_RUN')return 'A resolved executable path or its SHA-256 changed after this run started. Preserve the evidence and start a new run with a stable installation.';
  if(code==='LAUNCH_CONTROLS_CHANGED'||code==='POLICY_CONTROLS_CHANGED'||code==='VERIFIER_COMMAND_CHANGED')return 'Launch, environment, policy, or fixed verification controls changed after capture. Preserve the evidence, review the changed controls, then start a new run.';
  if(code==='CAPABILITY_UNAVAILABLE'||/^PROVIDER_(?:INITIALIZE|CONFIG_READ|REQUIREMENTS_READ|CONTROLS|THREAD_SETTINGS|MODEL_SELECTION)_FAILED$/.test(code))return 'The installed runtime did not demonstrate a required startup or security capability. Inspect the retained protocol diagnostic; a release label alone does not establish support.';
  return undefined;
}
