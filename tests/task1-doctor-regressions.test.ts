import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as FileSystem from 'node:fs/promises';
import { id, hash } from './support/contracts.ts';

const boundary = vi.hoisted(() => ({ commands: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>, mutations: [] as string[], secret: 'sentinel-secret-must-never-appear' }));
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], options: Record<string, unknown>, callback: (error: null, stdout: string) => void) => {
    boundary.commands.push({ file, args, options });
    const text = file === 'wsl.exe' ? Buffer.from('WSL version: 2.7.13.0\r\n', 'utf16le').toString('utf8') : `codex-cli 0.162.1\n${boundary.secret}`;
    callback(null, text);
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FileSystem>();
  const blocked = Object.fromEntries(['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile', 'chmod', 'chown', 'truncate'].map(name => [name, () => { boundary.mutations.push(name); throw new Error('Forbidden mutation'); }]));
  return { ...actual, ...blocked, open: async (path: string, flags: string) => {
    if (flags !== 'r') { boundary.mutations.push(`open:${flags}`); throw new Error('Forbidden write open'); }
    return actual.open(path, flags);
  } };
});
import { collectDoctor, createDoctorDependencies } from '../src/cli/doctor.ts';
import { main } from '../src/cli/main.ts';

const actualFs = await vi.importActual<typeof FileSystem>('node:fs/promises');
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await actualFs.rm(root, { recursive: true, force: true });
  boundary.commands.length = 0;
  boundary.mutations.length = 0;
});
async function fixture(cache: string) {
  const root = await actualFs.mkdtemp(join(tmpdir(), 'ouroboros-task1-'));
  roots.push(root);
  const entrypoint = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const controller = join(root, 'Ouroboros', 'controller');
  await actualFs.mkdir(join(root, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  await actualFs.mkdir(controller, { recursive: true });
  await actualFs.writeFile(entrypoint, 'fixture shim entrypoint');
  await actualFs.writeFile(join(controller, 'qualification.json'), cache);
  const env = { PATH: root, LOCALAPPDATA: root, OPENAI_API_KEY: boundary.secret, ANTHROPIC_API_KEY: boundary.secret };
  return { root, entrypoint, deps: createDoctorDependencies({ env }) };
}
function assertPassive(entrypoint: string) {
  const commands = boundary.commands.map(({ file, args }) => [file, args]);
  expect(commands).toHaveLength(2);
  expect(commands).toEqual(expect.arrayContaining([[process.execPath, [entrypoint, '--version']], ['wsl.exe', ['--version']]]));
  for (const { options } of boundary.commands) expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 5000, maxBuffer: 65536 });
  expect(boundary.mutations).toEqual([]);
}
const cached = { schemaVersion: 1, id, provider: 'codex', environment: 'windows', runtimeFingerprint: hash, adapterFingerprint: hash, platformFingerprint: hash, policyFingerprint: hash, runtimeVersion: '0.162.1', adapterVersion: '1', platform: 'win32', capabilities: { execution: { status: 'SUPPORTED', evidenceIds: [id] } } };
it('round1_actual_shim_utf16_cache_and_secret_boundaries', async () => {
  const { entrypoint, deps } = await fixture(JSON.stringify(cached));
  let output = '';
  expect(await main(['doctor', '--json'], { doctor: deps, stdout: text => { output += text; }, stderr: () => {} })).toBe(0);
  const report = JSON.parse(output);
  expect(report.versions).toEqual({ codex: '0.162.1', wsl: '2.7.13.0' });
  expect(report.credentialSources.OPENAI_API_KEY).toBe(true);
  expect(report.cachedQualificationPresent).toBe(true);
  expect(report.qualification).toBe('UNQUALIFIED');
  expect(output).not.toContain(boundary.secret);
  assertPassive(entrypoint);
});
it('round1_malformed_cache_is_read_only_and_unqualified', async () => {
  const { entrypoint, deps } = await fixture(`{"secret":"${boundary.secret}",`);
  const report = await collectDoctor(deps);
  expect(report.cachedQualificationPresent).toBe(false);
  expect(report.qualification).toBe('UNQUALIFIED');
  expect(JSON.stringify(report)).not.toContain(boundary.secret);
  assertPassive(entrypoint);
});
it('round1_oversize_cache_is_read_only_and_unqualified', async () => {
  const { entrypoint, deps } = await fixture(JSON.stringify(cached) + ' '.repeat(1048577));
  const report = await collectDoctor(deps);
  expect(report.cachedQualificationPresent).toBe(false);
  expect(report.qualification).toBe('UNQUALIFIED');
  assertPassive(entrypoint);
});
it('round1_unsupported_command_never_reaches_actual_boundaries', async () => {
  const { deps } = await fixture('{}');
  expect(await main(['login'], { doctor: deps, stdout: () => {}, stderr: () => {} })).toBe(2);
  expect(boundary.commands).toEqual([]);
  expect(boundary.mutations).toEqual([]);
});
