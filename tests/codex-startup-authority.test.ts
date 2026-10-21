import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assessPhaseAdmission, assessStartupAuthority, consumeStartupMetadataPlan, ownershipHash, prepareStartupMetadataInspection, StartupInputSchema, StartupIntentSchema, startupTargetHash, type StartupInput } from '../src/qualification/codex-startup-authority.ts';

function startupInput():StartupInput {
  return { schemaVersion:1, phase:'PRE_PROCESS', requestId:'33333333-3333-4333-8333-333333333333',
    owner:{runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'22222222-2222-4222-8222-222222222222',role:'startup-metadata'},
    workspace:'C:\\disposable\\case', configAncestry:['C:\\','C:\\disposable','C:\\disposable\\case'],
    runtime:{path:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:'a'.repeat(64)},
    node:{path:'C:\\trusted\\node.exe',version:'24.19.0',sha256:'b'.repeat(64)},
    helper:{path:'C:\\trusted\\helper.exe',sha256:'c'.repeat(64)}, controllerHash:'d'.repeat(64),protocolHash:'e'.repeat(64),
    environmentHash:'f'.repeat(64),configHash:'1'.repeat(64),boundaryHash:'2'.repeat(64),argumentsHash:'3'.repeat(64), profile:'ouroboros_metadata',sandbox:'mxc',
    environmentKeys:['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'],
    issuedAt:1000,expiresAt:61000,
    expectedExecution:{pid:10,creationIdentity:'root-10',helperPid:11,helperCreationIdentity:'helper-11',jobIdentity:'job-1'} };
}

