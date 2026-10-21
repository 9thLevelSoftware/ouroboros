import { afterEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, type RunStore } from '../src/store/database.ts';
import { QualificationCampaign } from '../src/qualification/campaign.ts';
import { reportCampaignQualification } from '../src/qualification/campaign-report.ts';
import { targetFingerprint, type QualificationTarget } from '../src/qualification/ledger.ts';

const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const must = <T>(value: {ok:true;value:T}|{ok:false;error:{code:string}}): T => { if (!value.ok) throw Error(value.error.code); return value.value; };
it('reports actual empty campaign evidence without dispatching, closing labels or mutating history', () => {
 const store = openStore(mkdtempSync(join(tmpdir(), 'ouroboros-status-'))); stores.push(store);
 const repositoryId = randomUUID(), runId = randomUUID();
 must(store.createRun(repositoryId, {schemaVersion:1,id:runId,taskId:randomUUID(),phase:'CREATED',blocker:null,generation:0,baselineRef:null,candidateRef:null,sessionRef:null,repairCount:0,cumulativeBudgets:{activeMs:0,outputBytes:0,tokens:null,requests:null,money:null},pendingActionIds:[]}));
 const owner = must(store.claim(repositoryId, runId)), h = 'a'.repeat(64);
 const target:QualificationTarget = {schemaVersion:1,provider:'codex',environment:'windows',runtime:{path:'C:\\fixture\\codex.exe',version:'0.162.1',sha256:h},adapter:{version:'1',sha256:h},helper:{path:'C:\\fixture\\helper.exe',version:'1',sha256:h},verifier:{path:'C:\\fixture\\codex.exe',version:'0.162.1',sha256:h,wrapperHash:h},os:{platform:'win32',architecture:'x64',release:'fixture',sha256:h},policyHash:h,startupConfigHash:h,model:'fixture',effort:'low'};
 const campaign = new QualificationCampaign(store, {authorizeCurrent:()=>{throw Error('No dispatch expected');}}), id=randomUUID();
 must(campaign.create({schemaVersion:2,id,owner,target,targetHash:targetFingerprint(target),controllerHash:h,protocolHash:h,driverHash:h,lineage:must(campaign.lineage(id))}));
 const before=must(store.listQualifications());
 const report=must(reportCampaignQualification(store,id));
 expect(report.acceptedEvidenceComplete).toBe(false);
 expect(report.currentInstallationRevalidated).toBe(false);
 expect(report.blockers).toHaveLength(5);
 expect(report.blockers.every(value=>value.state==='OPEN')).toBe(true);
 expect(report.probes).toHaveLength(32);
 expect(report.probes.every(value=>value.status==='UNTESTED')).toBe(true);
 expect(report.consumed).toEqual({actions:0,activeMs:0,outputBytes:0});
 expect(must(store.listQualifications())).toEqual(before);
});
it('does not manufacture a campaign for an unknown identity', () => {
 const store=openStore(mkdtempSync(join(tmpdir(),'ouroboros-status-missing-')));stores.push(store);
 expect(reportCampaignQualification(store,randomUUID()).ok).toBe(false);
 expect(must(store.listQualifications())).toEqual([]);
});
