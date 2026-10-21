import { expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.ts';
const doctor={platform:'win32',nodeVersion:'24.19.0',credentialSourcePresence:()=>({}),inspectVersion:async()=>undefined,lookupQualification:async()=>undefined};
it('exposes a task-file run command without qualification flags',async()=>{
 const run=vi.fn(async()=>({status:'READY_FOR_REVIEW',reportPath:'C:\\report.json',patch:'C:\\patch.diff'}));const stdout=vi.fn();
 const code=await main(['run','--task-file','C:\\task.json','--json'],{doctor,stdout,stderr:vi.fn(),readTask:async()=>({schemaVersion:1}),run} as any);
 expect(code).toBe(0);expect(run).toHaveBeenCalledTimes(1);expect(stdout.mock.calls[0][0]).toContain('READY_FOR_REVIEW');
});
it('propagates a failed task and rejects malformed or duplicate arguments before running',async()=>{
 const run=vi.fn(async()=>({status:'FAILED',code:'VERIFICATION_FAILED',reportPath:'C:\\report.json',patch:null}));const deps={doctor,stdout:vi.fn(),stderr:vi.fn(),readTask:async()=>({}),run};
 expect(await main(['run','--task-file','C:\\task.json'],deps as any)).toBe(1);
 run.mockClear();expect(await main(['run','--task-file','C:\\task.json','--task-file','C:\\other.json'],deps as any)).toBe(2);expect(run).not.toHaveBeenCalled();
});
