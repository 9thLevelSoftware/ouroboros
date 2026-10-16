import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { controllerSettings, type SrtPolicy } from '../adapters/claude/src/verify-command.ts';
import { compileCommandBoundary, type BoundaryProfile, type CommandDefinition } from '../src/runtime/command-boundary.ts';

const overlapRoots = ['/home', '/home/controller', '/home/controller/cache'];
const owner = { runId:'11111111-1111-4111-8111-111111111111',generation:1,
  actionId:'22222222-2222-4222-8222-222222222222',role:'verification' };
const command:CommandDefinition = {id:'read-scope-check',executable:'/usr/bin/node',argv:['/work/check.mjs'],cwd:'/work',
  environment:{PATH:'/usr/bin:/bin'},approvedEnvironmentKeys:['PATH'],timeoutMs:1000,inputScope:['/work'],permittedOutputs:['/work/out'],expectedExit:0};
function srtPolicy(readRoot:string):SrtPolicy {
  return {readRoots:['/usr','/work',readRoot],writeRoots:['/work/out'],deniedSensitiveRoots:['/home/controller','/sys/fs/cgroup','/run/user/1000'],
    allowedDomains:[],deniedDomains:['*'],seccompPath:'/opt/apply-seccomp'};
}
function profile(readRoot:string):BoundaryProfile {
  const policy={platform:'wsl2' as const,readRoots:['/usr','/work',readRoot],writeRoots:['/work/out'],deniedSensitiveRoots:['/home/controller','/sys/fs/cgroup','/run/user/1000'],
    network:{allowedDomains:[],deniedDomains:['*']},verifier:{executable:'/opt/node/bin/node',runtimePath:'/opt/adapter/srt.js',version:'0.0.79',sha256:'b'.repeat(64),settingsPath:'/home/controller/settings.json',settingsHash:'c'.repeat(64)},registry:[command]};
  // Independent issuer explicitly approves this declaration, so stale hashes cannot hide the overlap defect.
  return {...policy,...owner,leaseTtlMs:10000,deadline:Date.now()+10000,
    qualification:{environment:'wsl2',qualificationRef:'scope-review',runtimeVersion:'0.0.79',runtimeHash:'b'.repeat(64),
      policyHash:createHash('sha256').update(JSON.stringify(policy)).digest('hex'),seccompUnixSockets:true,inheritedDescriptorsRestricted:true}};
}
it('settings_reject_sensitive_read_overlap_without_rejecting_siblings',()=>{
  for(const readRoot of overlapRoots) expect(()=>controllerSettings(srtPolicy(readRoot)),readRoot).toThrow(/sensitive|overlap/i);
  const settings=controllerSettings(srtPolicy('/home/controller-data'));
  expect(settings.filesystem.allowRead).toContainEqual({path:'/home/controller-data',literal:true});
});
it('compiler_rejects_sensitive_read_overlap_without_rejecting_siblings',()=>{
  for(const readRoot of overlapRoots){
    const result=compileCommandBoundary(command,profile(readRoot));expect(result.ok,readRoot).toBe(false);
    if(!result.ok)expect(result.error.code).toBe('CAPABILITY_UNAVAILABLE');
  }
  expect(compileCommandBoundary(command,profile('/home/controller-data')).ok).toBe(true);
});
