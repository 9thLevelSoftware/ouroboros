import { it, expect } from 'vitest';
import { collectDoctor, createDoctorDependencies } from '../src/cli/doctor.ts';
import { main } from '../src/cli/main.ts';
it('doctor_is_passive_and_redacts_values', async () => {
 const fakeSecretValue = 'do-not-output-secret'; const commands: string[] = [];
 const deps = { inspectVersion: async (name: string) => { commands.push(name); return name === 'codex' ? 'codex-cli 0.162.1' + '\n' + fakeSecretValue : undefined; }, credentialSourcePresence: () => ({ OPENAI_API_KEY: true }), lookupQualification: async () => undefined, platform: 'win32', nodeVersion: '24.19.0', dataRoot: undefined };
 const report = await collectDoctor(deps);
 expect(report.qualification).toBe('UNQUALIFIED'); expect(JSON.stringify(report)).not.toContain(fakeSecretValue); expect(report.subscriptionMode).toBe('unknown'); expect(commands).toContain('codex');
 let output = ''; expect(await main(['doctor', '--json'], { doctor: deps, stdout: s => { output += s; }, stderr: () => {} })).toBe(0); expect(JSON.parse(output).qualification).toBe('UNQUALIFIED');
});
it('doctor_reports_unqualified_without_data_root', async () => {
 let lookups = 0; const report = await collectDoctor({ inspectVersion: async () => undefined, credentialSourcePresence: () => ({}), lookupQualification: async () => { lookups++; return undefined; }, platform: 'win32', nodeVersion: '24.19.0' });
 expect(report.qualification).toBe('UNQUALIFIED'); expect(lookups).toBe(0); expect(report.missingPrerequisites).toContain('codex');
});
it('actual_inspection_uses_only_safe_version_commands', async () => {
 const seen: unknown[] = []; const deps = createDoctorDependencies({ env: { OPENAI_API_KEY: 'secret' }, execute: async (file, args) => { seen.push([file, args]); return 'runtime 1.2.3'; } });
 const report = await collectDoctor(deps); expect(seen).toEqual([['codex', ['--version']], ['wsl.exe', ['--version']]]); expect(JSON.stringify(report)).not.toContain('secret');
});
it('rejects_unknown_commands_without_inspection', async () => {
 let inspected = false; expect(await main(['login'], { doctor: { inspectVersion: async () => { inspected = true; return undefined; }, credentialSourcePresence: () => ({}), lookupQualification: async () => undefined, platform: 'win32', nodeVersion: '24' }, stdout: () => {}, stderr: () => {} })).toBe(2); expect(inspected).toBe(false);
});

