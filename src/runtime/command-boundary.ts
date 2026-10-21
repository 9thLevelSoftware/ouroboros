import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { HashSchema, PathSchema, PositiveLimitSchema, TextSchema, type Result } from '../contracts/common.ts';
import { ExecutionOwnerSchema, LaunchSpecSchema, type LaunchSpec } from '../contracts/execution.ts';

export const CommandDefinitionSchema = z.strictObject({
  id: TextSchema, executable: PathSchema, argv: z.array(z.string().refine(value => !value.includes('\0'))), cwd: PathSchema,
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine(value => !value.includes('\0'))),
  approvedEnvironmentKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)), timeoutMs: PositiveLimitSchema.max(300000),
  inputScope: z.array(PathSchema).min(1), permittedOutputs: z.array(PathSchema), expectedExit: z.number().int(),
});
export type CommandDefinition = z.infer<typeof CommandDefinitionSchema>;
const PolicySchema = z.strictObject({
  platform: z.enum(['windows','wsl2']), readRoots: z.array(PathSchema).min(1), writeRoots: z.array(PathSchema), deniedSensitiveRoots: z.array(PathSchema).min(1),
  network: z.strictObject({ allowedDomains: z.array(TextSchema), deniedDomains: z.array(TextSchema) }),
  verifier: z.strictObject({ executable: PathSchema, runtimePath: PathSchema, version: TextSchema, sha256: HashSchema,
    settingsPath: PathSchema, settingsHash: HashSchema }), registry: z.array(CommandDefinitionSchema).min(1),
});
export const BoundaryProfileSchema = z.strictObject({ ...PolicySchema.shape, ...ExecutionOwnerSchema.shape,
  leaseTtlMs: PositiveLimitSchema.max(10000), deadline: PositiveLimitSchema,
  qualification: z.strictObject({ environment: z.enum(['windows','wsl2']), qualificationRef: TextSchema,
    runtimeVersion: TextSchema, runtimeHash: HashSchema, policyHash: HashSchema, seccompUnixSockets: z.boolean(),
    inheritedDescriptorsRestricted: z.boolean(), networkProxy: z.boolean().optional() }),
});
export type BoundaryProfile = z.infer<typeof BoundaryProfileSchema>;
function fail(message: string): Result<LaunchSpec> { return { ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message, evidenceIds: [] } }; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Fixed controller registry only. Qualification lookup remains external at dispatch; a compiler cannot grant authority. */
export function compileCommandBoundary(input: CommandDefinition, profileInput: BoundaryProfile): Result<LaunchSpec> {
  const commandParsed = CommandDefinitionSchema.safeParse(input); const profileParsed = BoundaryProfileSchema.safeParse(profileInput);
  if (!commandParsed.success || !profileParsed.success) return fail('Fixed command and independently qualified verifier profile required');
  const command = commandParsed.data; const profile = profileParsed.data; const qualification = profile.qualification;
  const policy = PolicySchema.parse(Object.fromEntries(Object.keys(PolicySchema.shape).map(key => [key, profile[key as keyof BoundaryProfile]])));
  if (qualification.environment !== profile.platform || qualification.runtimeVersion !== profile.verifier.version ||
      qualification.runtimeHash !== profile.verifier.sha256 || qualification.policyHash !== hash(policy) ||
      !qualification.inheritedDescriptorsRestricted || (profile.platform === 'wsl2' && !qualification.seccompUnixSockets)) return fail('Exact verifier runtime/policy qualification is stale or unavailable');
  const registered = profile.registry.filter(entry => entry.id === command.id);
  if (registered.length !== 1 || hash(registered[0]) !== hash(command)) return fail('Command is not the unchanged fixed registry definition');
  const paths = profile.platform === 'windows' ? win32 : posix;
  const absolute = (value: string) => paths.isAbsolute(value) && !value.split(/[\\/]/).some(part => part === '..' || part === '.') &&
    (profile.platform !== 'wsl2' || !value.includes('\\'));
  const contained = (value: string, root: string) => {
    const relative = paths.relative(root, value);
    return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative));
  };
  const denied = (value: string) => profile.deniedSensitiveRoots.some(root => contained(value, root));
  if ([command.executable,command.cwd,...command.inputScope,...command.permittedOutputs,...profile.readRoots,...profile.writeRoots,
      ...profile.deniedSensitiveRoots,profile.verifier.executable,profile.verifier.runtimePath,profile.verifier.settingsPath].some(value => !absolute(value)) ||
      !profile.readRoots.some(root => contained(command.cwd,root)) || denied(command.cwd) || denied(command.executable) ||
      command.inputScope.some(value => denied(value) || !profile.readRoots.some(root => contained(value,root))) ||
      command.permittedOutputs.some(value => denied(value) || !profile.writeRoots.some(root => contained(value,root))) ||
      Object.keys(command.environment).some(key => !command.approvedEnvironmentKeys.includes(key)) ||
      new Set(command.approvedEnvironmentKeys.map(key => profile.platform === 'windows' ? key.toUpperCase() : key)).size !== command.approvedEnvironmentKeys.length ||
      Object.keys(command.environment).some(key => /^(?:LD_|DYLD_|NODE_OPTIONS$|BASH_ENV$|ENV$|SHELLOPTS$|PYTHONPATH$|PYTHONHOME$)/i.test(key))) return fail('Command paths/environment exceed approved fixed scope');
  if (profile.readRoots.some(read => profile.deniedSensitiveRoots.some(sensitive => contained(read,sensitive) || contained(sensitive,read)))) {
    return fail('Read grants overlap denied sensitive roots');
  }
  let argv: string[];
  if (profile.platform === 'wsl2') {
    if (!profile.deniedSensitiveRoots.some(root => contained('/sys/fs/cgroup',root)) ||
        !profile.deniedSensitiveRoots.some(root => /^\/run(?:\/|$)/.test(root))) return fail('Cgroup writes and execution-broker paths must be denied');
    // Pinned SRT argv mode quotes its internal shell layer; -c raw command mode is prohibited.
    argv = [profile.verifier.runtimePath,'--settings',profile.verifier.settingsPath,'--',command.executable,...command.argv];
  } else {
    if (profile.network.allowedDomains.length && !qualification.networkProxy) return fail('Native domain restrictions require independently qualified proxy enforcement');
    const name = 'ouroboros_verifier'; const filesystem: Record<string,string> = { ':minimal':'read' };
    for (const root of profile.readRoots) filesystem[root] = 'read';
    for (const root of profile.writeRoots) filesystem[root] = 'write';
    for (const root of profile.deniedSensitiveRoots) filesystem[root] = 'deny';
    const table = Object.entries(filesystem).map(([key,value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
    const domainTable = [...profile.network.allowedDomains.map(domain => `${JSON.stringify(domain)}="allow"`),
      ...profile.network.deniedDomains.map(domain => `${JSON.stringify(domain)}="deny"`)].join(',');
    // Replace the entire named table: no inherited extends/workspace roots/socket allowances.
    const network = `enabled=${profile.network.allowedDomains.length > 0},allow_local_binding=false,allow_upstream_proxy=false,dangerously_allow_all_unix_sockets=false,dangerously_allow_non_loopback_proxy=false,domains={${domainTable}}`;
    argv = ['-c','windows.sandbox="mxc"','-c',`permissions.${name}={filesystem={${table}},network={${network}}}`];
    if (profile.network.allowedDomains.length) argv.push('-c','features.network_proxy=true');
    argv.push('sandbox','--include-managed-config','--permission-profile',name,'--cd',command.cwd,'--',command.executable,...command.argv);
  }
  const deadline = Math.min(profile.deadline, Date.now() + command.timeoutMs);
  if (deadline <= Date.now()) return fail('Verification deadline expired');
  return { ok:true, value: LaunchSpecSchema.parse({ runId:profile.runId,generation:profile.generation,actionId:profile.actionId,role:profile.role, executable:profile.verifier.executable,
    argv,cwd:command.cwd,env:command.environment,boundaryHash:qualification.policyHash,
    authorization:{kind:'qualified',qualificationRef:qualification.qualificationRef},stdin:'closed',leaseTtlMs:profile.leaseTtlMs,deadline }) };
}
