import {z} from 'zod';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CampaignCostSchema=z.strictObject({actions:count,activeMs:count,outputBytes:count});
export const UnlimitedAllowanceSchema=z.strictObject({mode:z.literal('unlimited')});
export const CampaignRemainingSchema=z.union([CampaignCostSchema,UnlimitedAllowanceSchema]);
export type CampaignRemaining=z.infer<typeof CampaignRemainingSchema>;
export function isUnlimited(value:CampaignRemaining):value is {mode:'unlimited'} {return 'mode' in value&&value.mode==='unlimited';}
/** Unlimited is a policy state. Measured and reserved quantities remain finite. */
export function remainingAllowance(limits:CampaignRemaining,consumed:z.infer<typeof CampaignCostSchema>,reserved:z.infer<typeof CampaignCostSchema>):CampaignRemaining{
 CampaignRemainingSchema.parse(limits);CampaignCostSchema.parse(consumed);CampaignCostSchema.parse(reserved);
 for(const key of ['actions','activeMs','outputBytes'] as const)if(!Number.isSafeInteger(consumed[key]+reserved[key]))throw Error('CAMPAIGN_COUNTER_OVERFLOW');
 return isUnlimited(limits)?{mode:'unlimited'}:{actions:Math.max(0,limits.actions-consumed.actions-reserved.actions),activeMs:Math.max(0,limits.activeMs-consumed.activeMs-reserved.activeMs),outputBytes:Math.max(0,limits.outputBytes-consumed.outputBytes-reserved.outputBytes)};
}
export function exceedsAllowance(cost:z.infer<typeof CampaignCostSchema>,allowance:CampaignRemaining):boolean{
 CampaignCostSchema.parse(cost);CampaignRemainingSchema.parse(allowance);
 return !isUnlimited(allowance)&&(['actions','activeMs','outputBytes'] as const).some(key=>cost[key]>allowance[key]);
}
