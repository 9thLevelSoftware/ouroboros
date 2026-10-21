import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, existsSync, copyFileSync, constants } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { release, arch } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { Result } from '../contracts/common.ts';
import type { LaunchSpec, Supervisor } from '../contracts/execution.ts';
import { openStore, storeError } from '../store/database.ts';
import { installedCodexVersion, resolveExecutable, supportedNodeVersion } from '../runtime/compatibility.ts';
import { QualificationLedger, targetFingerprint, type QualificationTarget, type QualificationRequest, type QualificationReport } from './ledger.ts';
import { createProbeManifest, fingerprint, startupBlockers, REQUIRED_CODEX_WINDOWS_PROBES, type ProbeManifest } from './probes.ts';
import { createSliceRequest, inspectConfigLayers, runVerifierSlice, sealVerifierSlice, slicePermit } from './verifier-slice.ts';
import { createSupervisor } from '../runtime/supervisor.ts';

export type QualificationArguments = { provider: 'codex'; environment: 'windows'; fixtureRoot: string; model: string; effort: string };
export function parseQualificationArguments(argv: string[]): Result<QualificationArguments> {
 const flags = new Map<string, string>(); const known = ['--provider', '--environment', '--fixture-root', '--model', '--effort'];
 for (let i = 0; i < argv.length; i += 2) {
  if (!known.includes(argv[i]) || flags.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) return storeError('INVALID_ARGUMENTS', 'Unique structured qualification arguments required');
  flags.set(argv[i], argv[i + 1]);
 }
 const fixtureRoot = flags.get('--fixture-root'); const model = flags.get('--model'); const effort = flags.get('--effort') ?? 'high';
 if (flags.get('--provider') !== 'codex' || flags.get('--environment') !== 'windows' || !fixtureRoot || !/^[A-Za-z]:[\\/]/.test(fixtureRoot) ||
  fixtureRoot.split(/[\\/]/).some(p => p === '..' || p === '.') || fixtureRoot.slice(2).includes(':') || /[\u0000-\u001f\u007f]/.test(fixtureRoot) ||
  !model || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/.test(model) || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort))
  return storeError('INVALID_ARGUMENTS', 'Explicit native Codex, disposable absolute fixture root, model and effort required');
 return { ok: true, value: { provider: 'codex', environment: 'windows', fixtureRoot: win32.normalize(fixtureRoot), model, effort } };
}

/** Staged qualification: exact metadata persists; live launch remains unavailable
 * until the coordinator reviews independently established pre-start controls.
 * No runtime/sandbox/network/model callback exists in this stage. */
export async function qualify(target: QualificationTarget, approval: QualificationRequest, options?: { ledger: QualificationLedger }): Promise<QualificationReport> {
 if (!options) throw Error('Trusted durable qualification ledger required');
 if (targetFingerprint(target) !== approval.targetHash) throw Error('Qualification target changed');
 const history = options.ledger.history(approval.id);
 if (!history.ok) throw Error('Durable current approval required');
 if (fingerprint(history.value.request) !== fingerprint(approval)) throw Error('Qualification approval changed');
 const report = options.ledger.report(approval.id);
 if (!report.ok) throw Error('Qualification report persistence failed');
 return report.value;
}

function fileHash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function sourceHash(root: string, paths: string[]): string { return fingerprint(paths.map(path => ({ path, sha256: fileHash(join(root, path)) }))); }
/** Includes executed launch validation/schema bytes and expected dependency resolution.
 * Installed dependency bytes require a separate verified preparation receipt. */
