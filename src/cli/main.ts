#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { collectDoctor, createDoctorDependencies, type DoctorDependencies } from './doctor.ts';
import { createQualificationCli, createVerifierSliceCli, parseQualificationArguments, type QualificationCli, type VerifierSliceCli } from '../qualification/codex-windows.ts';
export interface CliDependencies { doctor: DoctorDependencies; stdout(text: string): void; stderr(text: string): void; qualify?: QualificationCli; verifierSlice?: VerifierSliceCli }
export async function main(argv: string[], deps: CliDependencies): Promise<number> {
 if (argv[0] === 'doctor' && argv[1] === '--qualify-verifier-slice') {
  // Without --approve-launch this only prints the sealed launch. The hash must be passed back to launch.
  const rest = argv.slice(2); const at = rest.indexOf('--approve-launch'); const approve = at === -1 ? null : rest[at + 1] ?? '';
  if (at !== -1) rest.splice(at, 2);
  const parsed = parseQualificationArguments(rest);
  if (!parsed.ok || (approve !== null && !/^[a-f0-9]{64}$/.test(approve))) { deps.stderr('Usage: ouroboros doctor --qualify-verifier-slice --provider codex --environment windows --fixture-root <fresh-absolute-root> --model <model> [--effort <effort>] [--approve-launch <seal-hash>]\n'); return 2; }
  try {
   const result = await (deps.verifierSlice ?? createVerifierSliceCli())(parsed.value, approve);
   deps.stdout(`${JSON.stringify(result, null, 2)}\n`); return !result.launched || result.passed ? 0 : 1;
  } catch (error) { deps.stderr(`Verifier slice failed; preserve fixture and controller evidence for review: ${error instanceof Error ? error.message : 'unknown failure'}\n`); return 1; }
 }
 if (argv[0] === 'doctor' && argv[1] === '--qualify') {
  const parsed = parseQualificationArguments(argv.slice(2));
  if (!parsed.ok) { deps.stderr('Usage: ouroboros doctor --qualify --provider codex --environment windows --fixture-root <fresh-absolute-root> --model <model> [--effort <effort>]\n'); return 2; }
  try {
   const prepared = await (deps.qualify ?? createQualificationCli())(parsed.value, manifest => { deps.stdout(`${JSON.stringify(manifest, null, 2)}\n`); });
   deps.stdout(`${JSON.stringify(prepared.report, null, 2)}\n`); return prepared.report.qualified ? 0 : 1;
  } catch { deps.stderr('Qualification preflight failed; no qualification conferred. Preserve fixture/controller evidence for review.\n'); return 1; }
 }
 if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) { deps.stdout('Usage: ouroboros doctor [--json]\n'); return 0; }
 if (argv[0] !== 'doctor' || argv.length > 2 || (argv.length === 2 && argv[1] !== '--json')) { deps.stderr('Usage: ouroboros doctor [--json]\n'); return 2; }
 const report = await collectDoctor(deps.doctor);
 deps.stdout(argv[1] === '--json' ? `${JSON.stringify(report, null, 2)}\n` : `Ouroboros doctor\nNode: ${report.nodeVersion}\nPlatform: ${report.platform}\nCodex: ${report.versions.codex ?? 'missing'}\nWSL: ${report.versions.wsl ?? 'missing'}\nQualification: ${report.qualification}\nSubscription: ${report.subscriptionMode}\nMissing prerequisites: ${report.missingPrerequisites.join(', ') || 'none detected'}\n`);
 return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 main(process.argv.slice(2), { doctor: createDoctorDependencies(), stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } }).then(code => { process.exitCode = code; }, () => { process.stderr.write('Doctor inspection failed\n'); process.exitCode = 1; });
}
