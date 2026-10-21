import { z } from 'zod';
import { ExecutionOwnerSchema, type ExecutionOwner } from '../../contracts/execution.ts';
import { ClaudeOptionsSchema, sameOwner } from './options.ts';

export const MAX_CLAUDE_FRAME=1024*1024;
export const MAX_CLAUDE_OUTPUT=10*1024*1024;
export const SafeCodeSchema=z.enum(['PROVIDER_UNAUTHORIZED','PROVIDER_USAGE_LIMIT_EXCEEDED','PROVIDER_RATE_LIMIT_EXCEEDED',
  'PROVIDER_TURN_ERROR','HOOK_DENIED','PROTOCOL_INVALID','AUTHORIZATION_INVALIDATED','OUTPUT_LIMIT_EXCEEDED','LEASE_EXPIRED']);
const id=z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const AccountSchema=z.strictObject({subscriptionType:z.enum(['free','pro','max','team','enterprise','unknown']),
  tokenSource:z.enum(['claude.ai','oauth','unknown']),apiKeySource:z.enum(['none','api_key','unknown']),
  apiProvider:z.enum(['firstParty','unknown'])});
export type SafeAccount=z.infer<typeof AccountSchema>;
const event=z.discriminatedUnion('type',[
  z.strictObject({type:z.enum(['turn_started','turn_completed'])}),
  z.strictObject({type:z.literal('tool_execution'),itemId:id,status:z.enum(['started','completed'])}),
  z.strictObject({type:z.literal('approval'),decision:z.literal('deny'),method:z.literal('PreToolUse')}),
  z.strictObject({type:z.enum(['diagnostic','auth_error','quota_error']),code:SafeCodeSchema})]);
const base={protocolVersion:z.literal(1),...ExecutionOwnerSchema.shape,turnId:z.uuid()};
export const ClaudeFrameSchema=z.discriminatedUnion('type',[
  z.strictObject({...base,type:z.literal('start'),options:ClaudeOptionsSchema,env:z.record(z.string(),z.string().max(4096)),
    cliPath:z.string().min(1).max(4096),prompt:z.string().min(1).max(131072),resumeSessionId:id.nullable()}),
  z.strictObject({...base,type:z.literal('authorize'),authorizationRef:id}),
  z.strictObject({...base,type:z.literal('interrupt'),sessionId:id}),
  z.strictObject({...base,type:z.literal('close'),sessionId:id}),
  z.strictObject({...base,type:z.literal('initialized'),account:AccountSchema,hooksApplied:z.boolean()}),
  z.strictObject({...base,type:z.literal('started'),sessionId:id}),
  z.strictObject({...base,type:z.literal('interrupted'),sessionId:id,acknowledged:z.boolean()}),
  z.strictObject({...base,type:z.literal('event'),sessionId:id,event}),
  z.strictObject({...base,type:z.literal('failed'),code:SafeCodeSchema})]);
export type ClaudeFrame=z.infer<typeof ClaudeFrameSchema>;
export type BridgeBody<T=ClaudeFrame>=T extends ClaudeFrame?Omit<T,keyof ExecutionOwner|'protocolVersion'|'turnId'>:never;
export function encodeClaudeFrame(value:unknown):Buffer{
  const parsed=ClaudeFrameSchema.parse(value);const body=Buffer.from(JSON.stringify(parsed));
  if(!body.length||body.length>MAX_CLAUDE_FRAME)throw Error('Claude frame limit');
  const prefix=Buffer.alloc(4);prefix.writeUInt32LE(body.length);return Buffer.concat([prefix,body]);
}
/** Identity-bound decoder; bounds the announced size before allocating and fails permanently. */
export class ClaudeFrameDecoder{
  private header=Buffer.alloc(4);private headerUsed=0;private body:Buffer|undefined;private used=0;private failed=false;
  private readonly owner:ExecutionOwner;private readonly turnId:string;
  constructor(owner:ExecutionOwner,turnId:string){this.owner=owner;this.turnId=turnId;}
  push(chunk:Uint8Array):ClaudeFrame[]{
    if(this.failed)throw Error('Claude decoder failed');const result:ClaudeFrame[]=[];
    try{let offset=0;while(offset<chunk.length){
      if(!this.body){const n=Math.min(4-this.headerUsed,chunk.length-offset);this.header.set(chunk.subarray(offset,offset+n),this.headerUsed);this.headerUsed+=n;offset+=n;
        if(this.headerUsed<4)continue;const size=this.header.readUInt32LE();if(!size||size>MAX_CLAUDE_FRAME)throw Error('Claude frame limit');this.body=Buffer.alloc(size);this.used=0;}
      const n=Math.min(this.body.length-this.used,chunk.length-offset);this.body.set(chunk.subarray(offset,offset+n),this.used);this.used+=n;offset+=n;
      if(this.used===this.body.length){const frame=ClaudeFrameSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.body)));
        if(!sameOwner(frame,this.owner)||frame.turnId!==this.turnId)throw Error('Claude frame identity mismatch');result.push(frame);this.body=undefined;this.headerUsed=0;}
    }return result;}catch(error){this.failed=true;throw error;}
  }
  finish(){if(this.failed||this.body||this.headerUsed)throw Error('Truncated Claude frame');}
}
