import { describe, expect, it, vi } from 'vitest';
import { launchWslOwned, wslHelperCommand, type WslPrerequisites } from '../src/runtime/wsl.ts';
import { OwnershipReceiptSchema, DrainEvidenceSchema } from '../src/contracts/execution.ts';

const owner = { runId:'11111111-1111-4111-8111-111111111111', generation:1,
  actionId:'22222222-2222-4222-8222-222222222222', role:'verification' };
const spec = () => ({...owner, executable:'/usr/bin/true', argv:[], cwd:'/home/test/fixture', env:{},
  boundaryHash:'a'.repeat(64), authorization:{kind:'qualified' as const,qualificationRef:'receipt'}, stdin:'closed' as const,
  leaseTtlMs:10000, deadline:Date.now()+60000});
const ready:WslPrerequisites = {distro:'Ubuntu',wslVersion:2,systemd:true,cgroup2:true,userManager:true,
  bwrap:true,socat:true,ripgrep:true,seccomp:true,brokerSocketIsolation:true,inheritedDescriptorsRestricted:true,missing:[]};
describe('WSL fail-closed launch',()=>{
  it('rejects_wsl1_or_missing_systemd_cgroup2',async()=>{
    for(const delta of [{wslVersion:1},{systemd:false},{cgroup2:false},{userManager:false}]) {
      const dispatch=vi.fn();const result=await launchWslOwned(spec(),'Ubuntu',{helperPath:'/home/controller/helper',authorize:async()=>true,inspect:async()=>({...ready,...delta}),connect:dispatch});
      expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('CAPABILITY_UNAVAILABLE');expect(dispatch).not.toHaveBeenCalled();
    }
  });
  it('never_invokes_shell_with_unquoted_user_text',()=>{
    const plan=wslHelperCommand('Ubuntu ; $(touch /tmp/escape)','/home/controller/helper');
    expect(plan).toEqual({file:'wsl.exe',args:['--distribution','Ubuntu ; $(touch /tmp/escape)','--exec','/home/controller/helper','bridge']});
    expect(plan.args).not.toContain('-c');
  });
  it('rejects_unqualified_verifier',async()=>{
    const dispatch=vi.fn();const result=await launchWslOwned(spec(),'Ubuntu',{helperPath:'/home/controller/helper',authorize:async()=>false,inspect:async()=>ready,connect:dispatch});
    expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('CAPABILITY_UNAVAILABLE');expect(dispatch).not.toHaveBeenCalled();
  });
  it('closed_socket_or_missing_seccomp_blocks_wsl',async()=>{
    for(const delta of [{seccomp:false},{brokerSocketIsolation:false},{inheritedDescriptorsRestricted:false},{socat:false}]) {
      const dispatch=vi.fn();const result=await launchWslOwned(spec(),'Ubuntu',{helperPath:'/home/controller/helper',authorize:async()=>true,inspect:async()=>({...ready,...delta}),connect:dispatch});
      expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('CAPABILITY_UNAVAILABLE');expect(dispatch).not.toHaveBeenCalled();
    }
  });
});
describe('Linux ownership evidence',()=>{
 const identity={unitName:'ouroboros-target.service',invocationId:'b'.repeat(32),bootId:owner.runId,controlGroup:'/owned.slice/target.service',
  observationSlice:{unitName:'ouroboros.slice',invocationId:'c'.repeat(32),controlGroup:'/owned.slice',fileDevice:'25',fileInode:'9007199254740993'},
  observer:{unitName:'ouroboros-observer.service',invocationId:'d'.repeat(32)}};
 it('never_fabricates_windows_job_evidence_for_linux',()=>{
   const receipt={schemaVersion:1,...owner,environment:'wsl2',distro:'Ubuntu',...identity,
     helper:{pid:100,startTimeTicks:'9007199254740994'},root:{pid:101,startTimeTicks:'9007199254740995'},boundaryHash:'a'.repeat(64),
     identityCapturedBeforeExec:true,observationArmedBeforeExec:true,capturedAt:1};
   expect(OwnershipReceiptSchema.safeParse(receipt).success).toBe(true);
   expect(OwnershipReceiptSchema.safeParse({...receipt,jobIdentity:'fake'}).success).toBe(false);
   expect(OwnershipReceiptSchema.safeParse({...receipt,controlGroup:'/unrelated/target.service'}).success).toBe(false);
 });
 it('missing_population_cannot_be_upgraded_to_emptiness_or_complete_output',()=>{
   const evidence={schemaVersion:1,...owner,environment:'wsl2',...identity,reason:'cancel',requestAcknowledged:false,requestedAt:1,acknowledgedAt:null,
    rootExited:true,rootExitedAt:2,membershipEmpty:false,membershipObservedAt:null,cgroupPopulated:null,observationError:'ENODEV',unresolvedUnits:['ouroboros-target.service'],
    outputComplete:false,unresolvedOutputStreams:['stderr'],outputCompletedAt:null,completedAt:3};
   expect(DrainEvidenceSchema.safeParse(evidence).success).toBe(true);
   expect(DrainEvidenceSchema.safeParse({...evidence,membershipEmpty:true}).success).toBe(false);
   expect(DrainEvidenceSchema.safeParse({...evidence,outputComplete:true}).success).toBe(false);
 });
});
