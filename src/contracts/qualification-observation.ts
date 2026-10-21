import { z } from 'zod';
import { ExecutionOwnerSchema } from './execution.ts';
import { BytesSchema, HashSchema, PositiveLimitSchema, TextSchema } from './common.ts';

/** Additive qualification protocol. These observations confer no qualification verdict. */
export const ObservedProcessIdentitySchema = z.strictObject({pid:PositiveLimitSchema,creationIdentity:TextSchema});
export type ObservedProcessIdentity = z.infer<typeof ObservedProcessIdentitySchema>;
export const ObservationDeathTargetSchema = z.strictObject({kind:z.enum(['controller','helper']),identity:ObservedProcessIdentitySchema});
export type ObservationDeathTarget = z.infer<typeof ObservationDeathTargetSchema>;
export const ObservationTriggerSchema = z.strictObject({target:ObservationDeathTargetSchema,triggeredAt:PositiveLimitSchema,targetExited:z.literal(true),targetExitedAt:PositiveLimitSchema});
export type ObservationTrigger = z.infer<typeof ObservationTriggerSchema>;
export const ObservationStartSchema=z.strictObject({schemaVersion:z.literal(1),...ExecutionOwnerSchema.shape,observer:ObservedProcessIdentitySchema,controller:ObservedProcessIdentitySchema,outerJobIdentity:TextSchema,capturedAt:PositiveLimitSchema});
export type ObservationStart=z.infer<typeof ObservationStartSchema>;
export const ObservedExecutionSchema = z.strictObject({schemaVersion:z.literal(1),...ExecutionOwnerSchema.shape,boundaryHash:HashSchema,
 observer:ObservedProcessIdentitySchema,controller:ObservedProcessIdentitySchema,helper:ObservedProcessIdentitySchema,root:ObservedProcessIdentitySchema,
 outerJobIdentity:TextSchema,innerJobIdentity:TextSchema,proofMethod:z.literal('windows-outer-superset-v1'),nestedSubsetEstablished:z.literal(true),
 assignedBeforeResume:z.literal(true),handoffBeforeResume:z.literal(true),helperOwnsOnlyInnerJobHandle:z.literal(true),capturedAt:PositiveLimitSchema,
 descendants:z.array(ObservedProcessIdentitySchema.extend({jobIdentity:TextSchema})).default([]),
}).superRefine((v,c)=>{if(new Set([v.observer.pid,v.controller.pid,v.helper.pid,v.root.pid]).size!==4||v.outerJobIdentity===v.innerJobIdentity)c.addIssue({code:'custom',message:'Observation topology identities overlap'});});
export type ObservedExecution = z.infer<typeof ObservedExecutionSchema>;
export const ObservationStreamSchema = z.strictObject({source:z.enum(['root','controller']),stream:z.enum(['stdout','stderr']),bytes:BytesSchema,eofCount:z.number().int().min(0).max(1)});
const base64=z.string().refine(s=>Buffer.from(s,'base64').toString('base64')===s,'Noncanonical base64');
export const CapturedOutputSchema=z.strictObject({streams:z.array(ObservationStreamSchema.extend({data:base64})).max(4),totalBytes:BytesSchema,overflow:z.boolean(),readerFailure:z.boolean(),offset:BytesSchema.optional(),nextOffset:BytesSchema.nullable().optional()});
export type CapturedOutput=z.infer<typeof CapturedOutputSchema>;
export const ObservationProcessMeterSchema=z.strictObject({kind:z.enum(['root','helper','controller','guardian']),identity:ObservedProcessIdentitySchema,createdAt:PositiveLimitSchema,exitedAt:PositiveLimitSchema.nullable(),activeMs:BytesSchema,outputBytes:BytesSchema.nullable()});
export const QualificationTerminalSchema=z.strictObject({schemaVersion:z.literal(1),...ExecutionOwnerSchema.shape,description:ObservedExecutionSchema,
 processMeters:z.array(ObservationProcessMeterSchema).max(4),processMeterError:z.boolean(),
 controllerExitCode:z.number().int().min(0).max(4294967295).nullable().optional(),rootExited:z.boolean(),rootExitCode:z.number().int().min(0).max(4294967295).nullable(),rootExitCause:z.enum(['natural','controller-eof','helper-job-close','supervisor-drain','emergency-cleanup','unknown']),helperExited:z.boolean(),controllerExited:z.boolean(),
 rootLifetimeMs:BytesSchema.nullable(),helperLifetimeMs:BytesSchema.nullable(),
 outerActiveProcesses:BytesSchema.nullable(),outerMembershipEmpty:z.boolean().nullable(),outerQueryError:TextSchema.nullable(),proofMethod:z.literal('windows-outer-superset-v1'),
 outputComplete:z.boolean(),streams:z.array(ObservationStreamSchema).length(4),totalRawBytes:BytesSchema,overflow:z.boolean(),readerFailure:z.boolean(),emergencyTerminated:z.boolean(),controllerRetiredAfterHelperExit:z.boolean(),trigger:ObservationTriggerSchema.nullable(),
 unrelated:z.strictObject({identity:ObservedProcessIdentitySchema,name:TextSchema,alive:z.boolean(),outsideHierarchy:z.boolean()}).nullable(),observedAt:PositiveLimitSchema,
}).superRefine((v,c)=>{
 const keys=v.streams.map(s=>`${s.source}:${s.stream}`);
 if(new Set(keys).size!==4||v.rootExited!==(v.rootExitCode!==null)||(v.outerActiveProcesses===null)!==(v.outerMembershipEmpty===null)||(v.outerQueryError!==null)!==(v.outerActiveProcesses===null)||v.outerMembershipEmpty!==(v.outerActiveProcesses===null?null:v.outerActiveProcesses===0)||v.outputComplete!==(!v.overflow&&!v.readerFailure&&v.streams.every(s=>s.eofCount===1))||v.totalRawBytes!==v.streams.reduce((n,s)=>n+s.bytes,0))c.addIssue({code:'custom',message:'Inconsistent terminal observation'});
 if(Object.entries({runId:v.runId,generation:v.generation,actionId:v.actionId,role:v.role}).some(([k,value])=>v.description[k as keyof ObservedExecution]!==value))c.addIssue({code:'custom',message:'Terminal description identity mismatch'});
 const kinds=v.processMeters.map(m=>m.kind);if(new Set(kinds).size!==kinds.length||(!v.processMeterError&&kinds.length!==4))c.addIssue({code:'custom',message:'Process meter coverage unknown'});
 for(const meter of v.processMeters){const expected=v.description[meter.kind==='guardian'?'observer':meter.kind];if(meter.identity.pid!==expected.pid||meter.identity.creationIdentity!==expected.creationIdentity||(meter.exitedAt!==null&&meter.exitedAt<meter.createdAt))c.addIssue({code:'custom',message:'Process meter identity or lifetime mismatch'});}
 if(!v.processMeterError&&((v.rootLifetimeMs!==null)!==v.rootExited||(v.helperLifetimeMs!==null)!==v.helperExited))c.addIssue({code:'custom',message:'Completed process lifetime unavailable'});
});
export type QualificationTerminal=z.infer<typeof QualificationTerminalSchema>;
export interface QualificationObservationClient {
 start():Promise<ObservationStart>;
 describeObservedExecution():Promise<ObservedExecution>;
 triggerDeath(target:ObservationDeathTarget):Promise<ObservationTrigger>;
 observeTerminal(timeoutMs?:number):Promise<QualificationTerminal>;
 readCapturedOutput():Promise<CapturedOutput>;
 emergencyCleanup(reason:string):Promise<{emergencyTerminated:true;observedAt:number}>;
 close():Promise<{guardianExited:true;outputEof:true;exitCode:0;rawBytes:number;activeMs:number}>;
 onRawOutput(listener:(output:{stream:'stdout'|'stderr';data:Buffer})=>void):()=>void;
 controller:{write(bytes:Uint8Array):Promise<void>;onData(listener:(bytes:Buffer)=>void):()=>void;end():Promise<void>};
}
