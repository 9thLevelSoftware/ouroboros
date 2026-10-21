import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, win32 } from 'node:path';
import type { Result } from '../contracts/common.ts';
import { WindowsDrainEvidenceSchema, WindowsOwnershipReceiptSchema, type ChildOutput, type LaunchSpec, type OwnedExecution, type Supervisor } from '../contracts/execution.ts';
import { storeError, type RunStore } from '../store/database.ts';
import { publishArtifact } from '../store/artifacts.ts';
import { fingerprint, type ProbeManifest } from './probes.ts';
import { buildCodexLaunchConfig, CODEX_CONFIG_SCHEMA, restrictedCodexOverrides } from '../providers/codex/launch-config.ts';
import type { ProbeAttempt, ProbeObservation, QualificationLedger, QualificationRequest } from './ledger.ts';

/** First live verifier slice. The read denial runs first: the allowed edit cannot by
 * itself distinguish ouroboros_verifier from a silent requirements fallback, because
 * every fallback profile keeps the workspace writable while denying nothing we read. */
export const VERIFIER_SLICE_PROBES = Object.freeze(['verifier.denied_sensitive_read', 'verifier.allowed_command'] as const);
export type SliceProbe = typeof VERIFIER_SLICE_PROBES[number];
const OPERATIONS: Readonly<Record<SliceProbe, string>> = Object.freeze({ 'verifier.denied_sensitive_read': 'denied_sensitive_read', 'verifier.allowed_command': 'allowed_edit' });
// SystemDrive is required by the MXC launcher's known-folder lookup (ProgramData is stored as %SystemDrive%\ProgramData);
// without it the launcher fails before any sandbox call (live launch da0659a8…, confirmed by the helper-path diagnostic).
const ENV_KEYS = Object.freeze(['SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemDrive', 'TEMP', 'TMP']);
// Node otherwise realpaths the main script by lstat-ing every ancestor, which the narrow read grants deny (Node v24.19.0
// run_main.js:38-42, esm/resolve.js:275). Driver bytes and the permission profile are unchanged.
const NODE_FLAGS = Object.freeze(['--preserve-symlinks-main']);
const POSTIMAGE = 'ATTEMPTED_DISPOSABLE_MUTATION\r\n';
const LIMITS = Object.freeze({ caseMs: 60000, outputBytes: 65536, leaseTtlMs: 10000, renewalMs: 2000 });

// Pinned rust-v0.162.1 PermissionProfileToml/NetworkToml (core/config.schema.json). Serde accepts unknown
// keys on the sandbox path (strict config is off), so every key is checked here and inheritance is refused.
const NETWORK_REQUIRED_FALSE = ['enabled', 'allow_local_binding', 'allow_upstream_proxy', 'dangerously_allow_all_unix_sockets', 'dangerously_allow_non_loopback_proxy'];
export function validateVerifierProfile(profile: unknown): Result<void> {
 const invalid = (message: string) => storeError<void>('VERIFIER_PROFILE_INVALID', message);
 const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
 if (!plain(profile) || Object.keys(profile).sort().join() !== 'filesystem,network') return invalid('Only explicit filesystem and network fields are allowed; no extends, workspace_roots or description');
 if (!plain(profile.filesystem) || !Object.keys(profile.filesystem).length) return invalid('Explicit filesystem entries required');
 for (const [path, mode] of Object.entries(profile.filesystem)) if ((path !== ':minimal' && !win32.isAbsolute(path)) || !['read', 'write', 'deny'].includes(mode as string)) return invalid('Filesystem entries must be absolute paths with read, write or deny');
 const network = profile.network; if (!plain(network)) return invalid('Explicit network table required');
 if (Object.keys(network).sort().join() !== [...NETWORK_REQUIRED_FALSE, 'domains'].sort().join()) return invalid('Network fields must be exactly the explicit disabled set');
 if (NETWORK_REQUIRED_FALSE.some(key => network[key] !== false) || !plain(network.domains) || Object.keys(network.domains).length) return invalid('Network must be disabled with no domains');
 return { ok: true, value: undefined };
}

