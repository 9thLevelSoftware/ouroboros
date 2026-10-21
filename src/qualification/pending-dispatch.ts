import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdSchema, HashSchema, type Result } from '../contracts/common.ts';
import { OwnerTokenSchema, type OwnerToken, type ActionRecord } from '../contracts/evidence.ts';
import { LaunchSpecSchema, OwnershipReceiptSchema, type OwnedExecution, type Supervisor } from '../contracts/execution.ts';
import { type RunStore, storeError } from '../store/database.ts';
import { publishArtifact } from '../store/artifacts.ts';
import { fingerprint } from './probes.ts';

export const PendingDispatchDescriptorSchema = z.strictObject({schemaVersion:z.literal(1),owner:OwnerTokenSchema,parentActionId:IdSchema,actionId:IdSchema,targetHash:HashSchema,launchHash:HashSchema,launch:LaunchSpecSchema}).superRefine((d,c)=>{
 if(d.launch.runId!==d.owner.runId||d.launch.generation!==d.owner.generation||d.launch.actionId!==d.actionId||d.parentActionId===d.actionId||d.launchHash!==fingerprint(d.launch)||d.launch.role!=='pending-canary'||d.launch.authorization.kind!=='qualification'||d.launch.authorization.probeId!=='auxiliary.preparation')c.addIssue({code:'custom',message:'Pending launch identity is inconsistent'});
});
export type PendingDispatchDescriptor=z.infer<typeof PendingDispatchDescriptorSchema>;
export const PendingDispatchPayloadSchema=z.strictObject({schemaVersion:z.literal(1),descriptor:PendingDispatchDescriptorSchema,ownerHash:HashSchema,descriptorHash:HashSchema}).superRefine((p,c)=>{if(p.ownerHash!==fingerprint(p.descriptor.owner)||p.descriptorHash!==fingerprint(p.descriptor))c.addIssue({code:'custom',message:'Pending payload identity is inconsistent'});});
const mediaType='application/vnd.ouroboros.pending-creation+json';
export function createPendingDispatchQueue(store:RunStore,options:{chargedDispatch:(descriptor:PendingDispatchDescriptor,effect:(supervisor:Supervisor)=>Promise<Result<OwnedExecution>>)=>Promise<Result<OwnedExecution>>}){
 const owned=new Map<string,OwnedExecution>();
 function read(owner:OwnerToken,id:string):Result<{action:ActionRecord;payload:z.infer<typeof PendingDispatchPayloadSchema>}>{
  const fenced=store.reserveOutput(owner,id,0);if(!fenced.ok)return fenced;
  const action=store.loadAction(id);if(!action.ok)return action;
  const payload=PendingDispatchPayloadSchema.safeParse(action.value.payload);
  if(action.value.kind!=='PENDING_EXECUTION'||!payload.success||fingerprint(payload.data.descriptor.owner)!==fingerprint(owner))return storeError('INVALID_PENDING_DISPATCH','Pending descriptor does not match its owner');
  return {ok:true as const,value:{action:action.value,payload:payload.data}};
 }
 return {
  recoverOwned(owner:OwnerToken,id:string):Result<OwnedExecution>{const found=read(owner,id);if(!found.ok)return found;const execution=owned.get(id);return execution?{ok:true,value:execution}:storeError('OWNED_EXECUTION_UNAVAILABLE','No retained actual execution is available; durable reconciliation remains required');},
  enqueue(input:PendingDispatchDescriptor,beforeEffect?:()=>void){
   const parsed=PendingDispatchDescriptorSchema.safeParse(input);if(!parsed.success)return storeError('INVALID_PENDING_DISPATCH','Pending descriptor is invalid');
   const descriptor=parsed.data;const payload={schemaVersion:1 as const,descriptor,ownerHash:fingerprint(descriptor.owner),descriptorHash:fingerprint(descriptor)};
   beforeEffect?.();return store.intent(descriptor.owner,{schemaVersion:1,id:descriptor.actionId,runId:descriptor.owner.runId,kind:'PENDING_EXECUTION',payload});
  },
  cancel(owner:OwnerToken,id:string,beforeEffect?:()=>void){const found=read(owner,id);if(!found.ok)return found;beforeEffect?.();return store.cancelUndispatched(owner,id);},
  inspect(owner:OwnerToken,id:string):Result<{actionId:string;generation:number;state:'pending'|'outcome-unknown'|'cancelled-before-dispatch'|'dispatched';dispatchCount:number;createdProcessIdentities:string[];creationEvidenceIds:string[]}>{
   const found=read(owner,id);if(!found.ok)return found;const events=store.listEvents(owner.runId);if(!events.ok)return events;
   const dispatchCount=events.value.filter(e=>e.kind==='ACTION_DISPATCHED'&&e.payload.actionId===id).length;
   const createdProcessIdentities:string[]=[],creationEvidenceIds:string[]=[];
   for(const artifact of store.listArtifacts(owner.runId).filter(a=>a.actionId===id&&a.mediaType===mediaType)){
    try {const bytes=readFileSync(join(store.root,'artifacts',artifact.sha256));if(bytes.length!==artifact.storedBytes||createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error();const p=JSON.parse(bytes.toString());const o=OwnershipReceiptSchema.parse(p.ownership);const d=found.value.payload.descriptor;
     if(p.descriptorHash!==found.value.payload.descriptorHash||o.actionId!==id||o.runId!==owner.runId||o.generation!==owner.generation||o.boundaryHash!==d.launch.boundaryHash||o.role!==d.launch.role)throw Error();
     creationEvidenceIds.push(artifact.id);if(o.environment==='windows')createdProcessIdentities.push(`root:${o.pid}:${o.creationIdentity}`,`helper:${o.helperPid}:${o.helperCreationIdentity}`);else createdProcessIdentities.push(`root:${o.root.pid}:${o.root.startTimeTicks}`,`helper:${o.helper.pid}:${o.helper.startTimeTicks}`);
    }catch{return storeError('INVALID_PENDING_EVIDENCE','Pending creation evidence is invalid');}
   }
   const a=found.value.action;const state=a.state==='INTENDED'?'pending':a.state==='OUTCOME_UNKNOWN'?'outcome-unknown':dispatchCount===0&&events.value.some(e=>e.kind==='ACTION_CANCELLED_UNDISPATCHED'&&e.payload.actionId===id)?'cancelled-before-dispatch':'dispatched';
   return {ok:true as const,value:{actionId:id,generation:owner.generation,state,dispatchCount,createdProcessIdentities,creationEvidenceIds}};
  },
  async dispatch(owner:OwnerToken,id:string,beforeEffect?:()=>void):Promise<Result<OwnedExecution>>{
   const found=read(owner,id);if(!found.ok)return found;if(found.value.action.state!=='INTENDED')return storeError('INVALID_ACTION_TRANSITION','Only pending actions may dispatch');
   let called=false,replayed=false,actual:OwnedExecution|undefined;
   try{
    const result=await options.chargedDispatch(structuredClone(found.value.payload.descriptor),async supervisor=>{
     if(called){replayed=true;return storeError('DISPATCH_REPLAY','Pending launch callback is single-use');}called=true;
     const current=read(owner,id);if(!current.ok)return current;if(current.value.action.state!=='DISPATCHED'||fingerprint(current.value.payload)!==fingerprint(found.value.payload))return storeError('DISPATCH_REQUIRED','Charged atomic dispatch is required');
     beforeEffect?.();const launched=await supervisor.launchOwned(structuredClone(found.value.payload.descriptor.launch));if(!launched.ok){store.unknown(owner,id);return launched;}actual=launched.value;owned.set(id,actual);
     const ownership=OwnershipReceiptSchema.parse(await actual.describe());const d=found.value.payload.descriptor;
     if(ownership.actionId!==id||ownership.runId!==owner.runId||ownership.generation!==owner.generation||ownership.role!==d.launch.role||ownership.boundaryHash!==d.launch.boundaryHash)throw Error('Ownership mismatch');
     const bytes=Buffer.from(JSON.stringify({schemaVersion:1,kind:'pending-execution-created',descriptorHash:found.value.payload.descriptorHash,ownership}));
     const published=await publishArtifact(store,(async function*(){yield bytes;})(),{schemaVersion:1,id:randomUUID(),owner,actionId:id,mediaType,secrets:[]});if(!published.ok)throw Error('Receipt publication failed');return launched;
    });
    if(!called||replayed||!result.ok||result.value!==actual){if(actual)store.unknown(owner,id);return storeError('INVALID_DISPATCH_RESULT','Charged dispatcher did not return its unique actual launch');}return result;
   }catch{store.unknown(owner,id);return storeError('DISPATCH_OUTCOME_UNKNOWN','Pending launch outcome requires reconciliation');}
  }
 };
}
