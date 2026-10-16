import { posix } from 'node:path';
import { z } from 'zod';
import type { Result } from '../../contracts/common.ts';
import { ExecutionOwnerSchema, ExecutionAuthorizationSchema } from '../../contracts/execution.ts';
import { BoundaryProfileSchema } from '../../runtime/command-boundary.ts';
import type { ProviderStart } from '../provider.ts';

const text=z.string().min(1).max(4096).refine(s=>!/[\0\r\n]/.test(s));
const path=text.refine(s=>posix.isAbsolute(s)&&!s.includes('\\')&&!s.split('/').some(p=>p==='.'||p==='..')&&!/[*?\[\]{}!]/.test(s));
const paths=z.array(path).max(64);
const domains=z.array(text).max(64);
export const ClaudeOptionsSchema=z.strictObject({
  cwd:path,model:text,effort:z.enum(['low','medium','high','max']),tools:z.tuple([z.literal('Bash')]),
  settingSources:z.tuple([]),skills:z.tuple([]),plugins:z.tuple([]),strictMcpConfig:z.literal(true),mcpServers:z.strictObject({}),
  settings:z.strictObject({sandbox:z.strictObject({enabled:z.literal(true),failIfUnavailable:z.literal(true),
    allowUnsandboxedCommands:z.literal(false),autoAllowBashIfSandboxed:z.literal(false),excludedCommands:z.tuple([]),
    filesystem:z.strictObject({denyRead:z.tuple([z.literal('/')]),allowRead:paths,allowWrite:paths,denyWrite:paths,disabled:z.literal(false)}),
    network:z.strictObject({allowedDomains:domains,deniedDomains:domains,strictAllowlist:z.literal(true),
      allowAllUnixSockets:z.literal(false),allowUnixSockets:z.tuple([]),allowLocalBinding:z.literal(false)})})})
});
export type ClaudeOptionsProjection=z.infer<typeof ClaudeOptionsSchema>;
const artifact=z.strictObject({id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const ClaudeStartSchema=z.strictObject({owner:ExecutionOwnerSchema,actionId:z.uuid(),workspaceRoot:path,promptRef:artifact,
  contextRefs:z.array(artifact).max(32),model:text,effort:text,mode:z.enum(['IMPLEMENT','REFLECT']),
  authorization:ExecutionAuthorizationSchema,boundary:BoundaryProfileSchema.or(BoundaryProfileSchema.omit({qualification:true}))});
export const contains=(value:string,root:string)=>value===root||value.startsWith(root.endsWith('/')?root:`${root}/`);
export const sameOwner=(a:{runId:string;generation:number;actionId:string;role:string},b:typeof a)=>
  a.runId===b.runId&&a.generation===b.generation&&a.actionId===b.actionId&&a.role===b.role;
function failure<T>(code:string):Result<T>{return {ok:false,error:{code,message:'Claude explicit boundary validation failed',evidenceIds:[]}};}
/** This projection expresses controls; it never creates qualification or startup authority. */
export function createClaudeOptions(input:ProviderStart):Result<ClaudeOptionsProjection>{
  const parsed=ClaudeStartSchema.safeParse(input);if(!parsed.success)return failure('INVALID_PROVIDER_START');
  const i=parsed.data,b=i.boundary;
  if(i.mode!=='IMPLEMENT'||b.platform!=='wsl2'||!sameOwner(i.owner,b)||i.actionId!==i.owner.actionId||
      b.deadline<=Date.now()||b.leaseTtlMs!==10000||b.verifier.version!=='0.0.79')return failure('CAPABILITY_UNAVAILABLE');
  const all=[...b.readRoots,...b.writeRoots,...b.deniedSensitiveRoots];
  if(!paths.safeParse(b.readRoots).success||!paths.safeParse(b.writeRoots).success||!paths.safeParse(b.deniedSensitiveRoots).success||
      !b.readRoots.some(root=>contains(i.workspaceRoot,root))||!b.writeRoots.some(root=>contains(i.workspaceRoot,root))||
      b.deniedSensitiveRoots.some(root=>contains(i.workspaceRoot,root))||
      b.readRoots.some(read=>b.deniedSensitiveRoots.some(denied=>contains(read,denied)||contains(denied,read)))||
      b.writeRoots.some(write=>!b.readRoots.some(read=>contains(write,read)))||
      !b.deniedSensitiveRoots.some(root=>contains('/sys/fs/cgroup',root))||!b.deniedSensitiveRoots.some(root=>root==='/run')||
      all.some(s=>Buffer.byteLength(s)>4096))return failure('CAPABILITY_UNAVAILABLE');
  const knownQualification='qualification' in b?b.qualification:undefined;
  if(knownQualification&&(!knownQualification.seccompUnixSockets||!knownQualification.inheritedDescriptorsRestricted))return failure('CAPABILITY_UNAVAILABLE');
  if(i.authorization.kind==='qualified'){
    const q=knownQualification;if(!q||q.environment!=='wsl2'||q.qualificationRef!==i.authorization.qualificationRef||
      !q.seccompUnixSockets||!q.inheritedDescriptorsRestricted||q.runtimeVersion!==b.verifier.version||q.runtimeHash!==b.verifier.sha256)
      return failure('EXECUTION_NOT_AUTHORIZED');
  }else{const fixtures=i.authorization.fixtureRoots;
    if(!fixtures.every(root=>path.safeParse(root).success)||[...b.readRoots,...b.writeRoots].some(root=>!fixtures.some(fixture=>contains(root,fixture))))return failure('EXECUTION_NOT_AUTHORIZED');}
  const result=ClaudeOptionsSchema.safeParse({cwd:i.workspaceRoot,model:i.model,effort:i.effort,tools:['Bash'],settingSources:[],skills:[],plugins:[],strictMcpConfig:true,mcpServers:{},
    settings:{sandbox:{enabled:true,failIfUnavailable:true,allowUnsandboxedCommands:false,autoAllowBashIfSandboxed:false,excludedCommands:[],
      filesystem:{denyRead:['/'],allowRead:b.readRoots,allowWrite:b.writeRoots,denyWrite:b.deniedSensitiveRoots,disabled:false},
      network:{...b.network,strictAllowlist:true,allowAllUnixSockets:false,allowUnixSockets:[],allowLocalBinding:false}}}});
  return result.success?{ok:true,value:result.data}:failure('CAPABILITY_UNAVAILABLE');
}
const environment=z.strictObject({PATH:text,HOME:path,LANG:text.optional(),LC_ALL:text.optional(),TMPDIR:path.optional(),
  CLAUDE_CODE_DISABLE_AUTO_MEMORY:z.literal('1').optional(),ENABLE_CLAUDEAI_MCP_SERVERS:z.literal('false').optional()});
/** The input is explicit controller data, never process.env. Key presence, even empty, fails. */
export function projectEnvironment(input:Record<string,string>):Result<Record<string,string>>{
  const parsed=environment.safeParse(input);if(!parsed.success)return failure('SUBSCRIPTION_SOURCE_UNSAFE');
  return {ok:true,value:{...parsed.data,CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'false'}};
}
const bash=z.strictObject({command:z.string().min(1).max(65536).refine(s=>!s.includes('\0')),
  timeout:z.number().int().positive().max(300000).optional(),description:z.string().max(4096).optional(),run_in_background:z.boolean().optional()});
const toolHook=z.strictObject({hook_event_name:z.literal('PreToolUse'),session_id:text,transcript_path:path,cwd:path,
  prompt_id:z.uuid().optional(),permission_mode:z.literal('dontAsk').optional(),effort:z.strictObject({level:text}).optional(),
  tool_name:z.literal('Bash'),tool_use_id:text,tool_input:bash});
export function validBashInput(input:unknown){try{return bash.safeParse(input).success;}catch{return false;}}
/** Global matcher + strict Bash schema deny unknown nested/bypass fields without interpreting them. */
export async function preToolGate(input:unknown){
  let allowed=false;
  try{allowed=toolHook.safeParse(input).success;}catch{/* Hook defects always deny. */}
  return {hookSpecificOutput:{hookEventName:'PreToolUse' as const,permissionDecision:allowed?'allow' as const:'deny' as const,
    permissionDecisionReason:allowed?'Qualified Bash boundary required':'Tool boundary denied'}};
}
