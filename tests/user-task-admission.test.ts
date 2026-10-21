import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assessPhaseAdmission, ORDINARY_STARTUP_EFFECTS, ownershipHash, StartupIntentSchema, startupTargetHash } from '../src/qualification/codex-startup-authority.ts';

const h=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authorization={kind:'user-task',authorizationId:'33333333-3333-4333-8333-333333333333',taskHash:'a'.repeat(64)};
const owner={runId:'11111111-1111-4111-8111-111111111111',generation:1,actionId:'22222222-2222-4222-8222-222222222222',role:'implementation'};
const intent={schemaVersion:2,phase:'PRE_PROCESS',requestId:owner.actionId,owner,workspace:'C:\\task\\workspace',configAncestry:['C:\\','C:\\task','C:\\task\\workspace'],runtime:{path:'C:\\trusted\\codex.exe',version:'0.162.1',sha256:'b'.repeat(64)},node:{path:'C:\\trusted\\node.exe',version:'24.19.0',sha256:'c'.repeat(64)},helper:{path:'C:\\trusted\\helper.exe',sha256:'d'.repeat(64)},controllerHash:'e'.repeat(64),protocolHash:'f'.repeat(64),environmentHash:'1'.repeat(64),configHash:'2'.repeat(64),boundaryHash:'3'.repeat(64),argumentsHash:'4'.repeat(64),profile:'ouroboros_worker',sandbox:'mxc',environmentKeys:[],issuedAt:1000,expiresAt:31000,authMode:'managed-chatgpt',action:'worker-start',dispatchAuthorization:authorization,adapterHash:'5'.repeat(64),verifierHash:'6'.repeat(64),osCapabilitiesHash:'7'.repeat(64),controlHash:'8'.repeat(64),dispatchHash:'9'.repeat(64),model:'test-model',effort:'high',budget:{activeMs:30000,outputBytes:262144,cleanupMs:15000}};
const approval={schemaVersion:2,semantics:'requested-controls-and-observed-policy',phase:'BOOTSTRAP',intentHash:startupTargetHash(intent as any),owner,issuedAt:1000,expiresAt:31000,ordinaryEffects:[...ORDINARY_STARTUP_EFFECTS],budget:intent.budget,authorization,argumentsHash:intent.argumentsHash,controlHash:intent.controlHash};
it('sixty second requested budgets remain finite across task and qualification intents',()=>{const expanded={...intent,expiresAt:61000,budget:{...intent.budget,activeMs:60000}};expect(assessPhaseAdmission(expanded,{...approval,expiresAt:61000,budget:expanded.budget,intentHash:startupTargetHash(expanded as any)},1002,'BOOTSTRAP')).toEqual({authorized:true});for(const dispatchAuthorization of [{kind:'qualification',requestId:owner.actionId,probeId:'metadata',fixtureRoots:['C:\\task']},{kind:'qualified',qualificationRef:'reviewed'}])expect(StartupIntentSchema.safeParse({...expanded,dispatchAuthorization}).success).toBe(true);expect(StartupIntentSchema.safeParse({...expanded,budget:{...expanded.budget,activeMs:60001}}).success).toBe(false);});
it('admits explicit task permission without manufacturing qualification evidence',()=>{
 expect(assessPhaseAdmission(intent,approval,1002,'BOOTSTRAP')).toEqual({authorized:true});
 expect(approval).not.toHaveProperty('controls');
});
it('binds task admission to its exact authority, launch, phase and expiry',()=>{
 for(const change of [{authorization:{...authorization,taskHash:'b'.repeat(64)}},{argumentsHash:'e'.repeat(64)},{controlHash:'e'.repeat(64)},{phase:'TURN'},{expiresAt:1002},{owner:{...owner,generation:2}},{authorization:{kind:'qualified',qualificationRef:'fake'}}]) expect(assessPhaseAdmission(intent,{...approval,...change},1002,'BOOTSTRAP').authorized).toBe(false);
});
it('requires actual owned process and matching observation before task thread/turn admission',()=>{
 const owned={schemaVersion:1 as const,...owner,environment:'windows' as const,pid:10,creationIdentity:'10',helperPid:11,helperCreationIdentity:'11',jobIdentity:'job',boundaryHash:intent.boundaryHash,assignedBeforeResume:true as const,capturedAt:1001};
 const pre={...approval,phase:'PRE_THREAD',ownershipHash:ownershipHash(owned),observationHash:'f'.repeat(64)};
 expect(assessPhaseAdmission(intent,pre,1002,'PRE_THREAD').authorized).toBe(false);
 expect(assessPhaseAdmission(intent,pre,1002,'PRE_THREAD',owned,'e'.repeat(64)).authorized).toBe(false);
 expect(assessPhaseAdmission(intent,pre,1002,'PRE_THREAD',owned,'f'.repeat(64))).toEqual({authorized:true});
});
