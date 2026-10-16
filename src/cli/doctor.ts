import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { access, open } from 'node:fs/promises';
import { RuntimeCapabilitiesSchema, type RuntimeCapabilities } from '../contracts/provider.ts';
export type VersionTarget = 'codex' | 'wsl';
export interface DoctorDependencies {
 inspectVersion(name: VersionTarget): Promise<string | undefined>;
 credentialSourcePresence(): Record<string, boolean>;
 lookupQualification(dataRoot: string): Promise<RuntimeCapabilities | undefined>;
 platform: string;
 nodeVersion: string;
 dataRoot?: string;
}
export interface DoctorReport {
 schemaVersion: 1;
 platform: string;
 nodeVersion: string;
 versions: Record<VersionTarget, string | null>;
 credentialSources: Record<string, boolean>;
 subscriptionMode: 'unknown';
 qualification: 'UNQUALIFIED';
 cachedQualificationPresent: boolean;
 missingPrerequisites: string[];
}
const credentialNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;
// Only an allowlisted runtime version line can reach output, never arbitrary command stdout.
function safeVersion(name: VersionTarget, raw: string | undefined): string | null {
 if (!raw) return null;
 const pattern = name === 'codex'
  ? /(?:codex(?:-cli)?\s+)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i
  : /(?:WSL(?:\s+version)?\s*:\s*)(\d+\.\d+\.\d+(?:\.\d+)?)/i;
 return raw.replaceAll('\u0000', '').match(pattern)?.[1] ?? null;
}
export async function collectDoctor(deps: DoctorDependencies): Promise<DoctorReport> {
 const inspect = async (target: VersionTarget) => {
  try {
   return safeVersion(target, await deps.inspectVersion(target));
  } catch {
   return null;
  }
 };
 const [codex, wsl] = await Promise.all([inspect('codex'), inspect('wsl')]);
 const presence = deps.credentialSourcePresence();
 const credentialSources = Object.fromEntries(credentialNames.map(name => [name, presence[name] === true]));
 let cachedQualificationPresent = false;
 if (deps.dataRoot) {
  try {
   const cached = await deps.lookupQualification(deps.dataRoot);
   cachedQualificationPresent = RuntimeCapabilitiesSchema.safeParse(cached).success;
  } catch {
   // Missing or unreadable cache is unqualified.
  }
 }
 // Task 1 has no current fingerprint/qualification verifier: cached data cannot confer support.
 return {
  schemaVersion: 1,
  platform: deps.platform,
  nodeVersion: deps.nodeVersion,
  versions: { codex, wsl },
  credentialSources,
  subscriptionMode: 'unknown',
  qualification: 'UNQUALIFIED',
  cachedQualificationPresent,
  missingPrerequisites: [
   ...(!codex ? ['codex'] : []),
   ...(deps.platform === 'win32' && !wsl ? ['wsl'] : []),
  ],
 };
}
type Execute = (file: string, args: string[]) => Promise<string>;
const executeVersion: Execute = (file, args) => new Promise((resolve, reject) => {
 execFile(file, args, {
  shell: false,
  windowsHide: true,
  timeout: 5000,
  maxBuffer: 65536,
  encoding: 'utf8',
 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
async function inspectInstalledVersion(name: VersionTarget, env: NodeJS.ProcessEnv): Promise<string> {
 if (name === 'wsl') return executeVersion('wsl.exe', ['--version']);
 if (process.platform === 'win32') {
  // npm's Windows .cmd/.ps1 shims cannot be execFile targets without a shell.
  // Invoke the official package entrypoint with Node and literal arguments instead.
  for (const directory of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
   const entrypoint = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
   try {
    await access(entrypoint);
   } catch {
    continue;
   }
   return executeVersion(process.execPath, [entrypoint, '--version']);
  }
 }
 return executeVersion('codex', ['--version']);
}
async function readCachedQualification(dataRoot: string): Promise<RuntimeCapabilities | undefined> {
 const file = await open(join(dataRoot, 'qualification.json'), 'r');
 try {
  const buffer = Buffer.alloc(1048577);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > 1048576) return undefined;
  const parsed = RuntimeCapabilitiesSchema.safeParse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  return parsed.success ? parsed.data : undefined;
 } finally {
  await file.close();
 }
}
export function createDoctorDependencies(options: { env?: NodeJS.ProcessEnv; execute?: Execute } = {}): DoctorDependencies {
 const env = options.env ?? process.env;
 return {
  platform: process.platform,
  nodeVersion: process.versions.node,
  dataRoot: env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Ouroboros', 'controller') : undefined,
  inspectVersion: name => options.execute
   ? options.execute(name === 'codex' ? 'codex' : 'wsl.exe', ['--version'])
   : inspectInstalledVersion(name, env),
  credentialSourcePresence: () => Object.fromEntries(
   credentialNames.map(name => [name, Boolean(env[name])]),
  ),
  lookupQualification: readCachedQualification,
 };
}