export const CODEX_ADAPTER_SOURCES=['src/providers/codex/adapter.ts','src/providers/codex/transport.ts','src/providers/codex/policy.ts','src/providers/codex/startup-metadata.ts','src/providers/codex/launch-config.ts','src/runtime/compatibility.ts','src/qualification/codex-startup-authority.ts','src/providers/provider.ts','src/contracts/provider.ts','src/contracts/execution.ts','src/contracts/common.ts','src/runtime/command-boundary.ts','package.json','package-lock.json'] as const;
export function codexAdapterSourceHash(root:string):string{return sourceHash(root,[...CODEX_ADAPTER_SOURCES]);}
function contained(path: string, root: string): boolean { const relative = win32.relative(root, path); return relative === '' || relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative); }
function noAliases(path: string): void {
 let current = win32.parse(path).root;
 for (const segment of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
  current = win32.join(current, segment); if (!existsSync(current)) continue;
  if (lstatSync(current).isSymbolicLink() || win32.normalize(realpathSync.native(current)).toLowerCase() !== win32.normalize(current).toLowerCase()) throw Error('Fixture/controller path alias rejected');
 }
}
export type PreparedQualification = { target: QualificationTarget; manifest: ProbeManifest; request: QualificationRequest; report: QualificationReport };
export type QualificationCli = (args: QualificationArguments, showManifest: (manifest: ProbeManifest) => void) => Promise<PreparedQualification>;

type CliOptions = { installationRoot?: string; controllerRoot?: string; runtimePath?: string; helperPath?: string; pinnedRuntimeHash?: string;
 supervisorFor?: (authorize: (spec: Readonly<LaunchSpec>) => Promise<boolean>) => Supervisor; knownFolders?: () => { programData: string; profile: string } };
