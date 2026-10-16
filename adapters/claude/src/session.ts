import { posix } from 'node:path';
import type { AccountInfo, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeOptionsSchema, preToolGate, projectEnvironment, validBashInput, type ClaudeOptionsProjection } from './options.ts';
import { AccountSchema, MAX_CLAUDE_OUTPUT, type BridgeBody, type SafeAccount } from '../../../src/providers/claude/frames.ts';

type SdkQuery=Pick<Query,'initializationResult'|'accountInfo'|'interrupt'|'close'> & AsyncIterable<SDKMessage>;
export type QueryFactory=(args:{prompt:AsyncIterable<SDKUserMessage>;options:Options})=>SdkQuery;
type SessionInput={options:ClaudeOptionsProjection;env:Record<string,string>;cliPath:string;prompt:string;turnId:string;
  resumeSessionId:string|null;queryFactory:QueryFactory;send:(frame:BridgeBody)=>Promise<void>};
function accountProjection(value:AccountInfo):SafeAccount{
  const subscription=AccountSchema.shape.subscriptionType.safeParse(value.subscriptionType);
  return {subscriptionType:subscription.success?subscription.data:'unknown',
    tokenSource:value.tokenSource==='claude.ai'||value.tokenSource==='oauth'?value.tokenSource:'unknown',
    apiKeySource:value.apiKeySource==='none'?'none':value.apiKeySource?'api_key':'unknown',
    apiProvider:value.apiProvider==='firstParty'?'firstParty':'unknown'};
}
export function subscriptionSafe(account:SafeAccount){return account.apiKeySource==='none'&&
  account.tokenSource!=='unknown'&&account.apiProvider==='firstParty'&&account.subscriptionType!=='unknown';}
