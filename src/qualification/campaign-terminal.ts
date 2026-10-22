import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {HashSchema,IdSchema} from '../contracts/common.ts';
import {ExecutionOwnerSchema,WindowsOwnershipReceiptSchema,WindowsDrainEvidenceSchema} from '../contracts/execution.ts';
import {QualificationTerminalSchema} from '../contracts/qualification-observation.ts';
import type {RunStore} from '../store/database.ts';
import type {BatchApproval,CampaignAction} from './campaign.ts';
import {isTerminalDrained} from './session-drivers.ts';
import {fingerprint} from './probes.ts';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),positive=count.positive();
const identity=z.strictObject({pid:positive,creationIdentity:z.string().min(1).max(256)});
export const CampaignResourceTerminalSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('owned-execution'),ownership:WindowsOwnershipReceiptSchema,drain:z.union([WindowsDrainEvidenceSchema,QualificationTerminalSchema]),
  brokerInventory:z.strictObject({inventoryComplete:z.literal(true),active:z.array(z.string()).length(0),unresolved:z.array(z.string()).length(0)})}),
 z.strictObject({kind:z.literal('endpoint'),ownership:WindowsOwnershipReceiptSchema,drain:WindowsDrainEvidenceSchema,terminated:z.literal(true),outputComplete:z.literal(true)}),
 z.strictObject({kind:z.literal('auxiliary-exit'),owner:ExecutionOwnerSchema,identity,createdAt:positive,completedAt:positive,activeMs:count,exitCode:z.number().int(),outputComplete:z.literal(true)}),
]);
export type CampaignResourceTerminal=z.infer<typeof CampaignResourceTerminalSchema>;
export const CampaignTerminalObservationSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('campaign-terminal-observation'),targetHash:HashSchema,batchId:IdSchema,actionId:IdSchema,launchHash:HashSchema,
 resource:CampaignResourceTerminalSchema,processMeters:z.array(z.strictObject({kind:z.enum(['root','helper']),identity,activeMs:count})).max(2),primaryOutputBytes:count,cleanupOutputBytes:count,rawOutputBytes:count,
 streamCounters:z.array(z.strictObject({source:z.enum(['root','helper','controller','guardian']),stream:z.enum(['stdout','stderr']),bytes:count})).max(8),observedAt:positive});

/** Output listeners omit streams that never emit. Only a complete owned terminal
 * can prove that an absent listener counter represents zero bytes. */
function matchesTerminalStream(counters:z.infer<typeof CampaignTerminalObservationSchema>['streamCounters'],stream:z.infer<typeof QualificationTerminalSchema>['streams'][number],drain:z.infer<typeof QualificationTerminalSchema>,ownership:z.infer<typeof WindowsOwnershipReceiptSchema>,probeId:string){
 const actual=counters.find(s=>s.source===stream.source&&s.stream===stream.stream);
 return actual?actual.bytes===stream.bytes:stream.bytes===0&&stream.eofCount===1&&isTerminalDrained(drain,ownership,probeId);
}

/** Structural terminal verification is deliberately separate from a probe PASS.
 * The publisher and consumer bind the actual ownership and finite usage. */
