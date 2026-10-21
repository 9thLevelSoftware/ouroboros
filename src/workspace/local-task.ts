import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, writeFile, mkdir, readdir, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface LocalTaskFile { path: string; size: number; sha256: string; mode?: number }
export interface LocalTaskSnapshot { sourceRoot: string; destinationRoot: string; baselineRoot: string; workspaceRoot: string; sourceManifestPath: string; sourceManifest: LocalTaskFile[]; maxBytes: number }
export interface CandidateChange { path: string; change: 'added' | 'modified' | 'deleted' }
const credential = /(^|\/)(\.env(?:\.[^/]*)?|\.codex|\.claude|\.aws|\.azure|\.ssh|\.netrc)(\/|$)|(^|\/)(credentials?|auth(?:entication)?[.-]?(?:cache|tokens?)?|tokens?)(?:\.(?:json|jsonl|ya?ml|toml|ini|conf|config|cache|db|sqlite3?|txt|log))?$/i;
const npmConfigLimit = 64 * 1024;
function checkNpmConfig(path: string, bytes: Buffer): void {
  if (!/(^|\/)\.npmrc$/i.test(path)) return;
  const lines = bytes.toString('utf8').split(/\r?\n/).filter(line => !/^\s*[#;]/.test(line));
  if (bytes.includes(0) || lines.some(line => /(?:^|:)\s*(?:_?auth(?:[-_]?token)?|_?password|username|(?:access[-_]?)?token)\s*=/i.test(line) || /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(line))) throw new Error(`Refusing credential configuration: ${path}`);
}
function safePath(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) || p.toLowerCase() === '.git')) throw new Error(`Unsafe path: ${path}`);
  if (credential.test(path)) throw new Error(`Refusing credential path: ${path}`);
}
function inside(a: string,b: string): boolean { const r=relative(a,b); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); }
async function checkChain(path: string): Promise<void> { let current=resolve(path); for (;;) { try {const s=await lstat(current);if(s.isSymbolicLink())throw new Error(`Refusing link: ${current}`);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const parent=dirname(current);if(parent===current)break;current=parent;} }
function gitPaths(root:string): string[] {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP']) if (process.env[name] !== undefined) env[name] = process.env[name];
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:nullFile,GIT_CONFIG_GLOBAL:nullFile,GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',LANG:'C',GIT_OPTIONAL_LOCKS:'0'});
  // These read-only plumbing commands do not checkout files, run hooks, or
  // invoke clean/smudge filters. Explicitly disable the fsmonitor helper.
  const common=['-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c',`core.attributesFile=${nullFile}`,'-c',`core.hooksPath=${nullFile}`,'-C',root];
  const options={env,shell:false,timeout:30_000,stdio:['ignore','pipe','pipe'] as ['ignore','pipe','pipe']};
  const top=execFileSync('git',[...common,'rev-parse','--show-toplevel'],{...options,encoding:'utf8',maxBuffer:1024*1024}).trim();
  if(resolve(top).toLowerCase()!==root.toLowerCase())throw new Error('Source must be Git repository root');
  const raw=execFileSync('git',[...common,'ls-files','-z','--cached','--others','--exclude-standard'],{...options,maxBuffer:64*1024*1024});
  return [...new Set(raw.toString('utf8').split('\0').filter(Boolean))].sort();
}
async function inventory(root:string, paths:string[], maxBytes:number):Promise<LocalTaskFile[]> {
  const seen=new Set<string>();const result:LocalTaskFile[]=[];let total=0;
  for(const path of paths){safePath(path);const key=path.toLowerCase();if(seen.has(key))throw new Error(`Case collision: ${path}`);seen.add(key);const full=join(root,path);await checkChain(full);let stat;try{stat=await lstat(full);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}if(!stat.isFile() || stat.isSymbolicLink())throw new Error(`Not a regular file: ${path}`);total+=stat.size;if(total>maxBytes)throw new Error('Snapshot capacity exceeded');if(/(^|\/)\.npmrc$/i.test(path) && stat.size>npmConfigLimit)throw new Error(`Refusing oversized npm configuration: ${path}`);const bytes=await readFile(full);checkNpmConfig(path,bytes);if(bytes.length!==stat.size)throw new Error('File changed during inventory');result.push({path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...(process.platform === 'win32' ? {} : {mode:stat.mode & 0o777})});}
  return result;
}
async function walk(root:string,prefix=''):Promise<string[]> {const paths:string[]=[];for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){const path=prefix?`${prefix}/${entry.name}`:entry.name;safePath(path);if(entry.isSymbolicLink())throw new Error(`Refusing link: ${path}`);if(entry.isDirectory())paths.push(...await walk(root,path));else if(entry.isFile())paths.push(path);else throw new Error(`Not a regular file: ${path}`);}return paths.sort();}
function equal(a:LocalTaskFile[],b:LocalTaskFile[]):boolean{return JSON.stringify(a)===JSON.stringify(b);}
export async function snapshotLocalTask(options:{sourceRoot:string;destinationRoot:string;maxBytes?:number}):Promise<LocalTaskSnapshot> {
  await checkChain(options.sourceRoot);await checkChain(options.destinationRoot);
  const sourceRoot=await realpath(resolve(options.sourceRoot));const destinationRoot=resolve(options.destinationRoot);
  if(inside(sourceRoot,destinationRoot)||inside(destinationRoot,sourceRoot))throw new Error('Source/destination overlap');
  try{await lstat(destinationRoot);throw new Error('Destination must be fresh');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const maxBytes=options.maxBytes??64*1024*1024;if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new Error('Invalid capacity');
  const sourceManifest=await inventory(sourceRoot,gitPaths(sourceRoot),maxBytes);
  const snapshot:LocalTaskSnapshot={sourceRoot,destinationRoot,baselineRoot:join(destinationRoot,'baseline'),workspaceRoot:join(destinationRoot,'workspace'),sourceManifestPath:join(destinationRoot,'controller','source-manifest.json'),sourceManifest,maxBytes};
  await mkdir(destinationRoot);await mkdir(dirname(snapshot.sourceManifestPath));await mkdir(snapshot.baselineRoot);await mkdir(snapshot.workspaceRoot);
  for(const file of sourceManifest){const bytes=await readFile(join(sourceRoot,file.path));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('Source changed during copy');for(const root of [snapshot.baselineRoot,snapshot.workspaceRoot]){await mkdir(dirname(join(root,file.path)),{recursive:true});await writeFile(join(root,file.path),bytes,{flag:'wx'});if(file.mode !== undefined)await chmod(join(root,file.path),file.mode);}}
  await assertSourceUnchanged(snapshot);await writeFile(snapshot.sourceManifestPath,JSON.stringify(sourceManifest,null,2),{flag:'wx'});return snapshot;
}
export async function assertSourceUnchanged(snapshot:LocalTaskSnapshot):Promise<void>{const current=await inventory(snapshot.sourceRoot,gitPaths(snapshot.sourceRoot),snapshot.maxBytes);if(!equal(snapshot.sourceManifest,current))throw new Error('Source changed since snapshot');}
export async function captureCandidate(snapshot:LocalTaskSnapshot,scope:{allowedPaths:string[];protectedPaths:string[]}):Promise<{changedFiles:CandidateChange[];candidateManifest:LocalTaskFile[];candidateManifestPath:string}> {
  const normalize=(paths:string[])=>paths.map(p=>{const clean=p.replace(/\/$/,'');safePath(clean);return clean.toLowerCase();});const allowed=normalize(scope.allowedPaths),protectedPaths=normalize(scope.protectedPaths);const matches=(path:string,paths:string[])=>paths.some(p=>path.toLowerCase()===p||path.toLowerCase().startsWith(`${p}/`));
  await assertSourceUnchanged(snapshot);await checkChain(snapshot.workspaceRoot);
  const candidateManifest=await inventory(snapshot.workspaceRoot,await walk(snapshot.workspaceRoot),snapshot.maxBytes);const before=new Map(snapshot.sourceManifest.map(f=>[f.path,f]));const after=new Map(candidateManifest.map(f=>[f.path,f]));const changedFiles:CandidateChange[]=[];
  for(const path of [...new Set([...before.keys(),...after.keys()])].sort()){const a=before.get(path),b=after.get(path);if(a?.sha256===b?.sha256 && a?.mode===b?.mode)continue;if(matches(path,protectedPaths))throw new Error(`Changed protected path: ${path}`);if(!matches(path,allowed))throw new Error(`Changed path is not allowed: ${path}`);changedFiles.push({path,change:!a?'added':!b?'deleted':'modified'});}
  const candidateManifestPath=join(snapshot.destinationRoot,'controller','candidate-manifest.json');await writeFile(candidateManifestPath,JSON.stringify(candidateManifest,null,2),{flag:'wx'});return {changedFiles,candidateManifest,candidateManifestPath};
}


