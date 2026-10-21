/** Mirrors native/supervisor/src/main.rs's bounded evidence-drain tail.
 * Changing the native tail requires changing this source-bound reservation. */
export const SUPERVISOR_DRAIN_TAIL_MS=15000;
export const OBSERVER_TERMINAL_FLUSH_MS=1000;
function required(startedAt:number,deadline:number,count:number,tail:number):number{
 if(!Number.isSafeInteger(startedAt)||startedAt<=0||!Number.isSafeInteger(deadline)||deadline<=startedAt)throw Error('INVALID_PROCESS_DEADLINE');
 const duration=(deadline-startedAt+tail)*count;if(!Number.isSafeInteger(duration))throw Error('PROCESS_DURATION_OVERFLOW');return duration;
}
export const requiredIntegralProcessMs=(startedAt:number,deadline:number)=>required(startedAt,deadline,2,SUPERVISOR_DRAIN_TAIL_MS);
export const requiredStandaloneProcessMs=(startedAt:number,deadline:number)=>required(startedAt,deadline,1,OBSERVER_TERMINAL_FLUSH_MS);
export function assertIntegralProcessBudget(startedAt:number,deadline:number,reservedMs:number):void{if(!Number.isSafeInteger(reservedMs)||reservedMs<requiredIntegralProcessMs(startedAt,deadline))throw Error('INTEGRAL_PROCESS_RESERVE_REQUIRED');}
export function assertStandaloneProcessBudget(startedAt:number,deadline:number,reservedMs:number):void{if(!Number.isSafeInteger(reservedMs)||reservedMs<requiredStandaloneProcessMs(startedAt,deadline))throw Error('STANDALONE_PROCESS_RESERVE_REQUIRED');}