export function validateCampaignTerminal(raw:unknown,batch:BatchApproval,action:CampaignAction){
 const o=CampaignTerminalObservationSchema.parse(raw),r=o.resource,owner=r.kind==='auxiliary-exit'?r.owner:r.ownership;
 if(o.targetHash!==batch.targetHash||o.batchId!==batch.id||o.actionId!==action.id||o.launchHash!==action.launchHash||owner.runId!==batch.owner.runId||owner.generation!==batch.owner.generation||owner.actionId!==action.id||o.primaryOutputBytes>action.maxOutputBytes||o.rawOutputBytes!==o.primaryOutputBytes+o.cleanupOutputBytes||!Number.isSafeInteger(o.rawOutputBytes)||new Set(o.streamCounters.map(s=>s.source+':'+s.stream)).size!==o.streamCounters.length||o.streamCounters.reduce((n,s)=>n+s.bytes,0)>o.rawOutputBytes||o.observedAt<batch.approvedAt)throw Error('CAMPAIGN_TERMINAL_BINDING_CHANGED');
 if(r.kind==='auxiliary-exit'){
  if(action.kind!=='preparation'||!action.auxiliaryRole||owner.role!==`qualification-${action.auxiliaryRole}`||r.completedAt<r.createdAt||r.completedAt>o.observedAt||r.createdAt<batch.approvedAt||r.activeMs<r.completedAt-r.createdAt||r.activeMs>action.maxMs||o.processMeters.length)throw Error('CAMPAIGN_AUXILIARY_EXIT_INCOMPLETE');
 }else{
  if((action.kind==='endpoint')!==(r.kind==='endpoint')||!isTerminalDrained(r.drain,r.ownership,action.probeId??''))throw Error('CAMPAIGN_OWNED_DRAIN_INCOMPLETE');
  if(o.processMeters.length!==2||new Set(o.processMeters.map(m=>m.kind)).size!==2)throw Error('CAMPAIGN_TERMINAL_METERS_INCOMPLETE');
  for(const m of o.processMeters){const expected=m.kind==='root'?{pid:r.ownership.pid,creationIdentity:r.ownership.creationIdentity}:{pid:r.ownership.helperPid,creationIdentity:r.ownership.helperCreationIdentity};if(fingerprint(m.identity)!==fingerprint(expected))throw Error('CAMPAIGN_TERMINAL_METER_CHANGED');}
  if('processMeters' in r.drain){
   for(const m of o.processMeters){const underlying=r.drain.processMeters.filter(n=>n.kind===m.kind);if(underlying.length!==1||fingerprint(underlying[0]!.identity)!==fingerprint(m.identity)||underlying[0]!.activeMs!==m.activeMs||m.activeMs!==(m.kind==='root'?r.drain.rootLifetimeMs:r.drain.helperLifetimeMs))throw Error('CAMPAIGN_TERMINAL_METER_CONTRADICTION');}
   for(const stream of r.drain.streams.filter(s=>s.source==='root'))if(!matchesTerminalStream(o.streamCounters,stream,r.drain,r.ownership,action.probeId??''))throw Error('CAMPAIGN_TERMINAL_OUTPUT_CONTRADICTION');
  }
  if(o.processMeters.reduce((n,m)=>n+m.activeMs,0)>action.maxMs)throw Error('CAMPAIGN_TERMINAL_USAGE_EXCEEDED');
 }
 return o;
}
export function validateCampaignTerminalUsage(o:z.infer<typeof CampaignTerminalObservationSchema>,usage:{elapsedMs:number;outputBytes:number},terminalArtifactBytes=0){
 count.parse(usage.elapsedMs);count.parse(usage.outputBytes);count.parse(terminalArtifactBytes);
 const activeMs=o.resource.kind==='auxiliary-exit'?o.resource.activeMs:o.processMeters.reduce((n,m)=>n+m.activeMs,0),outputBytes=o.primaryOutputBytes+terminalArtifactBytes;
 if(!Number.isSafeInteger(activeMs)||!Number.isSafeInteger(outputBytes)||usage.elapsedMs<activeMs||usage.outputBytes<outputBytes)throw Error('CAMPAIGN_RESULT_USAGE_UNDERREPORTED');
 return {activeMs,outputBytes};
}
export function validateCampaignTerminalTopology(entries:readonly {action:CampaignAction;terminal:z.infer<typeof CampaignTerminalObservationSchema>}[],cleanupUsage:ReadonlyMap<string,{outputBytes:number}>){
 const cleanupTotals=new Map<string,number>();
 for(const entry of entries){const {action,terminal:o}=entry;if(!action.cleanupId)throw Error('CAMPAIGN_TERMINAL_CLEANUP_MISSING');cleanupTotals.set(action.cleanupId,(cleanupTotals.get(action.cleanupId)??0)+o.cleanupOutputBytes);
  if(o.resource.kind!=='owned-execution'||!('processMeters' in o.resource.drain))continue;
  const drain=o.resource.drain;
  for(const role of ['controller','guardian'] as const){const expected=drain.description[role==='guardian'?'observer':'controller'],matches=entries.filter(e=>e.action.auxiliaryFor===action.id&&e.action.auxiliaryRole===role&&e.terminal.resource.kind==='auxiliary-exit'&&fingerprint(e.terminal.resource.identity)===fingerprint(expected));
   if(matches.length!==1)throw Error('CAMPAIGN_TERMINAL_AUXILIARY_LINK_MISSING');const auxiliary=matches[0]!.terminal,r=auxiliary.resource;if(r.kind!=='auxiliary-exit'||r.owner.runId!==o.resource.ownership.runId||r.owner.generation!==o.resource.ownership.generation||r.owner.role!==`qualification-${role}`)throw Error('CAMPAIGN_TERMINAL_AUXILIARY_LINK_CHANGED');
   const meter=drain.processMeters.find(m=>m.kind===role);if(!meter||r.activeMs<meter.activeMs)throw Error('CAMPAIGN_TERMINAL_AUXILIARY_TIME_UNDERREPORTED');
   if(role==='controller')for(const stream of drain.streams.filter(s=>s.source==='controller'))if(!matchesTerminalStream(auxiliary.streamCounters,stream,drain,o.resource.ownership,action.probeId??''))throw Error('CAMPAIGN_TERMINAL_CONTROLLER_OUTPUT_CONTRADICTION');
  }
 }
 for(const [id,total] of cleanupTotals)if(!Number.isSafeInteger(total)||!cleanupUsage.has(id)||cleanupUsage.get(id)!.outputBytes<total)throw Error('CAMPAIGN_CLEANUP_USAGE_UNDERREPORTED');
}
export function loadCampaignTerminal(store:RunStore,batch:BatchApproval,action:CampaignAction,refs:readonly {id:string;sha256:string;category:string}[],usage?:{elapsedMs:number;outputBytes:number}){
 const candidates=refs.filter(r=>r.category==='terminal-observation');if(candidates.length!==1)throw Error('CAMPAIGN_TERMINAL_EVIDENCE_REQUIRED');
 const ref=candidates[0]!,a=store.loadArtifact(ref.id);if(!a.ok||a.value.runId!==batch.owner.runId||a.value.actionId!==action.id||a.value.sha256!==ref.sha256||a.value.truncated||a.value.producerStopRequired||a.value.redactionApplied||a.value.storedBytes>262144)throw Error('CAMPAIGN_TERMINAL_ARTIFACT_INCOMPLETE');
 const bytes=readFileSync(join(store.root,'artifacts',ref.sha256));if(bytes.length!==a.value.storedBytes||createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('CAMPAIGN_TERMINAL_BYTES_CHANGED');
 const terminal=validateCampaignTerminal(JSON.parse(bytes.toString('utf8')),batch,action);if(usage)validateCampaignTerminalUsage(terminal,usage,a.value.rawBytes);return terminal;
}
