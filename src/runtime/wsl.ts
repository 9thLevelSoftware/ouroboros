import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import type { Result } from '../contracts/common.ts';
import { LaunchSpecSchema, type LaunchInput, type LaunchSpec, type OwnedExecution } from '../contracts/execution.ts';
import { connectOwnedHelper } from './supervisor.ts';

export interface WslPrerequisites {
  distro: string; wslVersion: number; systemd: boolean; cgroup2: boolean; userManager: boolean;
  bwrap: boolean; socat: boolean; ripgrep: boolean; seccomp: boolean;
  brokerSocketIsolation: boolean; inheritedDescriptorsRestricted: boolean; missing: string[];
}
type Execute = (file: string, args: string[]) => Promise<string>;
export type WslInspectionOptions = {
  execute?: Execute; seccompPath?: string;
  /** Only current independent qualification can establish these behavioral controls. */
  brokerSocketIsolation?: boolean; inheritedDescriptorsRestricted?: boolean;
};
const execute: Execute = (file, args) => new Promise((resolve, reject) => execFile(file, args,
  { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' },
  (error, stdout) => error ? reject(error) : resolve(stdout)));
export function wslHelperCommand(distro: string, helperPath: string): { file: string; args: string[] } {
  if (!distro.trim() || /[\0\r\n]/.test(distro) || !posix.isAbsolute(helperPath) || /[\0\r\n]/.test(helperPath)) throw new Error('Named distro and absolute trusted Linux helper required');
  return { file: 'wsl.exe', args: ['--distribution', distro, '--exec', helperPath, 'bridge'] };
}
/** Passive prerequisite inspection never creates units, invokes repository commands or installs/restarts WSL. */
export async function inspectWsl(distro: string, options: WslInspectionOptions = {}): Promise<WslPrerequisites> {
  const result: WslPrerequisites = { distro, wslVersion: 0, systemd: false, cgroup2: false, userManager: false,
    bwrap: false, socat: false, ripgrep: false, seccomp: false, brokerSocketIsolation: options.brokerSocketIsolation === true,
    inheritedDescriptorsRestricted: options.inheritedDescriptorsRestricted === true, missing: [] };
  if (!distro.trim() || /[\0\r\n]/.test(distro)) { result.missing = ['Named WSL2 distribution required']; return result; }
  const run = options.execute ?? execute;
  try {
    const listing = (await run('wsl.exe', ['--list', '--verbose'])).replaceAll('\0', '');
    for (const row of listing.split(/\r?\n/)) {
      const fields = row.trim().replace(/^\*\s*/, '').match(/^(.*?)\s+(?:Running|Stopped)\s+([12])\s*$/i);
      if (fields?.[1] === distro) result.wslVersion = Number(fields[2]);
    }
    if (result.wslVersion !== 2) throw new Error('Selected distribution must be WSL2');
    // This script is fixed controller text. Distro/seccomp path remain separate literal argv; no interpolation into a shell.
    const script = 'test "$(cat /proc/1/comm)" = systemd && printf "systemd\\n"; test -f /sys/fs/cgroup/cgroup.controllers && printf "cgroup2\\n"; systemctl --user show-environment >/dev/null 2>&1 && printf "userManager\\n"; test -x /usr/bin/bwrap && printf "bwrap\\n"; test -x /usr/bin/socat && printf "socat\\n"; test -x /usr/bin/rg && printf "ripgrep\\n"; test -n "$1" && test -x "$1" && printf "seccomp\\n"; true';
    const facts = new Set((await run('wsl.exe', ['--distribution', distro, '--exec', '/bin/sh', '-c', script, 'ouroboros-inspect', options.seccompPath ?? ''])).split(/\r?\n/));
    for (const key of ['systemd','cgroup2','userManager','bwrap','socat','ripgrep','seccomp'] as const) result[key] = facts.has(key);
  } catch { /* Missing/failed inspection remains unavailable; never fall back. */ }
  result.missing = Object.entries(result).filter(([key, value]) => typeof value === 'boolean' && !value).map(([key]) => key);
  if (result.wslVersion !== 2) result.missing.unshift('WSL2');
  return result;
}
export type WslLaunchOptions = {
  helperPath: string; authorize: (spec: Readonly<LaunchSpec>) => Promise<boolean>;
  inspect?: (distro: string) => Promise<WslPrerequisites>;
  connect?: typeof connectOwnedHelper;
};
function unavailable(message: string): Result<OwnedExecution> { return { ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message, evidenceIds: [] } }; }
export async function launchWslOwned(input: LaunchInput, distro: string, options: WslLaunchOptions): Promise<Result<OwnedExecution>> {
  const parsed = LaunchSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'INVALID_LAUNCH_SPEC', message: parsed.error.message, evidenceIds: [] } };
  const spec = parsed.data;
  if (!options || typeof options.authorize !== 'function') return unavailable('Required trusted authorization resolver is missing');
  if (!posix.isAbsolute(spec.executable) || !posix.isAbsolute(spec.cwd) || spec.deadline <= Date.now() ||
      (spec.authorization.kind === 'qualification' && spec.authorization.fixtureRoots.some(root => !posix.isAbsolute(root)))) return unavailable('Absolute Linux paths and future deadline required');
  let command: ReturnType<typeof wslHelperCommand>;
  try { command = wslHelperCommand(distro, options.helperPath); } catch { return unavailable('Configure a named WSL2 distro and trusted Linux helper'); }
  Object.freeze(spec.argv); Object.freeze(spec.env);
  if (spec.authorization.kind === 'qualification') Object.freeze(spec.authorization.fixtureRoots);
  Object.freeze(spec.authorization); Object.freeze(spec);
  try { if (!await options.authorize(spec)) return unavailable('Verifier qualification/current exact disposable probe authorization is missing'); }
  catch { return unavailable('Authorization lookup failed'); }
  let prerequisites: WslPrerequisites;
  try { prerequisites = await (options.inspect ?? inspectWsl)(distro); } catch { return unavailable('WSL prerequisite inspection failed'); }
  if (prerequisites.distro !== distro || prerequisites.wslVersion !== 2 ||
      !['systemd','cgroup2','userManager','bwrap','socat','ripgrep','seccomp','brokerSocketIsolation','inheritedDescriptorsRestricted'].every(key => prerequisites[key as keyof WslPrerequisites] === true)) {
    return unavailable(`Required WSL controls unavailable: ${prerequisites.missing.join(', ') || 'systemd/cgroup/socket/seccomp boundary'}. Inspect and set up explicitly; no automatic install or restart.`);
  }
  if (spec.deadline <= Date.now()) return unavailable('Deadline expired during preflight');
  return await (options.connect ?? connectOwnedHelper)(command, spec, 'wsl2');
}