function messageUuid(value:string):NonNullable<SDKUserMessage['uuid']>{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw Error('Invalid SDK message identity');
  const parts=value.split('-');return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}-${parts[4]}`;
}
/** Conversion is checked by the pinned SDK declarations in the isolated Linux build. */
export function createSdkSession(input:SessionInput){
  const projection=ClaudeOptionsSchema.parse(input.options);const env=projectEnvironment(input.env);
  if(!env.ok||!posix.isAbsolute(input.cliPath)||/[\0\r\n]/.test(input.cliPath)||!input.prompt||Buffer.byteLength(input.prompt)>131072)
    throw Error('Unsafe Claude startup input');
  let release!:(accepted:boolean)=>void;const gate=new Promise<boolean>(resolve=>{release=resolve;});
  let stopInput!:()=>void;const inputClosed=new Promise<void>(resolve=>{stopInput=resolve;});
  let accepted=false,ready=false,stopping=false,closed=false,sessionId:string|undefined,query:SdkQuery|undefined,output=0;
  let terminal:Promise<void>|undefined;
  const emit=async(frame:BridgeBody)=>{if(!closed&&!terminal)await input.send(frame);};
  const close=async()=>{stopping=true;if(closed)return;closed=true;release(false);stopInput();query?.close();};
  /** Fence synchronously. Send the sole sanitized stop directly before close suppresses
   * emissions; a stalled or rejected sink must never postpone SDK close indefinitely. */
  const terminalFailure=(code:'OUTPUT_LIMIT_EXCEEDED'|'PROTOCOL_INVALID'|'PROVIDER_TURN_ERROR'):Promise<void>=>{
    if(terminal)return terminal;if(closed)return Promise.resolve();stopping=true;
    terminal=Promise.resolve().then(async()=>{
      let timer:NodeJS.Timeout|undefined;
      try{await Promise.race([input.send({type:'failed',code}),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Claude terminal send timeout')),15000);
      })]);}catch{/* No raw error or unframed fallback escapes a rejected/failed sink. */}
      finally{clearTimeout(timer);try{await close();}catch{/* The close fence was already set synchronously. */}}
    });return terminal;
  };
  const outputExhausted=Symbol('Claude raw output exhausted');
  const deny=()=>({hookSpecificOutput:{hookEventName:'PreToolUse' as const,permissionDecision:'deny' as const,permissionDecisionReason:'Tool boundary denied'}});
  const prompt:AsyncIterable<SDKUserMessage>={async *[Symbol.asyncIterator](){
    if(await gate&&!stopping&&!closed){yield {type:'user',message:{role:'user',content:input.prompt},parent_tool_use_id:null,uuid:messageUuid(input.turnId)};await inputClosed;}
  }};
  const count=(value:unknown)=>{output+=Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));if(output>MAX_CLAUDE_OUTPUT)throw outputExhausted;};
  const hook:NonNullable<Options['hooks']>={PreToolUse:[{hooks:[async request=>{
    if(stopping||closed)return deny();
    try{count(request);}catch(error){await terminalFailure(error===outputExhausted?'OUTPUT_LIMIT_EXCEEDED':'PROTOCOL_INVALID');return deny();}
    const identityMatches=!stopping&&!closed&&accepted&&sessionId&&request.session_id===sessionId&&request.cwd===projection.cwd&&
      (!request.prompt_id||request.prompt_id===input.turnId);
    const result=await preToolGate(identityMatches?request:null);
    // Stop may have begun while the async gate was running; never return a late grant.
    if(stopping||closed)return deny();
    if(result.hookSpecificOutput.permissionDecision==='deny'&&sessionId)await emit({type:'event',sessionId,event:{type:'approval',decision:'deny',method:'PreToolUse'}});
    return result;
  }]}]};
  const options:Options={...projection,env:env.value,pathToClaudeCodeExecutable:input.cliPath,hooks:hook,
    permissionMode:'dontAsk',allowDangerouslySkipPermissions:false,enableFileCheckpointing:false,
    includePartialMessages:false,persistSession:true,stderr:data=>{
      if(stopping||closed)return;try{count(data);}catch{void terminalFailure('OUTPUT_LIMIT_EXCEEDED');}},
    ...(input.resumeSessionId?{resume:input.resumeSessionId}:{})};
  const initialized=(async()=>{
    try{
      query=input.queryFactory({prompt,options});if(stopping||closed){
        if(terminal)await terminal;else if(closed)query.close();else await close();
        throw Error('Provider stopped during startup');}
      const initialization=await query.initializationResult();const observed=accountProjection(await query.accountInfo());
      if(initialization.hooks_applied!==true||!subscriptionSafe(observed)||
          JSON.stringify(accountProjection(initialization.account))!==JSON.stringify(observed))throw Error('Subscription initialization rejected');
      ready=true;await emit({type:'initialized',account:observed,hooksApplied:true});return observed;
    }catch{await close();throw Error('Claude initialization authorization failed');}
  })();
  void initialized.catch(()=>{});
  const finished=(async()=>{
    try{
      await initialized;if(!await gate||closed)return;
      for await(const message of query!){
        // Count the raw provider bytes before any projection/redaction. No raw provider text escapes.
        count(message);
        if(closed)break;
        if(message.type==='system'&&message.subtype==='init'){
          if(sessionId||message.claude_code_version!=='2.1.299'||message.cwd!==projection.cwd||message.model!==projection.model||
              message.apiKeySource!=='none'||message.permissionMode!=='dontAsk'||message.tools.length!==1||message.tools[0]!=='Bash'||
              message.mcp_servers.length||message.skills.length||message.plugins.length||(message.plugin_errors?.length??0)||
              (input.resumeSessionId&&message.session_id!==input.resumeSessionId))throw Error('Provider initialization drift');
          sessionId=message.session_id;await emit({type:'started',sessionId});await emit({type:'event',sessionId,event:{type:'turn_started'}});continue;
        }
        if(!sessionId)throw Error('Provider message before initialization');
        if('session_id' in message&&message.session_id!==sessionId)throw Error('Provider session identity mismatch');
        if('parent_tool_use_id' in message&&message.parent_tool_use_id!==null)throw Error('Unexpected subagent output');
        if('user_message_uuid' in message&&message.user_message_uuid&&message.user_message_uuid!==input.turnId)throw Error('Provider turn identity mismatch');
        if(message.type==='assistant'){
          if(message.error){
            const auth=['authentication_failed','oauth_org_not_allowed','account_on_hold','verification_required','cloud_credential_error'].includes(message.error);
            const quota=['billing_error','rate_limit'].includes(message.error);
            await emit({type:'event',sessionId,event:{type:auth?'auth_error':quota?'quota_error':'diagnostic',
              code:auth?'PROVIDER_UNAUTHORIZED':quota?'PROVIDER_RATE_LIMIT_EXCEEDED':'PROVIDER_TURN_ERROR'}});
            throw Error('Provider error');
          }
          for(const block of message.message.content)if(block.type==='tool_use'){
            if(block.name!=='Bash'||!validBashInput(block.input))throw Error('Unexpected tool');
            await emit({type:'event',sessionId,event:{type:'tool_execution',itemId:block.id,status:'started'}});
          }
        }else if(message.type==='user'){
          const content=message.message.content;if(Array.isArray(content))for(const block of content)if(block.type==='tool_result')
            await emit({type:'event',sessionId,event:{type:'tool_execution',itemId:block.tool_use_id,status:'completed'}});
        }else if(message.type==='result'){
          if(message.is_error){await emit({type:'event',sessionId,event:{type:'diagnostic',code:'PROVIDER_TURN_ERROR'}});throw Error('Provider failed completion');}
          if(message.permission_denials.length)await emit({type:'event',sessionId,event:{type:'approval',decision:'deny',method:'PreToolUse'}});
          await emit({type:'event',sessionId,event:{type:'turn_completed'}});
        }
      }
    }catch(error){await terminalFailure(error===outputExhausted?'OUTPUT_LIMIT_EXCEEDED':'PROVIDER_TURN_ERROR');}
  })();
  return {initialized,finished,
    authorize(ref:string){if(!ready||accepted||stopping||closed||!/^[A-Za-z0-9_-]{1,256}$/.test(ref))throw Error('Invalid observed authorization');accepted=true;release(true);},
    async interrupt(expected:string){if(!sessionId||expected!==sessionId||stopping||closed)throw Error('Invalid session interrupt');stopping=true;
      // A typed receipt only acknowledges SDK control. The Windows owner obtains OS drainage separately.
      await query!.interrupt();await emit({type:'interrupted',sessionId,acknowledged:true});},close};
}
