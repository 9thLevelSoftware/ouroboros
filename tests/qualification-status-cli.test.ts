import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { main } from '../src/cli/main.ts';
import { createQualificationStatusCli } from '../src/qualification/campaign-status-cli.ts';

const doctor={inspectVersion:async()=>{throw Error('Must not launch a version probe');},credentialSourcePresence:()=>({}),lookupQualification:async()=>undefined,platform:'win32',nodeVersion:'24.19.0'};
it('queries a selected recorded campaign without launching doctor probes or granting permission',async()=>{
 const id=randomUUID();let output='';let called=0;
 expect(await main(['doctor','--qualification-status',id],{doctor,stdout:value=>{output+=value;},stderr:()=>{},qualificationStatus:async(actual,acceptance)=>{called++;expect(actual).toBe(id);expect(acceptance).toBeUndefined();return {scope:'recorded-target-only',acceptedEvidenceComplete:false};}})).toBe(0);
 expect(called).toBe(1);expect(JSON.parse(output)).toEqual({scope:'recorded-target-only',acceptedEvidenceComplete:false});
});
it('rejects malformed or extra status arguments before looking up evidence',async()=>{
 let called=false;
 for(const args of [['not-a-uuid'],[randomUUID(),'--approve'],[randomUUID(),'--accepted-reviews']])expect(await main(['doctor','--qualification-status',...args],{doctor,stdout:()=>{},stderr:()=>{},qualificationStatus:async()=>{called=true;}})).toBe(2);
 expect(called).toBe(false);
});
it('does not create an absent store for a status query',async()=>{
 await expect(createQualificationStatusCli(`D:\\nonexistent-${randomUUID()}`)(randomUUID(),undefined)).rejects.toThrow('Existing qualification store required');
});
