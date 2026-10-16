import { createHash } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { compileCommandBoundary, type CommandDefinition, type BoundaryProfile } from '../src/runtime/command-boundary.ts';
const owner={runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'22222222-2222-4222-8222-222222222222',role:'verification'};
const command:CommandDefinition={id:'check',executable:'/usr/bin/node',argv:['/work/test.mjs','a; $(touch escape)'],cwd:'/work',environment:{PATH:'/usr/bin:/bin'},approvedEnvironmentKeys:['PATH'],timeoutMs:1000,inputScope:['/work'],permittedOutputs:['/work/out'],expectedExit:0};
function fixture():BoundaryProfile {
 const policy={platform:'wsl2' as const,readRoots:['/usr','/work'],writeRoots:['/work/out'],deniedSensitiveRoots:['/home/controller','/sys/fs/cgroup','/run/user/1000'],network:{allowedDomains:[],deniedDomains:['*']},verifier:{executable:'/opt/node/bin/node',runtimePath:'/opt/adapter/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js',version:'0.0.79',sha256:'b'.repeat(64),settingsPath:'/home/controller/settings.json',settingsHash:'c'.repeat(64)},registry:[command]};
 // Qualification authority independently fingerprints the complete fixed policy declaration.
 const policyHash=createHash('sha256').update(JSON.stringify(policy)).digest('hex');
 return {...policy,...owner,leaseTtlMs:10000,deadline:Date.now()+10000,qualification:{environment:'wsl2',qualificationRef:'qualified-verifier',runtimeVersion:'0.0.79',runtimeHash:'b'.repeat(64),policyHash,seccompUnixSockets:true,inheritedDescriptorsRestricted:true}};
}
describe('fixed verifier command boundary',()=>{
 it('native_verifier_replaces_the_entire_profile_and_requires_mxc_without_a_linux_seccomp_claim',()=>{
   const nativeCommand={...command,executable:'C:\\Windows\\System32\\whoami.exe',argv:[],cwd:'C:\\work',environment:{PATH:'C:\\Windows\\System32'},inputScope:['C:\\work'],permittedOutputs:['C:\\work\\out']};
   const policy={platform:'windows' as const,readRoots:['C:\\Windows','C:\\work'],writeRoots:['C:\\work\\out'],deniedSensitiveRoots:['C:\\controller'],network:{allowedDomains:[],deniedDomains:['*']},verifier:{executable:'C:\\trusted\\codex.exe',runtimePath:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:'b'.repeat(64),settingsPath:'C:\\controller\\policy.toml',settingsHash:'c'.repeat(64)},registry:[nativeCommand]};
   const profile={...policy,...owner,leaseTtlMs:10000,deadline:Date.now()+10000,qualification:{environment:'windows' as const,qualificationRef:'native-verifier',runtimeVersion:'0.162.1',runtimeHash:'b'.repeat(64),policyHash:createHash('sha256').update(JSON.stringify(policy)).digest('hex'),seccompUnixSockets:false,inheritedDescriptorsRestricted:true}};
   const result=compileCommandBoundary(nativeCommand,profile);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);
   expect(result.value.argv).toContain('windows.sandbox="mxc"');expect(result.value.argv).toContain('--include-managed-config');expect(result.value.argv).not.toContain('windows');
   expect(result.value.argv.filter(argument=>argument.startsWith('permissions.ouroboros_verifier='))).toHaveLength(1);
   expect(result.value.argv.find(argument=>argument.startsWith('permissions.ouroboros_verifier='))).toContain('dangerously_allow_all_unix_sockets=false');
   expect(result.value.argv.slice(-2)).toEqual(['--','C:\\Windows\\System32\\whoami.exe']);
 });
 it('rejects_unqualified_verifier',()=>{
   const profile=fixture();delete (profile as Partial<BoundaryProfile>).qualification;
   const result=compileCommandBoundary(command,profile);expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('CAPABILITY_UNAVAILABLE');
 });
 it('compiles_explicit_controller_settings_and_literal_argv',()=>{
   const result=compileCommandBoundary(command,fixture());expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);
   expect(result.value.executable).toBe('/opt/node/bin/node');
   expect(result.value.argv).toEqual(['/opt/adapter/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js','--settings','/home/controller/settings.json','--','/usr/bin/node','/work/test.mjs','a; $(touch escape)']);
   expect(result.value.argv).not.toContain('-c');expect(result.value.stdin).toBe('closed');expect(result.value.deadline).toBeLessThanOrEqual(Date.now()+1000);
 });
 it('rejects_model_proposed_commands_and_environment_injection',()=>{
   for(const changed of [{...command,id:'model-check'},{...command,argv:['-e','evil']},{...command,environment:{...command.environment,LD_PRELOAD:'/work/evil.so'}}]) {
     expect(compileCommandBoundary(changed,fixture()).ok).toBe(false);
   }
 });
 it('policy_or_runtime_changes_invalidate_exact_qualification',()=>{
   const profile=fixture();profile.deniedSensitiveRoots=[];expect(compileCommandBoundary(command,profile).ok).toBe(false);
   const changed=fixture();changed.verifier.sha256='d'.repeat(64);expect(compileCommandBoundary(command,changed).ok).toBe(false);
 });
 it('rejects_output_or_working_directory_outside_approved_roots',()=>{
   expect(compileCommandBoundary({...command,cwd:'/home/controller'},fixture()).ok).toBe(false);
   expect(compileCommandBoundary({...command,permittedOutputs:['/sys/fs/cgroup/owned']},fixture()).ok).toBe(false);
 });
});
