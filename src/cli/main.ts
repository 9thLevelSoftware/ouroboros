#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { open } from 'node:fs/promises';
import { collectDoctor, createDoctorDependencies, type DoctorDependencies } from './doctor.ts';
import { createQualificationCli, createVerifierSliceCli, parseQualificationArguments, type QualificationCli, type VerifierSliceCli } from '../qualification/codex-windows.ts';
import { runTask, type RunTaskDependencies, type TaskRunReport } from '../controller/run-task.ts';
import { createQualificationStatusCli, type QualificationStatusCli } from '../qualification/campaign-status-cli.ts';
import { IdSchema } from '../contracts/common.ts';
import { createCampaignExecutionCli,type CampaignExecutionCli } from '../qualification/campaign-cli.ts';
export interface CliDependencies { doctor: DoctorDependencies; stdout(text: string): void; stderr(text: string): void; qualify?: QualificationCli; verifierSlice?: VerifierSliceCli; qualificationStatus?:QualificationStatusCli; campaignExecution?:CampaignExecutionCli; readTask?:(path:string)=>Promise<unknown>; run?:(input:unknown,options:RunTaskDependencies)=>Promise<TaskRunReport>; signal?:AbortSignal }
async function readTaskFile(path:string):Promise<unknown>{const file=await open(path,'r');try{const buffer=Buffer.alloc(65537);const result=await file.read(buffer,0,buffer.length,0);if(result.bytesRead>65536)throw Error('Task file too large');return JSON.parse(buffer.subarray(0,result.bytesRead).toString('utf8'));}finally{await file.close();}}
export async function main(argv: string[], deps: CliDependencies): Promise<number> {
 if(argv[0]==='doctor'&&argv[1]==='--qualify-campaign'){
  const fields=new Map<string,string>();let valid=(argv.length-2)%2===0;
  for(let at=2;at<argv.length;at+=2){const key=argv[at],value=argv[at+1];if(!['--plan-file','--unit','--approve-plan'].includes(key)||fields.has(key)||!value||value.startsWith('--')){valid=false;break;}fields.set(key,value);}
  if(!valid||!fields.has('--plan-file')||!fields.has('--unit')||fields.has('--approve-plan')&&!/^[a-f0-9]{64}$/.test(fields.get('--approve-plan')!)){deps.stderr('Usage: ouroboros doctor --qualify-campaign --plan-file <path> --unit <id> [--approve-plan <hash>]\n');return 2;}
  try{const report=await(deps.campaignExecution??createCampaignExecutionCli())({planFile:fields.get('--plan-file')!,unit:fields.get('--unit')!,approvePlan:fields.get('--approve-plan')??null});deps.stdout(`${JSON.stringify(report,null,2)}\n`);return report.mode==='proposal'||report.execution?.status==='UNIT_EXECUTED'?0:1;}
  catch(error){const reason=error instanceof Error&&/^[A-Z0-9_]{1,96}$/.test(error.message)?error.message:'CAMPAIGN_EXECUTION_REFUSED';deps.stderr(`Campaign unit did not complete: ${reason}. Preserve controller and fixture evidence.\n`);return 1;}
 }
 if(argv[0]==='doctor'&&argv[1]==='--qualification-status'){
  if(!IdSchema.safeParse(argv[2]).success||argv.length!==3&&!(argv.length===5&&argv[3]==='--accepted-reviews'&&argv[4]&&!argv[4].startsWith('--'))){deps.stderr('Usage: ouroboros doctor --qualification-status <campaign-id> [--accepted-reviews <reviews.json>]\n');return 2;}
  try{const acceptance=argv[4]?await(deps.readTask??readTaskFile)(argv[4]):undefined;const report=await(deps.qualificationStatus??createQualificationStatusCli())(argv[2],acceptance);deps.stdout(`${JSON.stringify(report,null,2)}\n`);return 0;}
  catch{deps.stderr('Qualification evidence could not be read. No qualification or dispatch permission was granted.\n');return 1;}
 }
 if(argv[0]==='run'){
  if(argv[1]!=='--task-file'||!argv[2]||argv[2].startsWith('--')||argv.length!==3&&!(argv.length===4&&argv[3]==='--json')){deps.stderr('Usage: ouroboros run --task-file <task.json> [--json]\n');return 2;}
  try{
   const input=await (deps.readTask??readTaskFile)(argv[2]);
   const result=await (deps.run??runTask)(input,{signal:deps.signal,onEvent:event=>{const type=event&&typeof event==='object'&&'type' in event?String(event.type):'';if(['turn_started','turn_completed'].includes(type))deps.stderr(type==='turn_started'?'Implementing task…\n':'Implementation finished; checking result…\n');}});
   deps.stdout(argv[3]==='--json'?`${JSON.stringify(result,null,2)}\n`:`${result.status}\n${result.code}\n${result.runtimeDiagnostics?.map(item=>item.message+'\n').join('')??''}Report: ${result.reportPath}\n${result.patch?`Patch: ${result.patch}\n`:''}`);
   return result.status==='READY_FOR_REVIEW'?0:1;
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='DEPENDENCY_REBUILD_REQUIRED')deps.stderr('DEPENDENCY_REBUILD_REQUIRED: rebuild better-sqlite3 for the selected Node runtime with npm rebuild better-sqlite3, then retry.\n');else deps.stderr('Task could not start. Check the task file and runtime paths; no successful result was recorded.\n');return 1;}
 }
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
 if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) { deps.stdout('Usage: ouroboros run --task-file <task.json> [--json]\n       ouroboros doctor [--json]\n'); return 0; }
 if (argv[0] !== 'doctor' || argv.length > 2 || (argv.length === 2 && argv[1] !== '--json')) { deps.stderr('Usage: ouroboros doctor [--json]\n'); return 2; }
 const report = await collectDoctor(deps.doctor);
 deps.stdout(argv[1] === '--json' ? `${JSON.stringify(report, null, 2)}\n` : `Ouroboros doctor\nNode: ${report.nodeVersion}\nPlatform: ${report.platform}\nCodex: ${report.versions.codex ?? 'missing'}\nWSL: ${report.versions.wsl ?? 'missing'}\nQualification: ${report.qualification}\nSubscription: ${report.subscriptionMode}\nMissing prerequisites: ${report.missingPrerequisites.join(', ') || 'none detected'}\n`);
 return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const cancellation=new AbortController();const cancel=()=>cancellation.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 main(process.argv.slice(2), { doctor: createDoctorDependencies(), signal:cancellation.signal, stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } }).then(code => { process.exitCode = code; }, () => { process.stderr.write('Command failed\n'); process.exitCode = 1; }).finally(()=>{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);});
}
