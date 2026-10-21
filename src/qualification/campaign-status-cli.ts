import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HashSchema, IdSchema } from '../contracts/common.ts';
import { openStore } from '../store/database.ts';
import { reportCampaignQualification } from './campaign-report.ts';

export const AcceptedStartupReviewsSchema=z.strictObject({reviews:z.array(z.strictObject({id:IdSchema,sha256:HashSchema})).max(64),acceptedReviewHashes:z.array(HashSchema).max(64)});
export type QualificationStatusCli=(campaignId:string,acceptance:unknown)=>Promise<unknown>;
/** Read an existing store only. No launch, fresh fixture, approval, or run is created. */
export function createQualificationStatusCli(controllerRoot=process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'Ouroboros','controller'):undefined):QualificationStatusCli{
 return async(campaignId,acceptance)=>{
  const id=IdSchema.parse(campaignId),reviews=AcceptedStartupReviewsSchema.parse(acceptance??{reviews:[],acceptedReviewHashes:[]});
  if(!controllerRoot||!existsSync(join(controllerRoot,'store.sqlite')))throw Error('Existing qualification store required');
  const store=openStore(controllerRoot);
  try{const result=reportCampaignQualification(store,id,reviews);if(!result.ok)throw Error(result.error.code);return result.value;}finally{store.close();}
 };
}
