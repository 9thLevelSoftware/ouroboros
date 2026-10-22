import {createHash,randomUUID} from 'node:crypto';
import {loadAdministrativeEvidence,type AdministrativeGateContext} from '../../src/qualification/campaign-administration.ts';
/** Explicitly synthetic observations for contract tests, never live evidence. */
export function administrativeFixture(context:AdministrativeGateContext){
 const data=new Map<string,Buffer>(),put=(value:unknown,id=randomUUID())=>{const b=Buffer.from(typeof value==='string'?value:JSON.stringify(value));data.set(id,b);return {id,sha256:createHash('sha256').update(b).digest('hex')};};
 const invocations:any[]=[],receipts:any[]=[];let pid=100;
 const add=(id:string,role:string,operationId?:string)=>{const identity={pid:pid++,creationIdentity:id},boundsEvidence=put('SIMULATION finite source-backed bounds');
  const invocation=put({schemaVersion:1,kind:'administrative-invocation',id,campaignId:context.campaignId,targetHash:context.targetHash,authorityHash:context.policy.authorityHash,role,...(operationId?{operationId}:{}),identity,createdAt:1001,inputPinsHash:'a'.repeat(64),invocationHash:'a'.repeat(64),outputLimitBytes:100,activeLimitMs:100,boundsEvidence},id);
  const rawResult=put({exit_code:0,output:'',session_id:null}),terminal=put({schemaVersion:1,kind:'existing-control-plane-terminal',authorityHash:context.policy.authorityHash,invocationId:id,identity,initialIssuedAt:1000,observedAfterExitAt:1002,chain:[{toolCallId:randomUUID(),chunkId:randomUUID(),sessionId:null,exitCode:0,rawResult}],unresolvedSessions:[],unresolvedStreams:[]});
  const receipt=put({schemaVersion:1,kind:'administrative-terminal-receipt',invocation,terminal:{mode:'control-plane-conservative',evidence:terminal,startedNoLaterThan:1000,observedExitedBy:1002,activeMsUpperBound:2},output:{mode:'exact-streams',rawOutputBytes:0,evidence:put('')}});invocations.push(invocation);receipts.push(receipt);
 };
 for(const id of context.policy.preparationInvocationIds)add(id,'preparation');
 add(context.policy.registrationInvocationId,'registration');for(let i=1;i<context.policy.registrationProcessCount;i++)add(randomUUID(),'registration');
 if(context.priorOperationId)for(const role of ['unit-wrapper','settlement'])for(let i=0;i<(role==='unit-wrapper'?context.policy.unitWrapperProcessCount:context.policy.settlementProcessCount);i++)add(randomUUID(),role,context.priorOperationId);
 const ledger={schemaVersion:1 as const,kind:'administrative-evidence-ledger' as const,campaignId:context.campaignId,targetHash:context.targetHash,authorityHash:context.policy.authorityHash,grantHash:context.grantHash,historyHash:context.historyHash,invocations,receipts};
 const input={ledger,readArtifact:(ref:{id:string})=>{const b=data.get(ref.id);if(!b)throw Error('MISSING');return b;},authorizeLedger:()=>true,authorizeControlPlane:()=>true,authorizeOutput:()=>true};
 return {data,input,load:()=>loadAdministrativeEvidence(input)};
}
