import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type RunStore } from '../src/store/database.ts';
import type { Result } from '../src/contracts/common.ts';
import { DEFAULT_LIMITS } from '../src/contracts/task.ts';
const stores:RunStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function value<T>(result:Result<T>):T{if(!result.ok)throw Error(result.error.code);return result.value;}
function fixture(){
 const store=openStore(mkdtempSync(join(tmpdir(),'ouroboros-usage-')));stores.push(store);const repo=randomUUID(),run=randomUUID();
 value(store.createRun(repo,{schemaVersion:1,id:run,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]},{...DEFAULT_LIMITS,activeMs:1000,verificationMs:1000}));
 const owner=value(store.claim(repo,run)),action=randomUUID();value(store.intent(owner,{schemaVersion:1,id:action,runId:run,kind:'IMPLEMENT',payload:{}}));value(store.dispatch(owner,action));return {store,owner,action,run};
}
it('retains measured failed-execution time once per process identity and enforces the shared cap',()=>{
 const f=fixture();const root={kind:'root' as const,identity:{pid:12,creationIdentity:'root-created'},activeMs:600};
 expect(value(f.store.recordProcessUsage(f.owner,f.action,root))).toEqual({activeMs:600,limit:false});
 expect(value(f.store.recordProcessUsage(f.owner,f.action,root))).toEqual({activeMs:600,limit:false});
 expect(f.store.recordProcessUsage(f.owner,f.action,{...root,activeMs:601})).toMatchObject({ok:false,error:{code:'USAGE_CONFLICT'}});
 expect(value(f.store.recordProcessUsage(f.owner,f.action,{kind:'helper',identity:{pid:13,creationIdentity:'helper-created'},activeMs:650}))).toEqual({activeMs:1250,limit:true});
 value(f.store.outcome(f.owner,f.action,{schemaVersion:1,status:'FAILED',evidenceIds:[]}));
 expect(value(f.store.loadRun(f.run)).cumulativeBudgets.activeMs).toBe(1250);
 expect(f.store.recordProcessUsage({...f.owner,nonce:randomUUID()},f.action,root)).toMatchObject({ok:false,error:{code:'STALE_OWNER'}});
});
