import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ExecutionOwnerSchema } from '../../../src/contracts/execution.ts';
import { ClaudeFrameDecoder, encodeClaudeFrame, MAX_CLAUDE_OUTPUT, type BridgeBody, type ClaudeFrame } from '../../../src/providers/claude/frames.ts';
import { createSdkSession } from './session.ts';

const bootstrap=z.strictObject({owner:ExecutionOwnerSchema,turnId:z.uuid(),deadline:z.number().int().positive()});
/** Linux-only trusted entry. stdout carries only protocol frames; no provider text is logged. */
async function main(){
  const state=bootstrap.parse(JSON.parse(process.argv[2]??''));
  if(process.platform!=='linux'||state.deadline<=Date.now()||state.deadline>Date.now()+1800000)throw Error('Invalid bridge launch');
  const decoder=new ClaudeFrameDecoder(state.owner,state.turnId);
  let session:ReturnType<typeof createSdkSession>|undefined,started=false,stopped=false,faulted=false,queued=0,outputBytes=0;
  let writes=Promise.resolve(),controls=Promise.resolve();
  const send=(body:BridgeBody)=>{
    const next=writes.then(async()=>{const bytes=encodeClaudeFrame({protocolVersion:1,...state.owner,turnId:state.turnId,...body});
      outputBytes+=bytes.length;if(outputBytes>MAX_CLAUDE_OUTPUT)throw Error('Bridge output exhausted');
      for(let offset=0;offset<bytes.length;offset+=65536)await new Promise<void>((resolve,reject)=>{
        process.stdout.write(bytes.subarray(offset,offset+65536),error=>error?reject(error):resolve());
      });});writes=next.catch(()=>{});return next;
  };
  const stop=async()=>{if(stopped)return;stopped=true;clearTimeout(deadline);clearTimeout(initialization);
    process.stdin.pause();await session?.close();};
  const invalid=async()=>{if(faulted)return;faulted=true;await stop();try{await send({type:'failed',code:'PROTOCOL_INVALID'});}catch{/* No unframed fallback output. */}finally{process.exitCode=1;}};
  const deadline=setTimeout(()=>{void invalid();},state.deadline-Date.now());
  // Finite pre-prompt gate wait even if the host never sends its authorization decision.
  const initialization=setTimeout(()=>{void invalid();},Math.min(15000,state.deadline-Date.now()));
  async function handle(frame:ClaudeFrame){
    if(stopped)throw Error('Bridge stopped');
    if(frame.type==='start'){
      if(started)throw Error('Repeated bridge start');started=true;
      session=createSdkSession({options:frame.options,env:frame.env,cliPath:frame.cliPath,prompt:frame.prompt,
        turnId:state.turnId,resumeSessionId:frame.resumeSessionId,queryFactory:query,send});
      await session.initialized;
      void session.finished.catch(()=>invalid());return;
    }
    if(!session)throw Error('Control before start');
    if(frame.type==='authorize'){session.authorize(frame.authorizationRef);clearTimeout(initialization);return;}
    if(frame.type==='interrupt'){await session.interrupt(frame.sessionId);return;}
    if(frame.type==='close'){await stop();return;}
    throw Error('Invalid controller frame');
  }
  process.stdin.on('data',(bytes:Buffer)=>{
    try{for(const frame of decoder.push(bytes)){
      if(++queued>32)throw Error('Bridge control queue exhausted');
      controls=controls.then(()=>handle(frame)).finally(()=>{queued--;});
      void controls.catch(()=>invalid());
    }}catch{void invalid();}
  });
  process.stdin.on('end',()=>{try{decoder.finish();void stop();}catch{void invalid();}});
  process.stdin.on('error',()=>{void invalid();});
  process.stdout.on('error',()=>{void stop();process.exitCode=1;});
}
void main().catch(()=>{process.stderr.write('Claude bridge startup rejected\n');process.exitCode=1;});
