import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type LocalTaskFile, type LocalTaskSnapshot } from './local-task.ts';

export interface LocalPatch { patchPath: string; sha256: string; bytes: number; applyStrip: 2 }
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function noLinks(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing link: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function safeComponent(name: string): void {
  if (!name || name === '.' || name === '..' || name.toLowerCase() === '.git' || /[<>:"|?*\\/\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new Error(`Unsafe patch path: ${name}`);
}
async function manifest(root: string, maxBytes: number): Promise<LocalTaskFile[]> {
  await noLinks(root);
  const files: LocalTaskFile[] = [];
  let total = 0;
  async function visit(prefix: string): Promise<void> {
    const names = new Set<string>();
    for (const entry of await readdir(join(root,prefix),{withFileTypes:true})) {
      safeComponent(entry.name);
      const key = entry.name.toLowerCase();
      if (names.has(key)) throw new Error(`Case collision: ${entry.name}`);
      names.add(key);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(root,path);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`Refusing link: ${path}`);
      if (stat.isDirectory()) { await visit(path); continue; }
      if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
      total += stat.size;
      if (total > maxBytes) throw new Error('Patch inventory capacity exceeded');
      const bytes = await readFile(full);
      if (bytes.length !== stat.size) throw new Error(`File changed while inspecting: ${path}`);
      files.push({path,size:bytes.length,sha256:hash(bytes),...(process.platform === 'win32' ? {} : {mode:stat.mode & 0o777})});
    }
  }
  await visit('');
  return files.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function verify(root: string, expected: LocalTaskFile[], maxBytes: number, label: string): Promise<void> {
  const current = await manifest(root,maxBytes);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error(`${label} changed since capture`);
}
/** Export only; applying the returned patch is an explicit caller operation. */
export async function exportLocalPatch(snapshot: LocalTaskSnapshot, candidateManifest: LocalTaskFile[]): Promise<LocalPatch> {
  const destination = resolve(snapshot.destinationRoot);
  if (resolve(snapshot.baselineRoot) !== join(destination,'baseline') || resolve(snapshot.workspaceRoot) !== join(destination,'workspace')) throw new Error('Unexpected snapshot paths');
  const controller = join(destination,'controller');
  await noLinks(controller);
  if (!(await lstat(controller)).isDirectory()) throw new Error('Invalid controller directory');
  await verify(snapshot.baselineRoot,snapshot.sourceManifest,snapshot.maxBytes,'Baseline');
  await verify(snapshot.workspaceRoot,candidateManifest,snapshot.maxBytes,'Candidate');
  // Inherit OS process essentials only; never inherit GIT_CONFIG_COUNT, GIT_DIR,
  // GIT_EXTERNAL_DIFF, attribute sources, or other caller-controlled Git variables.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP']) if (process.env[name] !== undefined) env[name] = process.env[name];
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:nullFile,GIT_CONFIG_GLOBAL:nullFile,GIT_ATTR_NOSYSTEM:'1',GIT_CEILING_DIRECTORIES:destination,GIT_DIR:join(controller,'no-repository'),GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',LANG:'C'});
  const maxBuffer = Math.min(512*1024*1024,Math.max(1024*1024,snapshot.maxBytes*16+1024*1024));
  let patch: Buffer;
  try {
    patch = execFileSync('git',['-c','core.fsmonitor=false','-c',`core.hooksPath=${nullFile}`,'-c',`core.attributesFile=${nullFile}`,'-c','core.autocrlf=false','-c','core.safecrlf=false','-c','core.fileMode=true','-c','diff.noprefix=false','-c','diff.mnemonicPrefix=false','diff','--no-index','--binary','--no-ext-diff','--no-textconv','--no-renames','--no-color','--src-prefix=a/','--dst-prefix=b/','--','baseline','workspace'],{cwd:destination,env,shell:false,maxBuffer,timeout:30_000,stdio:['ignore','pipe','pipe']});
  } catch (error) {
    const failure = error as {status?: number; stdout?: Buffer; code?: string; signal?: string};
    if (failure.status !== 1 || !Buffer.isBuffer(failure.stdout) || failure.code || failure.signal) throw new Error('Git patch export failed or exceeded its output/time bound',{cause:error});
    patch = failure.stdout;
  }
  await verify(snapshot.baselineRoot,snapshot.sourceManifest,snapshot.maxBytes,'Baseline');
  await verify(snapshot.workspaceRoot,candidateManifest,snapshot.maxBytes,'Candidate');
  await noLinks(controller);
  const patchPath = join(controller,'candidate.patch');
  await writeFile(patchPath,patch,{flag:'wx'});
  return {patchPath,sha256:hash(patch),bytes:patch.length,applyStrip:2};
}