describe('offline startup authority',()=>{
  it('admits an explicitly contained metadata bootstrap without inventing a pre-process PID',()=>{
    const legacy=startupInput();const {expectedExecution:_,...base}=legacy;
    const intent={...base,schemaVersion:2,dispatchAuthorization:{kind:'qualification',requestId:base.requestId,probeId:'metadata',fixtureRoots:['C:\\disposable']},authMode:'managed-chatgpt',action:'metadata',adapterHash:'4'.repeat(64),verifierHash:'5'.repeat(64),osCapabilitiesHash:'6'.repeat(64),model:'fixture-model',effort:'high',controlHash:'7'.repeat(64),dispatchHash:'9'.repeat(64),budget:{activeMs:30000,outputBytes:262144,cleanupMs:15000}};
    const targetHash=startupTargetHash(intent as any);
    expect(startupTargetHash(StartupIntentSchema.parse(intent))).toBe(targetHash);
    expect(startupTargetHash(Object.fromEntries(Object.entries(intent).reverse()) as any)).toBe(targetHash);
    expect(startupTargetHash({...intent,controlHash:'0'.repeat(64)} as any)).not.toBe(targetHash);
    const approval={schemaVersion:1,phase:'BOOTSTRAP',intentHash:targetHash,owner:intent.owner,issuedAt:1000,expiresAt:60000,
      ordinaryEffects:['managed-auth','managed-policy','runtime-storage','runtime-logging'],
      budget:{activeMs:30000,outputBytes:262144,cleanupMs:15000},authorization:{kind:'qualification',requestId:intent.requestId},
      controls:['plugins','browser-computer','mcp','remote-control','hooks-notify','apps','web'].map(surface=>({surface,lifecycle:['bootstrap','thread-start','thread-resume'],sources:['packaged','system','managed','user','project','session','cloud','plugin'],route:'contained-qualification',controlHash:intent.controlHash,containmentHash:'8'.repeat(64),hostAccessBounded:true,externalDestinationsBounded:true}))};
    expect(assessStartupAuthority(intent,approval,1002)).toMatchObject({authorized:true});
    const ownership={schemaVersion:1 as const,...intent.owner,environment:'windows' as const,...legacy.expectedExecution,boundaryHash:intent.boundaryHash,assignedBeforeResume:true as const,capturedAt:1001};
    const bound=prepareStartupMetadataInspection(intent,1002,{approval:approval as any,ownership});expect(bound.ok).toBe(true);
    if(bound.ok){const taken=consumeStartupMetadataPlan(bound.value,1002);expect(taken.ok).toBe(true);if(taken.ok)expect(taken.value.expectedExecution.pid).toBe(10);expect(consumeStartupMetadataPlan(bound.value,1002).ok).toBe(false);}
    const verifier={...intent,action:'verifier',owner:{...intent.owner,role:'verifier'}};
    const verifierOwned={...ownership,role:'verifier'};
    const verifierApproval={...approval,phase:'VERIFIER',owner:verifier.owner,intentHash:startupTargetHash(verifier as any),ownershipHash:ownershipHash(verifierOwned),observationHash:'f'.repeat(64),controls:approval.controls.map(control=>({...control,lifecycle:['bootstrap','verifier']}))};
    expect(assessPhaseAdmission(verifier,verifierApproval,1002,'VERIFIER' as any,verifierOwned,'f'.repeat(64))).toEqual({authorized:true});
    expect(assessStartupAuthority({...intent,expectedExecution:legacy.expectedExecution},approval,1002).authorized).toBe(false);
    expect(assessStartupAuthority(intent,{...approval,controls:approval.controls.slice(1)},1002).authorized).toBe(false);
    expect(assessStartupAuthority(intent,{...approval,expiresAt:1002},1002).authorized).toBe(false);
    expect(assessStartupAuthority(intent,{...approval,authorization:{kind:'qualified',qualificationRef:'not-a-containment-permit'}},1002).authorized).toBe(false);
  });
  it('binds a larger finite qualification allowance to the exact explicit admission',()=>{
    const {expectedExecution:_,...base}=startupInput();
    const intent={...base,schemaVersion:2,dispatchAuthorization:{kind:'qualification',requestId:base.requestId,probeId:'metadata',fixtureRoots:['C:\\disposable']},authMode:'managed-chatgpt',action:'metadata',adapterHash:'4'.repeat(64),verifierHash:'5'.repeat(64),osCapabilitiesHash:'6'.repeat(64),model:'fixture-model',effort:'high',controlHash:'7'.repeat(64),dispatchHash:'9'.repeat(64),budget:{activeMs:60000,outputBytes:2097152,cleanupMs:15000}};
    const approval={schemaVersion:1,phase:'BOOTSTRAP',intentHash:startupTargetHash(intent as any),owner:intent.owner,issuedAt:1000,expiresAt:61000,ordinaryEffects:['managed-auth','managed-policy','runtime-storage','runtime-logging'],budget:intent.budget,authorization:{kind:'qualification',requestId:intent.requestId},controls:['plugins','browser-computer','mcp','remote-control','hooks-notify','apps','web'].map(surface=>({surface,lifecycle:['bootstrap'],sources:['packaged','system','managed','user','project','session','cloud','plugin'],route:'contained-qualification',controlHash:intent.controlHash,containmentHash:'8'.repeat(64),hostAccessBounded:true,externalDestinationsBounded:true}))};
    expect(assessStartupAuthority(intent,approval,1002)).toEqual({authorized:true});
    expect(assessStartupAuthority(intent,{...approval,budget:{...approval.budget,outputBytes:262144}},1002).authorized).toBe(false);
    for(const budget of [{...intent.budget,activeMs:60001},{...intent.budget,outputBytes:2097153},{...intent.budget,cleanupMs:15001}])expect(assessStartupAuthority({...intent,budget},approval,1002).authorized).toBe(false);
    expect(assessStartupAuthority({...intent,expiresAt:61001},approval,1002).authorized).toBe(false);
  });
  it('source routes, timestamps, observations and bare assertions cannot grant process authority',()=>{
    for(const evidence of [null,{schemaVersion:1,phase:'PRE_PROCESS',state:'SUPPORTED_SOURCE_ROUTE',targetHash:startupTargetHash(startupInput()),observedAt:1001},
      {schemaVersion:1,phase:'PRE_PROCESS',state:'OBSERVED_FOR_EXACT_TARGET',targetHash:startupTargetHash(startupInput()),observedAt:1001}]){
      const result=assessStartupAuthority(startupInput(),evidence,1002);
      expect(result).toEqual({authorized:false,code:'PRELAUNCH_AUTHORITY_UNPROVEN'});
    }
  });
  it('preserves invalid, conflicting, wrong-phase and wrong-target safe refusals',()=>{
    const evidence={schemaVersion:1,phase:'PRE_PROCESS',state:'SUPPORTED_SOURCE_ROUTE',targetHash:startupTargetHash(startupInput()),observedAt:1001};
    for(const [value,code] of [[{safe:true},'INVALID_STARTUP_EVIDENCE'],[{...evidence,state:'CONFLICT'},'AUTHORITY_CONFLICT'],
      [{...evidence,phase:'METADATA'},'WRONG_AUTHORITY_PHASE'],[{...evidence,targetHash:'f'.repeat(64)},'WRONG_AUTHORITY_TARGET'],
      [{...evidence,observedAt:999},'STALE_STARTUP_INPUT']])expect(assessStartupAuthority(startupInput(),value,1002)).toEqual({authorized:false,code});
  });
  it('rejects unknown fields, wrong phases and noncanonical paths before binding',()=>{
    for(const input of [{...startupInput(),safe:true},{...startupInput(),phase:'METADATA'},
      {...startupInput(),workspace:'C:\\disposable\\..\\case'},
      {...startupInput(),environmentKeys:['OPENAI_API_KEY']}]){
      expect(StartupInputSchema.safeParse(input).success).toBe(false);
      expect(prepareStartupMetadataInspection(input,1001).ok).toBe(false);
    }
  });
  it('rejects stale input and binds an immutable offline-only snapshot',()=>{
    expect(prepareStartupMetadataInspection(startupInput(),61000).ok).toBe(false);
    const original=startupInput(); const bound=prepareStartupMetadataInspection(original,1001);
    expect(bound.ok).toBe(true);
    if(!bound.ok)throw Error('Expected fixture binding');
    original.workspace='C:\\other';
    expect(bound.value).toEqual({kind:'metadata-inspection-plan'});
    expect(JSON.stringify(bound.value)).not.toContain('C:');
  });
});

it('keeps legacy receipts readable while a new release or executable digest requires a fresh target binding',()=>{
  const historical=startupInput();expect(StartupInputSchema.safeParse(historical).success).toBe(true);
  const current={...historical,runtime:{...historical.runtime,version:'0.163.0',sha256:'9'.repeat(64)},node:{...historical.node,version:'24.20.0'}};
  expect(StartupInputSchema.safeParse(current).success).toBe(true);expect(startupTargetHash(current)).not.toBe(startupTargetHash(historical));
  expect(assessStartupAuthority(current,{schemaVersion:1,phase:'PRE_PROCESS',state:'OBSERVED_FOR_EXACT_TARGET',targetHash:startupTargetHash(historical),observedAt:1001},1002)).toEqual({authorized:false,code:'WRONG_AUTHORITY_TARGET'});
});