// shell_environment_policy shapes the sandboxed driver's environment (pinned debug_sandbox.rs:258), so a preload
// there could print a forged RESULT line. Any key path touching these segments blocks the run.
const BLOCKED_SEGMENTS = new Set(['permissions', 'default_permissions', 'allowed_permission_profiles', 'permission_profile', 'profile', 'profiles', 'shell_environment_policy']);
const WATCHED_SEGMENTS = new Set(['sandbox_mode', 'windows', 'features']);
/** Parses a TOML dotted key (bare, "basic" or 'literal' segments) from `start` up to `terminator`; null when malformed. */
function parseKey(line: string, start: number, terminator: string): { segments: string[]; end: number } | null {
 const segments: string[] = []; let i = start;
 for (;;) {
  while (line[i] === ' ' || line[i] === '\t') i++;
  // Codex decodes escapes in quoted keys ("permissions" is permissions), so any escape is treated as unparseable.
  if (line[i] === '"') { let segment = ''; i++; while (i < line.length && line[i] !== '"') { if (line[i] === '\\') return null; segment += line[i]; i++; } if (line[i] !== '"') return null; i++; segments.push(segment); }
  else if (line[i] === "'") { const close = line.indexOf("'", i + 1); if (close === -1) return null; segments.push(line.slice(i + 1, close)); i = close + 1; }
  else { const bare = /^[A-Za-z0-9_-]+/.exec(line.slice(i)); if (!bare) return null; segments.push(bare[0]); i += bare[0].length; }
  while (line[i] === ' ' || line[i] === '\t') i++;
  if (line[i] === '.') { i++; continue; }
  return line.startsWith(terminator, i) ? { segments, end: i + terminator.length } : null;
 }
}
type ValueState = { mode: 'none' | 'mlbasic' | 'mlliteral'; depth: number; malformed: boolean };
/** Tracks strings, multi-line strings and bracket depth so value text is never mistaken for keys. */
function scanValue(state: ValueState, line: string, start: number): void {
 for (let i = start; i < line.length; i++) {
  if (state.mode === 'mlbasic') { if (line[i] === '\\') i++; else if (line.startsWith('"""', i)) { state.mode = 'none'; i += 2; } continue; }
  if (state.mode === 'mlliteral') { if (line.startsWith("'''", i)) { state.mode = 'none'; i += 2; } continue; }
  if (line.startsWith('"""', i)) { state.mode = 'mlbasic'; i += 2; }
  else if (line.startsWith("'''", i)) { state.mode = 'mlliteral'; i += 2; }
  else if (line[i] === '"') { i++; while (i < line.length && line[i] !== '"') { if (line[i] === '\\') i++; i++; } if (i >= line.length) state.malformed = true; }
  else if (line[i] === "'") { const close = line.indexOf("'", i + 1); if (close === -1) { state.malformed = true; return; } i = close; }
  else if (line[i] === '#') return;
  else if (line[i] === '[' || line[i] === '{') state.depth++;
  else if (line[i] === ']' || line[i] === '}') state.depth--;
 }
}
/** Value-free structural scan. Anything it cannot parse blocks (fails closed); values are never returned. */
export function scanConfigKeys(text: string): { blocked: string[]; watched: string[] } {
 const blocked: string[] = []; const watched: string[] = []; let table: string[] = []; const value: ValueState = { mode: 'none', depth: 0, malformed: false };
 const classify = (parts: string[], header = false) => {
  if (parts.some(p => BLOCKED_SEGMENTS.has(p))) blocked.push(parts.join('.')); else if (!header && parts.some(p => WATCHED_SEGMENTS.has(p))) watched.push(parts.join('.')); };
 for (const raw of text.split(/\r?\n/)) {
  if (value.mode !== 'none' || value.depth > 0) { scanValue(value, raw, 0); if (value.malformed || value.depth < 0) blocked.push('<unparseable>'); continue; }
  const line = raw.trim(); if (!line || line.startsWith('#')) continue;
  if (line.startsWith('[')) {
   const array = line.startsWith('[['); const parsed = parseKey(line, array ? 2 : 1, array ? ']]' : ']');
   if (!parsed || !/^\s*(#.*)?$/.test(line.slice(parsed.end))) { blocked.push('<unparseable>'); table = []; continue; }
   table = parsed.segments; classify(table, true); continue;
  }
  const parsed = parseKey(line, 0, '='); if (!parsed) { blocked.push('<unparseable>'); continue; }
  classify([...table, ...parsed.segments]); scanValue(value, line, parsed.end);
  if (value.malformed || value.depth < 0) { blocked.push('<unparseable>'); value.malformed = false; value.depth = 0; }
 }
 if (value.mode !== 'none' || value.depth !== 0) blocked.push('<unparseable>');
 return { blocked, watched };
}
/** Existence that distinguishes absence from an unreadable or unexpected entry (which must refuse). */
function entry(path: string): Stats | null {
 try { return statSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export type ConfigLayerObservation = { schemaVersion: 1; systemConfigPresent: false; requirementsPresent: false; userConfig: { sha256: string | null; watchedKeys: string[] }; projectMarkersAbsent: true };
/** Local layers visible to `codex sandbox --include-managed-config` on Windows (pinned loader). The cloud bundle is
 * not observable offline; the paired read denial is its behavioral guard. */
export function inspectConfigLayers(input: { programDataDir: string; codexHome: string; workspace: string; stopAt?: string }): Result<ConfigLayerObservation> {
 const refuse = (message: string) => storeError<ConfigLayerObservation>('CONFIG_LAYER_UNSUPPORTED', message);
 try {
  for (const directory of [join(input.programDataDir, 'OpenAI'), join(input.programDataDir, 'OpenAI', 'Codex')]) { const found = entry(directory); if (found && !found.isDirectory()) return refuse('System config location is not a plain directory'); }
  const system = join(input.programDataDir, 'OpenAI', 'Codex');
  if (entry(join(system, 'config.toml')) || entry(join(system, 'requirements.toml'))) return refuse('System config or requirements layer present; exact profile is unproven');
  let current = win32.normalize(input.workspace); const stop = input.stopAt ? win32.normalize(input.stopAt).toLowerCase() : null;
  for (;;) {
   if (entry(join(current, '.codex')) || entry(join(current, '.git'))) return refuse('Project config or root marker present at or above the workspace');
   const parent = win32.dirname(current); if (parent === current || current.toLowerCase() === stop) break; current = parent;
  }
  const userPath = join(input.codexHome, 'config.toml'); let userConfig: ConfigLayerObservation['userConfig'] = { sha256: null, watchedKeys: [] };
  if (entry(userPath)) {
   const bytes = readFileSync(userPath); const scan = scanConfigKeys(bytes.toString('utf8'));
   if (scan.blocked.length) return refuse('User config defines or selects permission profiles');
   userConfig = { sha256: createHash('sha256').update(bytes).digest('hex'), watchedKeys: scan.watched };
  }
  return { ok: true, value: { schemaVersion: 1, systemConfigPresent: false, requirementsPresent: false, userConfig, projectMarkersAbsent: true } };
 } catch { return refuse('Config layers could not be inspected'); }
}

type Pinned = { path: string; sha256: string };
export type SealedVerifierSlice = { schemaVersion: 1; fixtureRoot: string; workspace: string; codex: Pinned; helper: Pinned; node: Pinned; driver: Pinned;
 argvPrefix: string[]; env: Record<string, string>; config: ConfigLayerObservation; launches: Record<SliceProbe, { operation: string; argv: string[] }>;
 sentinels: { sensitive: string; allowed: string }; limits: typeof LIMITS; targetHash: string; sealHash: string };
/** targetHash binds the complete target, including the wrapper hash over the controller sources that enforce and classify this run. */
export function sealVerifierSlice(manifest: ProbeManifest, input: { codex: Pinned; helper: Pinned; node: Pinned; driverSha256: string; env: Record<string, string>; config: ConfigLayerObservation; targetHash: string }): Result<SealedVerifierSlice> {
 const profile = validateVerifierProfile(manifest.profiles.initialNetworkDenied); if (!profile.ok) return profile;
 const config=buildCodexLaunchConfig({entryPoint:'verifier',schema:CODEX_CONFIG_SCHEMA,baseline:{permission:{kind:'named-profile',name:'ouroboros_verifier'},
  overrides:restrictedCodexOverrides({profileName:'ouroboros_verifier',profile:manifest.profiles.initialNetworkDenied,defaultPermissions:false})},
  verifier:{cwd:manifest.roots.workspace,command:[input.node.path]}});
 if(!config.ok)return storeError('VERIFIER_PROFILE_INVALID','Verifier launch configuration failed structural preflight');
 const expectedPrefix=config.value.argv.slice(0,-1);
 if (JSON.stringify(manifest.verifier.argvPrefix) !== JSON.stringify(expectedPrefix)) return storeError('VERIFIER_PROFILE_INVALID', 'Manifest verifier argv does not carry the validated profile');
 if (Object.keys(input.env).sort().join() !== [...ENV_KEYS].sort().join() || Object.entries(input.env).some(([key, v]) => key !== 'SystemDrive' && !win32.isAbsolute(v)) ||
  !/^[A-Za-z]:$/.test(input.env.SystemDrive) || win32.parse(input.env.SystemRoot).root.slice(0, 2).toUpperCase() !== input.env.SystemDrive.toUpperCase() ||
  win32.normalize(input.env.TEMP) !== win32.join(manifest.fixtureRoot, 'trusted-temp') || input.env.TMP !== input.env.TEMP) return storeError('INVALID_LAUNCH_SPEC', 'Exact constrained child environment required');
 if (![input.codex, input.helper, input.node].every(p => win32.isAbsolute(p.path) && /^[a-f0-9]{64}$/.test(p.sha256)) || !/^[a-f0-9]{64}$/.test(input.driverSha256) ||
  !/^[a-f0-9]{64}$/.test(input.targetHash)) return storeError('INVALID_LAUNCH_SPEC', 'Pinned absolute binaries and target hash required');
 const driver = { path: win32.join(manifest.roots.driver, 'boundary-driver.mjs'), sha256: input.driverSha256 };
 const entries: Array<[SliceProbe, { operation: string; argv: string[] }]> = [];
 for (const probeId of VERIFIER_SLICE_PROBES) {
  const command = manifest.verifier.commands.find(c => c.probeId === probeId);
  if (!command?.supported || command.operation !== OPERATIONS[probeId] || command.argv[0] !== driver.path) return storeError('VERIFIER_PROFILE_INVALID', 'Manifest verifier command mismatch');
  entries.push([probeId, { operation: command.operation, argv: [...expectedPrefix, input.node.path, ...NODE_FLAGS, ...command.argv] }]);
 }
 const launches = Object.fromEntries(entries) as SealedVerifierSlice['launches'];
 const sealed = { schemaVersion: 1 as const, fixtureRoot: manifest.fixtureRoot, workspace: manifest.roots.workspace, codex: input.codex, helper: input.helper, node: input.node, driver,
  argvPrefix: expectedPrefix, env: { ...input.env }, config: input.config, launches, sentinels: { sensitive: manifest.fakeCredential.path, allowed: win32.join(manifest.roots.workspace, 'allowed.txt') },
  limits: LIMITS, targetHash: input.targetHash };
 return { ok: true, value: { ...sealed, sealHash: fingerprint(sealed) } };
}
/** One request per approved run, within the ledger's 600000 ms lifetime and limited to the two slice probes. */
export function createSliceRequest(input: { owner: QualificationRequest['owner']; targetHash: string; manifestHash: string; fixtureRoot: string; now: number }): QualificationRequest {
 return { schemaVersion: 1, id: randomUUID(), owner: input.owner, actionId: randomUUID(), targetHash: input.targetHash, manifestHash: input.manifestHash, fixtureRoots: [input.fixtureRoot],
  permittedEndpoints: [], approvedProbeIds: [...VERIFIER_SLICE_PROBES], budget: { maxAttempts: 2, activeMs: 150000, outputBytes: 262144 }, approvedAt: input.now, expiresAt: input.now + 600000 };
}
export function sliceLaunchHash(sealed: SealedVerifierSlice, probeId: SliceProbe): string {
 return fingerprint({ sealHash: sealed.sealHash, probeId, executable: sealed.codex.path, argv: sealed.launches[probeId].argv, cwd: sealed.workspace, env: sealed.env });
}
/** Ledger authority for exactly this sealed slice and request; nothing else may dispatch. */
export function slicePermit(sealed: SealedVerifierSlice, requestId: string) {
 return (request: Readonly<QualificationRequest>, probeId: string, launchHash: string): boolean =>
  request.id === requestId && (VERIFIER_SLICE_PROBES as readonly string[]).includes(probeId) && sliceLaunchHash(sealed, probeId as SliceProbe) === launchHash;
}

export type SliceDeps = { ledger: QualificationLedger; store: RunStore; requestId: string; supervisorFor(authorize: (spec: Readonly<LaunchSpec>) => Promise<boolean>): Supervisor;
 inspectConfig(): Result<ConfigLayerObservation>; hashFile?(path: string): string | null; caseMs?: number; renewalMs?: number; graceMs?: number };
export type SliceOutcome = { attempts: ProbeAttempt[]; effectiveProfileProven: boolean; stoppedAt: SliceProbe | null };
const fileSha = (path: string): string | null => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };
const BASELINE = 'allowed fixture baseline\r\n';

function prelaunch(sealed: SealedVerifierSlice, probeId: SliceProbe, deps: SliceDeps): boolean {
 const hash = deps.hashFile ?? fileSha; const config = deps.inspectConfig();
 if (!config.ok || fingerprint(config.value) !== fingerprint(sealed.config) || ![sealed.codex, sealed.helper, sealed.node, sealed.driver].every(p => hash(p.path) === p.sha256) ||
  existsSync(join(sealed.workspace, '.codex'))) return false;
 // The allowed edit's postimage only proves the edit when it starts from the exact baseline.
 if (probeId === 'verifier.allowed_command') { try { return readFileSync(sealed.sentinels.allowed, 'utf8') === BASELINE; } catch { return false; } }
 return true;
}
type Classified = { result: 'allowed' | 'blocked' | 'error'; reasonCode: string; resultLines: string[]; unexpectedLines: number };
/** Exactly one driver RESULT line and nothing else. Codex's own failures (including MXC launch failures, whose text is not
 * pinned) therefore surface as errors, never as a block. Only access-denied codes count as a denial. */
function classify(probeId: SliceProbe, stdout: string, stderr: string, overflow: boolean): Classified {
 const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);
 const out = lines(stdout); const err = lines(stderr); const resultLines = [...out, ...err].filter(l => l.startsWith('RESULT:'));
 const unexpectedLines = out.length + err.length - resultLines.length; const base = { resultLines, unexpectedLines };
 if (overflow) return { ...base, result: 'error', reasonCode: 'OUTPUT_LIMIT_EXCEEDED' };
 if (resultLines.length !== 1 || unexpectedLines) return { ...base, result: 'error', reasonCode: 'SANDBOX_RESULT_MISSING' };
 if (probeId === 'verifier.allowed_command' && out[0] === 'RESULT:WRITE_SUCCEEDED') return { ...base, result: 'allowed', reasonCode: 'OPERATION_ALLOWED' };
 if (probeId === 'verifier.denied_sensitive_read' && out[0] === 'RESULT:SENSITIVE_READ_SUCCEEDED') return { ...base, result: 'allowed', reasonCode: 'SENSITIVE_READ_SUCCEEDED' };
 if (probeId === 'verifier.denied_sensitive_read' && /^RESULT:OPERATION_ERROR:(EPERM|EACCES)$/.test(err[0] ?? '')) return { ...base, result: 'blocked', reasonCode: 'OPERATION_BLOCKED' };
 return { ...base, result: 'error', reasonCode: 'SANDBOX_RESULT_MISSING' };
}

async function runCase(sealed: SealedVerifierSlice, probeId: SliceProbe, deps: SliceDeps): Promise<Result<ProbeAttempt>> {
 const history = deps.ledger.history(deps.requestId); if (!history.ok) return history; const request = history.value.request;
 if (!prelaunch(sealed, probeId, deps)) return storeError('PRELAUNCH_REFUSED', 'Sealed binaries, driver, workspace, baseline or config layers changed before intent');
 const hash = deps.hashFile ?? fileSha; const caseMs = deps.caseMs ?? LIMITS.caseMs; const launchHash = sliceLaunchHash(sealed, probeId); const actionId = randomUUID();
 const sentinelBefore = hash(sealed.sentinels.sensitive); if (!sentinelBefore) return storeError('PRELAUNCH_REFUSED', 'Disposable sentinel missing');
 const attempt = deps.ledger.beginAttempt(deps.requestId, probeId, { actionId, launchHash, repairEvidenceIds: [] }); if (!attempt.ok) return attempt;
 const expected: LaunchSpec = { runId: request.owner.runId, generation: request.owner.generation, actionId, role: 'verifier', executable: sealed.codex.path,
  argv: sealed.launches[probeId].argv, cwd: sealed.workspace, env: sealed.env, boundaryHash: fingerprint({ sealHash: sealed.sealHash, probeId }),
  authorization: { kind: 'qualification', requestId: deps.requestId, probeId, fixtureRoots: [sealed.fixtureRoot] }, stdin: 'closed', leaseTtlMs: LIMITS.leaseTtlMs, deadline: Date.now() + caseMs };
 let dispatched = false;
 // Time-of-use authority: the supervisor calls this with the frozen spec immediately before helper spawn.
 const authorize = async (spec: Readonly<LaunchSpec>): Promise<boolean> => {
  const { deadline: _d, ...a } = spec; const { deadline: _e, ...b } = expected;
  if (fingerprint(a) !== fingerprint(b) || spec.deadline > expected.deadline || !prelaunch(sealed, probeId, deps)) return false;
  const result = deps.ledger.dispatchAttempt(attempt.value.id, launchHash); dispatched = result.ok; return result.ok;
 };
 const started = Date.now(); const launched = await deps.supervisorFor(authorize).launchOwned(expected);
 if (!launched.ok) {
  if (dispatched) return storeError('RECOVERY_REQUIRED', 'Launch failed after dispatch; outcome unknown and never replayed');
  // Known non-dispatch: no helper was spawned. Reconcile the store action; this request remains terminal.
  const reconciled = deps.store.outcome(request.owner, actionId, { schemaVersion: 1, status: 'RECONCILED', evidenceIds: [] });
  if (!reconciled.ok) return storeError('RECOVERY_REQUIRED', 'Refused launch could not be reconciled');
  return storeError('PRELAUNCH_REFUSED', 'Time-of-use launch authority refused; start a fresh request');
 }
 const execution: OwnedExecution = launched.value; let stdout = ''; let stderr = ''; let outputBytes = 0; let overflow = false; let wake = () => {};
 const settled = new Promise<void>(resolve => { wake = resolve; });
 const stop = execution.onOutput((output: ChildOutput) => {
  outputBytes += output.data.length; if (outputBytes > LIMITS.outputBytes) { overflow = true; wake(); return; }
  if (output.stream === 'stdout') stdout += output.data.toString('utf8'); else stderr += output.data.toString('utf8');
  if (/RESULT:[A-Z_:0-9]+\r?\n/.test(stdout + stderr)) wake();
 });
 let lease = 0; const renewal = setInterval(() => { void execution.renewLease(++lease).catch(() => {}); }, deps.renewalMs ?? LIMITS.renewalMs);
 let receipt: unknown = null; let drain: unknown = null;
 try {
  try { receipt = await execution.describe(); } catch { receipt = null; }
  const timer = setTimeout(wake, Math.max(0, expected.deadline - Date.now())); await settled; clearTimeout(timer);
  // Keep collecting briefly after the RESULT line so trailing output is classified rather than cut off by drain.
  if (!overflow) await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(deps.graceMs ?? 1000, expected.deadline - Date.now()))));
  // A natural completion can land between our check and the request; the second call returns recorded evidence.
  try { drain = await execution.drain(`verifier slice ${probeId} complete`); } catch { try { drain = await execution.drain(`verifier slice ${probeId} complete`); } catch { drain = null; } }
 } finally { clearInterval(renewal); stop(); }
 if (!drain) return storeError('RECOVERY_REQUIRED', 'Drainage evidence unavailable; action remains dispatched and unknown');
 const owned = WindowsOwnershipReceiptSchema.safeParse(receipt); const drained = WindowsDrainEvidenceSchema.safeParse(drain);
 const ownershipOk = owned.success && owned.data.runId === expected.runId && owned.data.actionId === actionId && owned.data.boundaryHash === expected.boundaryHash;
 const drainOk = drained.success && drained.data.actionId === actionId && drained.data.rootExited && drained.data.membershipEmpty && drained.data.activeProcesses === 0 &&
  drained.data.unresolvedExecutions.length === 0 && drained.data.outputComplete;
 const classified = classify(probeId, stdout, stderr, overflow); const sentinelAfter = hash(sealed.sentinels.sensitive);
 let postimageOk: boolean | null = null; if (probeId === 'verifier.allowed_command') { try { postimageOk = readFileSync(sealed.sentinels.allowed, 'utf8') === POSTIMAGE; } catch { postimageOk = false; } }
 const sentinelOk = sentinelAfter === sentinelBefore; const expectedResult = probeId === 'verifier.allowed_command' ? 'allowed' : 'blocked';
 const reasonCode = classified.result === 'error' ? classified.reasonCode : !ownershipOk ? 'OWNERSHIP_UNAVAILABLE' : !drainOk ? 'DRAIN_INCOMPLETE'
  : classified.result !== expectedResult ? classified.reasonCode : postimageOk === false ? 'POSTIMAGE_MISMATCH' : !sentinelOk ? 'SENTINEL_CHANGED' : 'SLICE_CASE_PASSED';
 const owner = request.owner; const evidence: ProbeObservation['evidence'] = []; let publishFailed = false;
 const publish = async (category: string, body: unknown) => {
  async function* bytes() { yield Buffer.from(JSON.stringify(body)); }
  const ref = await publishArtifact(deps.store, bytes(), { schemaVersion: 1, id: randomUUID(), owner, actionId, mediaType: 'application/json', secrets: [] });
  if (ref.ok) evidence.push({ id: ref.value.id, sha256: ref.value.sha256, category }); else publishFailed = true;
 };
 await publish('operation', { probeId, sealHash: sealed.sealHash, launchHash, result: classified.result, reasonCode, resultLines: classified.resultLines, unexpectedLines: classified.unexpectedLines,
  outputBytes, overflow, postimageOk, sentinel: { before: sentinelBefore, after: sentinelAfter } });
 if (owned.success) await publish('ownership', owned.data); if (drained.success) await publish('drain', drained.data);
 const finalReason = publishFailed && reasonCode === 'SLICE_CASE_PASSED' ? 'EVIDENCE_UNAVAILABLE' : reasonCode;
 const observation: ProbeObservation = { schemaVersion: 1, status: finalReason === 'SLICE_CASE_PASSED' ? 'PASS' : 'FAIL', evidenceKind: 'live', actualAttempt: true, result: classified.result, evidence,
  ...(sentinelAfter ? { sentinel: { before: sentinelBefore, after: sentinelAfter } } : {}), ...(probeId === 'verifier.denied_sensitive_read' ? { sensitiveBytesRead: classified.result === 'allowed' } : {}),
  ...(owned.success ? { ownership: owned.data } : {}), ...(drained.success ? { drain: drained.data } : {}), elapsedMs: Date.now() - started, outputBytes, reasonCode: finalReason };
 return deps.ledger.finishAttempt(attempt.value.id, observation);
}

/** Runs the read denial, then the allowed edit, each once under the same seal. A failed or refused case stops the slice. */
export async function runVerifierSlice(sealed: SealedVerifierSlice, deps: SliceDeps): Promise<Result<SliceOutcome>> {
 const attempts: ProbeAttempt[] = [];
 for (const probeId of VERIFIER_SLICE_PROBES) {
  const result = await runCase(sealed, probeId, deps); if (!result.ok) return result; attempts.push(result.value);
  if (result.value.observation?.status !== 'PASS') return { ok: true, value: { attempts, effectiveProfileProven: false, stoppedAt: probeId } };
 }
 return { ok: true, value: { attempts, effectiveProfileProven: true, stoppedAt: null } };
}