/** Every controller source the slice loads or depends on, plus the lockfile and fixed drivers; sorted, repository-relative. */
export const QUALIFICATION_RESOURCE_PATHS = [
 'tests/fixtures/boundary/boundary-driver.mjs',
 'tests/fixtures/boundary/heartbeat.mjs',
 'tests/fixtures/boundary/campaign-boundary-driver.mjs',
 'tests/fixtures/boundary/controlled-endpoint.mjs',
 'tests/fixtures/boundary/session-activity.mjs',
 'tests/fixtures/boundary/disposable-controller.mjs',
] as const;
export function controllerSources(root: string): string[] {
 const files: string[] = [];
 const walk = (relative: string) => { for (const item of readdirSync(join(root, relative), { withFileTypes: true })) { const next = `${relative}/${item.name}`; if (item.isDirectory()) walk(next); else if (item.isFile()) files.push(next); } };
 walk('src');
 return [...files, 'package.json', 'package-lock.json', ...QUALIFICATION_RESOURCE_PATHS].sort();
}
/** The same source/resource projection is used by target preparation and rechecks. */
export function qualificationControllerSourceHash(root: string): string { return sourceHash(root, controllerSources(root)); }
/** Passive target/manifest derivation shared by full qualification and the verifier slice. Writes nothing. */
function prepareTarget(options: CliOptions, args: QualificationArguments) {
 if (process.platform !== 'win32') throw Error('Native Codex qualification requires Windows');
 const root = resolve(options.installationRoot ?? process.cwd());
 const controllerRoot = options.controllerRoot ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Ouroboros', 'controller') : undefined);
 const runtimeCandidate = options.runtimePath ?? (process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe') : undefined);
 if (!controllerRoot || !runtimeCandidate) throw Error('Runtime and trusted controller roots required');
 const runtimePath=resolveExecutable(runtimeCandidate);
 if(!supportedNodeVersion(process.versions.node))throw Error('NODE_CAPABILITY_UNSUPPORTED: Node >=24 required');
 const helperPath = resolveExecutable(options.helperPath ?? join(root, 'native/supervisor/target/debug/ouroboros-supervisor.exe'));
 const scopedScratch = join(root, '.superpowers/sdd/2026-10-13-ouroboros-implementation/task-7-disposable');
 const fixtureRoot = win32.normalize(args.fixtureRoot);
 if (existsSync(fixtureRoot) || fixtureRoot === win32.parse(fixtureRoot).root || contained(fixtureRoot, controllerRoot) || contained(controllerRoot, fixtureRoot) ||
  contained(runtimePath, fixtureRoot) || contained(helperPath, fixtureRoot) || contained(root, fixtureRoot) ||
  (contained(fixtureRoot, root) && (!contained(fixtureRoot, scopedScratch) || fixtureRoot === scopedScratch))) throw Error('Fresh separately scoped disposable fixture root required');
 noAliases(fixtureRoot); noAliases(controllerRoot);
 // pinnedRuntimeHash is a programmatic test seam only; the CLI never passes it.
 if (options.pinnedRuntimeHash!==undefined&&fileHash(runtimePath)!==options.pinnedRuntimeHash) throw Error('Qualification runtime identity changed');
 const runtimeVersion=installedCodexVersion(runtimePath);
 const os = { platform: 'win32' as const, architecture: arch(), release: release(), sha256: fingerprint({ platform: process.platform, architecture: arch(), release: release(), node: process.version }) };
 const target: QualificationTarget = { schemaVersion: 1, provider: 'codex', environment: 'windows', runtime: { path: runtimePath, version: runtimeVersion, sha256: fileHash(runtimePath) },
  adapter: { version: '0.1.0', sha256: codexAdapterSourceHash(root) },
  helper: { path: helperPath, version: '0.1.0', sha256: fileHash(helperPath) }, verifier: { path: runtimePath, version: runtimeVersion, sha256: fileHash(runtimePath),
   wrapperHash: fingerprint({ node: { path: process.execPath, version: process.version, sha256: fileHash(process.execPath) }, source: qualificationControllerSourceHash(root) }) },
  os, policyHash: '0'.repeat(64), startupConfigHash: '0'.repeat(64), model: args.model, effort: args.effort };
 const candidate = createProbeManifest(fixtureRoot, target);
 target.policyHash = fingerprint({ profiles: candidate.profiles, network: candidate.network, requiredProbes: candidate.probes });
 target.startupConfigHash = fingerprint(candidate.startup);
 return { root, controllerRoot, runtimePath, helperPath, fixtureRoot, target, manifest: createProbeManifest(fixtureRoot, target) };
}
function writeFixture(root: string, fixtureRoot: string, manifest: ProbeManifest): void {
 mkdirSync(fixtureRoot, { recursive: true });
 for (const path of Object.values(manifest.roots)) mkdirSync(path, { recursive: true });
 for (const sentinel of manifest.sentinels) writeFileSync(sentinel.path, sentinel.bytes, { flag: 'wx' });
 writeFileSync(join(manifest.roots.workspace, 'allowed.txt'), 'allowed fixture baseline\r\n', { flag: 'wx' });
 for (const path of QUALIFICATION_RESOURCE_PATHS) copyFileSync(join(root, path), join(manifest.roots.driver, win32.basename(path)), constants.COPYFILE_EXCL);
 writeFileSync(join(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
}

/** Construction is passive. The closure is called only by explicit doctor --qualify. */
export function createQualificationCli(options: CliOptions = {}): QualificationCli {
 return async (args, showManifest) => {
  const { root, controllerRoot, fixtureRoot, target, manifest } = prepareTarget(options, args);
  // Display before fixture/controller writes. Neither acceptance of argv nor this
  // manifest grants permission for runtime startup or represents observed policy.
  showManifest(manifest);
  writeFixture(root, fixtureRoot, manifest);
  const store = openStore(controllerRoot);
  try {
   const repoId = randomUUID(); const runId = randomUUID();
   const run = store.createRun(repoId, { schemaVersion: 1, id: runId, taskId: randomUUID(), phase: 'CREATED', blocker: null, generation: 0,
    baselineRef: null, candidateRef: null, sessionRef: null, repairCount: 0, cumulativeBudgets: { activeMs: 0, outputBytes: 0, tokens: null, requests: null, money: null }, pendingActionIds: [] });
   if (!run.ok) throw Error('Qualification run persistence failed');
   const owner = store.claim(repoId, runId); if (!owner.ok) throw Error('Qualification ownership unavailable');
   const now = Date.now();
   const request: QualificationRequest = { schemaVersion: 1, id: randomUUID(), owner: owner.value, actionId: randomUUID(), targetHash: targetFingerprint(target), manifestHash: fingerprint(manifest),
    fixtureRoots: [fixtureRoot], permittedEndpoints: manifest.network.endpoints.map(e => e.url), approvedProbeIds: REQUIRED_CODEX_WINDOWS_PROBES.map(p => p.id),
    budget: { maxAttempts: 96, activeMs: 600000, outputBytes: 10485760 }, approvedAt: now, expiresAt: now + 600000 };
   // Bare CLI flags authorize metadata/fixture preflight only. Startup and supervisor
   // authority require independent concrete review; no default self-grant is provided.
   const ledger = new QualificationLedger(store, { authorizeCurrent: () => false });
   const approved = ledger.approve(target, request); if (!approved.ok) throw Error('Qualification approval persistence failed');
   const report = await qualify(target, request, { ledger });
   const released = store.release(owner.value); if (!released.ok) throw Error('Qualification remains recovery-required');
   return { target, manifest, request, report };
  } finally { store.close(); }
 };
}

/** ProgramData and the profile folder exactly as the pinned loader and Codex home resolution see them (known folders),
 * each cross-checked with its environment variable. */
export function parseKnownFolders(output: string, env: { ProgramData?: string; USERPROFILE?: string }): { programData: string; profile: string } {
 const [programData, profile] = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
 const same = (a: string | undefined, b: string | undefined) => !!a && !!b && win32.isAbsolute(a) && win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
 if (!same(programData, env.ProgramData) || !same(profile, env.USERPROFILE)) throw Error('Known folders could not be resolved consistently');
 return { programData: win32.normalize(programData), profile: win32.normalize(profile) };
}
/** Runs one read-only query through the absolute system PowerShell, never a PATH lookup. */
function knownFolders(): { programData: string; profile: string } {
 const shell = process.env.SystemRoot ? win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
 if (!shell || !existsSync(shell)) throw Error('System PowerShell required to resolve known folders');
 const known = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('CommonApplicationData'); [Environment]::GetFolderPath('UserProfile')"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000, shell: false });
 if (known.status !== 0) throw Error('Known folders could not be resolved');
 return parseKnownFolders(known.stdout, process.env);
}
export type VerifierSliceCliResult = { launched: false; sealHash: string; seal: unknown } |
 { launched: true; sealHash: string; requestId: string; passed: boolean; outcome: { probes: Array<{ probeId: string; status: string; result: string; reasonCode: string; evidenceIds: string[] }>; effectiveProfileProven: boolean; stoppedAt: string | null } | null;
  error: { code: string; message: string } | null; report: QualificationReport | null; ownershipReleased: boolean };
export type VerifierSliceCli = (args: QualificationArguments, approveLaunch: string | null) => Promise<VerifierSliceCliResult>;

/** Passive unless approveLaunch equals the freshly recomputed seal hash. The dry run creates no fixture or store; it runs only
 * the read-only ProgramData query. The seal binds the full target hash, including the controller wrapper sources. */
export function createVerifierSliceCli(options: CliOptions = {}): VerifierSliceCli {
 return async (args, approveLaunch) => {
  const { root, controllerRoot, helperPath, fixtureRoot, target, manifest } = prepareTarget(options, args);
  if (process.env.CODEX_HOME) throw Error('CODEX_HOME relocation is unsupported; the child resolves the default Codex home');
  const folders = (options.knownFolders ?? knownFolders)(); const programDataDir = folders.programData; const codexHome = join(folders.profile, '.codex');
  const inspectConfig = () => inspectConfigLayers({ programDataDir, codexHome, workspace: manifest.roots.workspace });
  const config = inspectConfig(); if (!config.ok) throw Error(config.error.message);
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemDrive']) { const value = process.env[key]; if (!value) throw Error(`${key} required`); env[key] = value; }
  env.TEMP = env.TMP = win32.join(fixtureRoot, 'trusted-temp');
  const sealed = sealVerifierSlice(manifest, { codex: { path: target.verifier.path, sha256: target.verifier.sha256 }, helper: { path: helperPath, sha256: target.helper.sha256 },
   node: { path: process.execPath, sha256: fileHash(process.execPath) }, driverSha256: fileHash(join(root, 'tests/fixtures/boundary/boundary-driver.mjs')), env, config: config.value, targetHash: targetFingerprint(target) });
  if (!sealed.ok) throw Error(sealed.error.message);
  const seal = sealed.value;
  if (approveLaunch === null) {
   // Environment values are non-secret paths, bound by hash; only keys are displayed.
   const { env: _env, ...view } = seal;
   return { launched: false, sealHash: seal.sealHash, seal: { ...view, envKeys: Object.keys(seal.env), envHash: fingerprint(seal.env) } };
  }
  if (approveLaunch !== seal.sealHash) throw Error('Approved seal does not match the recomputed launch; nothing was created');
  // Durable approval precedes any fixture write; a failure before launch releases ownership.
  const store = openStore(controllerRoot);
  try {
   const repoId = randomUUID(); const runId = randomUUID();
   const run = store.createRun(repoId, { schemaVersion: 1, id: runId, taskId: randomUUID(), phase: 'CREATED', blocker: null, generation: 0,
    baselineRef: null, candidateRef: null, sessionRef: null, repairCount: 0, cumulativeBudgets: { activeMs: 0, outputBytes: 0, tokens: null, requests: null, money: null }, pendingActionIds: [] });
   if (!run.ok) throw Error('Qualification run persistence failed');
   const owner = store.claim(repoId, runId); if (!owner.ok) throw Error('Qualification ownership unavailable');
   const request = createSliceRequest({ owner: owner.value, targetHash: targetFingerprint(target), manifestHash: fingerprint(manifest), fixtureRoot, now: Date.now() });
   const ledger = new QualificationLedger(store, { authorizeCurrent: slicePermit(seal, request.id) });
   try {
    const approved = ledger.approve(target, request); if (!approved.ok) throw Error('Qualification approval persistence failed');
    writeFixture(root, fixtureRoot, manifest); mkdirSync(seal.env.TEMP, { recursive: true });
    writeFileSync(join(fixtureRoot, 'seal.json'), JSON.stringify(seal, null, 2) + '\n', { flag: 'wx' });
   } catch (error) { store.release(owner.value); throw error; }
   const outcome = await runVerifierSlice(seal, { ledger, store, requestId: request.id, supervisorFor: options.supervisorFor ?? (authorize => createSupervisor({ helperPath, authorize })), inspectConfig });
   const report = ledger.report(request.id);
   const released = store.release(owner.value);
   const probes = outcome.ok ? outcome.value.attempts.map(a => ({ probeId: a.probeId, status: a.observation?.status ?? 'UNTESTED', result: a.observation?.result ?? 'not_attempted',
    reasonCode: a.observation?.reasonCode ?? 'UNRESOLVED', evidenceIds: a.observation?.evidence.map(e => e.id) ?? [] })) : [];
   return { launched: true, sealHash: seal.sealHash, requestId: request.id, passed: outcome.ok && outcome.value.effectiveProfileProven && probes.length === 2 && probes.every(p => p.status === 'PASS'),
    outcome: outcome.ok ? { probes, effectiveProfileProven: outcome.value.effectiveProfileProven, stoppedAt: outcome.value.stoppedAt } : null,
    error: outcome.ok ? null : { code: outcome.error.code, message: outcome.error.message }, report: report.ok ? report.value : null, ownershipReleased: released.ok };
  } finally { store.close(); }
 };
}
