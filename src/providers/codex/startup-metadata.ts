import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Result } from '../../contracts/common.ts';
import { WindowsDrainEvidenceSchema, WindowsOwnershipReceiptSchema, type OwnedExecution } from '../../contracts/execution.ts';
import { consumeStartupMetadataPlan, startupTargetHash, StartupPhaseSchema, type StartupInput, type StartupMetadataPlan } from '../../qualification/codex-startup-authority.ts';
import { CodexTransport, qualificationMetadataClientName } from './transport.ts';
import { authPresent, chatgptEndpointCategory } from './policy.ts';

const Bool=z.union([z.boolean(),z.literal('MISSING'),z.literal('NULL')]);
const Presence=z.enum(['MISSING','NULL','EMPTY','PRESENT']);
const LoginMethodSet=z.array(z.enum(['chatgpt','api'])).max(2).refine(methods=>new Set(methods).size===methods.length);
const LoginMethods=z.union([z.enum(['MISSING','NULL']),LoginMethodSet]);
const FEATURES=['plugins','hooks','apps','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','remote_control'] as const;
const CATEGORIES=['packagedDefaults','mdm','system','enterpriseManaged','user','project','sessionFlags','legacyManagedConfigTomlFromFile','legacyManagedConfigTomlFromMdm'] as const;
const WATCHED=['features.plugins','features.hooks','features.apps','notify','mcp_servers','model_provider','default_permissions','windows','web_search'] as const;
const FeatureProjection=z.strictObject(Object.fromEntries(FEATURES.map(key=>[key,Bool])) as {[K in typeof FEATURES[number]]:typeof Bool});
const Provenance=z.strictObject({category:z.enum(CATEGORIES),version:z.string().regex(/^(?:[a-f0-9]{64}|v[0-9]{1,9})$/)});
export const StartupProjectionSchema=z.strictObject({schemaVersion:z.literal(1),
  config:FeatureProjection.extend({notify:Presence,mcp:Presence,mcpServers:z.number().int().min(0).max(128),mcpEnabled:z.number().int().min(0).max(128),
    provider:z.enum(['MISSING','NULL','OPENAI','OTHER']),profile:z.enum(['MISSING','NULL','MATCH','OTHER','PRESENT']),sandbox:z.enum(['MISSING','NULL','MXC','OTHER']),webSearch:z.enum(['MISSING','NULL','disabled','cached','live'])}),
  requirements:z.strictObject({state:z.enum(['MISSING','NULL','PRESENT']),allowRemoteControl:Bool,allowBrowserAndComputerUse:Bool,allowManagedHooksOnly:Bool,
    allowAppshots:Bool,allowLoginShell:Bool,features:FeatureProjection,provider:z.enum(['MISSING','NULL','OPENAI','OTHER']),
    profileAllowed:Bool,loginMethods:LoginMethods,supportsIndependentSpeedModes:Bool}),
  provenance:z.record(z.enum(WATCHED),Provenance.optional()),
  managedCompleteness:z.literal('UNKNOWN'),cloudConfigCompleteness:z.literal('UNKNOWN'),reloadSafety:z.literal('UNKNOWN'),
});
export type StartupProjection=z.infer<typeof StartupProjectionSchema>;
function object(value:unknown):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('Invalid metadata');return value as Record<string,unknown>;}
function bounded(value:unknown):void{if(Buffer.byteLength(JSON.stringify(value))>1024*1024)throw Error('Metadata budget');}
function bool(value:Record<string,unknown>,key:string):z.infer<typeof Bool>{return !Object.hasOwn(value,key)?'MISSING':value[key]===null?'NULL':z.boolean().parse(value[key]);}
function presence(value:Record<string,unknown>,key:string):'MISSING'|'NULL'|'PRESENT'{return !Object.hasOwn(value,key)?'MISSING':value[key]===null?'NULL':'PRESENT';}
function optionalObject(value:Record<string,unknown>,key:string):Record<string,unknown>{return value[key]===undefined||value[key]===null?{}:object(value[key]);}
function features(value:Record<string,unknown>){if(Object.keys(value).length>128)throw Error('Feature cardinality');return Object.fromEntries(FEATURES.map(key=>[key,bool(value,key)])) as z.infer<typeof FeatureProjection>;}
function provider(value:Record<string,unknown>,key:string):'MISSING'|'NULL'|'OPENAI'|'OTHER'{if(!Object.hasOwn(value,key))return 'MISSING';if(value[key]===null)return 'NULL';z.string().min(1).max(128).parse(value[key]);return value[key]==='openai'?'OPENAI':'OTHER';}
function source(value:unknown):typeof CATEGORIES[number]{
  const name=object(value);const type=z.enum(CATEGORIES).parse(name.type);
  const allowed:Record<typeof type,string[]>={packagedDefaults:['type','file'],mdm:['type','domain','key'],system:['type','file'],enterpriseManaged:['type','id','name'],user:['type','file','profile'],project:['type','dotCodexFolder'],sessionFlags:['type'],legacyManagedConfigTomlFromFile:['type','file'],legacyManagedConfigTomlFromMdm:['type']};
  if(Object.keys(name).length!==allowed[type].length||Object.keys(name).some(key=>!allowed[type].includes(key)))throw Error('Invalid provenance');
  for(const key of allowed[type])if(key!=='type'&&!(key==='profile'&&name[key]===null))z.string().min(1).max(1024).parse(name[key]);return type;
}
/** Only this dedicated allowlist crosses the raw-provider-data boundary. */
export function projectStartupMetadata(rawConfig:unknown,rawRequirements:unknown,expectedProfile?:string):Result<StartupProjection> {
  try {
    bounded(rawConfig);bounded(rawRequirements);
    const envelope=z.object({config:z.unknown(),origins:z.unknown(),layers:z.null()}).parse(rawConfig);
    const config=object(envelope.config),origins=object(envelope.origins);
    const requirementsEnvelope=z.object({requirements:z.unknown(),supportsIndependentSpeedModes:z.boolean().nullable().optional()}).parse(rawRequirements);
    const req=optionalObject(requirementsEnvelope,'requirements');
    const notify=presence(config,'notify');if(notify==='PRESENT')z.array(z.string().max(4096)).max(128).parse(config.notify);
    const servers=optionalObject(config,'mcp_servers');if(Object.keys(servers).length>128)throw Error('MCP cardinality');let mcpEnabled=0;
    for(const [id,entry] of Object.entries(servers)){if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw Error('Unsupported MCP identifier');const server=object(entry);if(bool(server,'enabled')!==false)mcpEnabled++;}
    const windows=optionalObject(config,'windows');let profile:StartupProjection['config']['profile']=presence(config,'default_permissions');
    if(profile==='PRESENT'){z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).parse(config.default_permissions);profile=expectedProfile?(config.default_permissions===expectedProfile?'MATCH':'OTHER'):'PRESENT';}
    const provenance:Partial<Record<typeof WATCHED[number],z.infer<typeof Provenance>>>={};
    if(Object.keys(origins).length>128)throw Error('Origin cardinality');
    for(const [key,raw] of Object.entries(origins)){const origin=z.object({name:z.unknown(),version:Provenance.shape.version}).parse(raw);const category=source(origin.name);if((WATCHED as readonly string[]).includes(key))provenance[key as typeof WATCHED[number]]={category,version:origin.version};}
    const allowedProfiles=optionalObject(req,'allowedPermissionProfiles');if(Object.keys(allowedProfiles).length>128)throw Error('Profile cardinality');for(const [key,value] of Object.entries(allowedProfiles)){z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).parse(key);z.boolean().parse(value);}
    const loginPresence=presence(req,'allowedLoginMethods');let loginMethods:z.infer<typeof LoginMethods>;
    if(loginPresence==='PRESENT'){const methods=LoginMethodSet.parse(req.allowedLoginMethods);loginMethods=(['chatgpt','api'] as const).filter(method=>methods.includes(method));}else loginMethods=loginPresence;
    const projection=StartupProjectionSchema.parse({schemaVersion:1,config:{...features(optionalObject(config,'features')),
      notify:notify==='PRESENT'&&Array.isArray(config.notify)&&!config.notify.length?'EMPTY':notify,
      mcp:presence(config,'mcp_servers')==='PRESENT'&&Object.keys(servers).length===0?'EMPTY':presence(config,'mcp_servers'),mcpServers:Object.keys(servers).length,mcpEnabled,
      provider:provider(config,'model_provider'),profile,sandbox:!Object.hasOwn(windows,'sandbox')?'MISSING':windows.sandbox===null?'NULL':windows.sandbox==='mxc'?'MXC':'OTHER',
      webSearch:!Object.hasOwn(config,'web_search')?'MISSING':config.web_search===null?'NULL':z.enum(['disabled','cached','live']).parse(config.web_search)},
      requirements:{state:presence(requirementsEnvelope,'requirements'),allowRemoteControl:bool(req,'allowRemoteControl'),allowBrowserAndComputerUse:bool(req,'allowBrowserAndComputerUse'),allowManagedHooksOnly:bool(req,'allowManagedHooksOnly'),
        allowAppshots:bool(req,'allowAppshots'),allowLoginShell:bool(req,'allowLoginShell'),features:features(optionalObject(req,'featureRequirements')),provider:provider(req,'modelProvider'),
        profileAllowed:!Object.hasOwn(req,'allowedPermissionProfiles')?'MISSING':req.allowedPermissionProfiles===null?'NULL':expectedProfile?bool(allowedProfiles,expectedProfile):'MISSING',
        loginMethods,supportsIndependentSpeedModes:bool(requirementsEnvelope,'supportsIndependentSpeedModes')},
      provenance,managedCompleteness:'UNKNOWN',cloudConfigCompleteness:'UNKNOWN',reloadSafety:'UNKNOWN'});
    return {ok:true,value:projection};
  }catch{return {ok:false,error:{code:'INVALID_METADATA_PROJECTION',message:'Metadata projection refused',evidenceIds:[]}};}
}

const AccountProjectionSchema=z.strictObject({mode:z.literal('managed-chatgpt'),state:z.enum(['authenticated','unavailable']),requiresOpenaiAuth:z.boolean()});
export function projectManagedAccount(value:unknown):z.infer<typeof AccountProjectionSchema>{const response=object(value);return {mode:'managed-chatgpt',state:optionalObject(response,'account').type==='chatgpt'&&response.requiresOpenaiAuth===true?'authenticated':'unavailable',requiresOpenaiAuth:z.boolean().parse(response.requiresOpenaiAuth)};}
const FailureCode=z.enum(['NONE','INVALID_INSPECTION_PLAN','STALE_STARTUP_INPUT','INVALID_LIMITS','OWNERSHIP_MISMATCH','METADATA_EXCHANGE_FAILED','METADATA_CONFLICT','DRAIN_INCOMPLETE']);
export const StartupInspectionResultSchema=z.strictObject({schemaVersion:z.literal(1),status:z.enum(['REFUSED','BLOCKED','OBSERVED']),
  code:FailureCode,prelaunchAuthority:z.literal('UNPROVEN'),workerQualification:z.literal('UNQUALIFIED'),shutdown:z.enum(['NOT_ADOPTED','DRAINING','DRAINED']),
  phases:z.array(StartupPhaseSchema).max(8),targetHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requestId:z.uuid().optional(),owner:z.strictObject({runId:z.uuid(),generation:z.number().int().positive(),actionId:z.uuid(),role:z.literal('startup-metadata')}).optional(),
  observations:StartupProjectionSchema.optional(),account:AccountProjectionSchema.optional(),projectionHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  protocol:z.strictObject({framesAdmitted:z.number().int().min(0).max(5),outputBytes:z.number().int().nonnegative(),boundaryFailed:z.boolean()}),
  ownershipMatched:z.boolean(),drainComplete:z.boolean(),limits:z.strictObject({responseMs:z.number(),activeMs:z.number(),graceMs:z.number(),drainMs:z.number(),renewalMs:z.number(),totalMs:z.literal(50000),leaseTtlMs:z.literal(10000)})});
export type StartupInspectionResult=z.infer<typeof StartupInspectionResultSchema>;
type Options={now?:()=>number;responseMs?:number;activeMs?:number;graceMs?:number;drainMs?:number;renewalMs?:number};
function sameOwner(value:{runId:string;generation:number;actionId:string;role:string},input:StartupInput):boolean{return Object.entries(input.owner).every(([key,v])=>value[key as keyof typeof value]===v);}
function matchesOwnership(value:unknown,input:StartupInput,now:number):boolean{const receipt=WindowsOwnershipReceiptSchema.safeParse(value);return receipt.success&&sameOwner(receipt.data,input)&&receipt.data.boundaryHash===input.boundaryHash&&receipt.data.capturedAt>=input.issuedAt&&receipt.data.capturedAt<=now&&Object.entries(input.expectedExecution).every(([key,v])=>receipt.data[key as keyof typeof receipt.data]===v);}
function conflicts(p:StartupProjection):boolean{return FEATURES.some(key=>p.config[key]===true||p.requirements.features[key]===true)||p.config.notify==='PRESENT'||p.config.mcpEnabled>0||p.config.provider==='OTHER'||p.config.profile==='OTHER'||p.config.sandbox==='OTHER'||['live','cached'].includes(p.config.webSearch)||p.requirements.allowRemoteControl===true||p.requirements.allowBrowserAndComputerUse===true||p.requirements.provider==='OTHER'||p.requirements.profileAllowed===false||(Array.isArray(p.requirements.loginMethods)&&!p.requirements.loginMethods.includes('chatgpt'));}
/** Adopts an already-owned execution. A caller must establish actual pre-process
 * authority independently before creating it; this module has no creation API. */
export async function inspectCodexStartupMetadata(plan:StartupMetadataPlan,execution:OwnedExecution,options:Options={}):Promise<StartupInspectionResult> {
  const validOptions=z.strictObject({now:z.custom<()=>number>(v=>typeof v==='function').optional(),responseMs:z.number().int().min(1).max(5000).optional(),activeMs:z.number().int().min(1).max(30000).optional(),graceMs:z.number().int().min(1).max(5000).optional(),drainMs:z.number().int().min(1).max(15000).optional(),renewalMs:z.number().int().min(1).max(2000).optional()}).safeParse(options);
  if(!validOptions.success)return {schemaVersion:1,status:'REFUSED',code:'INVALID_LIMITS',prelaunchAuthority:'UNPROVEN',workerQualification:'UNQUALIFIED',shutdown:'NOT_ADOPTED',phases:['UNAUTHORIZED'],protocol:{framesAdmitted:0,outputBytes:0,boundaryFailed:false},ownershipMatched:false,drainComplete:false,limits:{responseMs:5000,activeMs:30000,graceMs:5000,drainMs:15000,renewalMs:2000,totalMs:50000,leaseTtlMs:10000}};
  options=validOptions.data;
  const limits={responseMs:options.responseMs??5000,activeMs:options.activeMs??30000,graceMs:options.graceMs??5000,drainMs:options.drainMs??15000,renewalMs:options.renewalMs??2000,totalMs:50000 as const,leaseTtlMs:10000 as const};
  const result:StartupInspectionResult={schemaVersion:1,status:'REFUSED',code:'INVALID_INSPECTION_PLAN',prelaunchAuthority:'UNPROVEN',workerQualification:'UNQUALIFIED',shutdown:'NOT_ADOPTED',phases:['UNAUTHORIZED'],protocol:{framesAdmitted:0,outputBytes:0,boundaryFailed:false},ownershipMatched:false,drainComplete:false,limits};
  const max={responseMs:5000,activeMs:30000,graceMs:5000,drainMs:15000,renewalMs:2000};
  if(Object.entries(max).some(([key,limit])=>{const n=limits[key as keyof typeof max];return !Number.isSafeInteger(n)||n<1||n>limit;})){result.code='INVALID_LIMITS';return result;}
  let now:number;try{now=(options.now??Date.now)();}catch{return result;}
  const consumed=consumeStartupMetadataPlan(plan,now);if(!consumed.ok){result.code=consumed.error.code==='STALE_STARTUP_INPUT'?'STALE_STARTUP_INPUT':'INVALID_INSPECTION_PLAN';return result;}
  const input=consumed.value;result.targetHash=input.admittedTargetHash??startupTargetHash(input);result.owner=input.owner;result.requestId=input.requestId;result.status='BLOCKED';result.shutdown='DRAINING';result.phases.push('PREFLIGHT_ACCEPTED');
  const started=performance.now();let rejectFailure!:(error:Error)=>void;const failed=new Promise<never>((_,reject)=>{rejectFailure=reject;});void failed.catch(()=>{});
  let failure=false;const signal=()=>{failure=true;rejectFailure(Error('Metadata exchange stopped'));};
  let transport:CodexTransport|undefined;let offFailure=()=>{};
  let cleanupDeadline:number|undefined;
  async function finite<T>(operation:()=>Promise<T>,ms:number,monitor=true,deadline=Infinity):Promise<T>{let timer:NodeJS.Timeout|undefined;const remaining=Math.min(ms,limits.totalMs-(performance.now()-started),cleanupDeadline===undefined?Infinity:cleanupDeadline-performance.now(),deadline-performance.now());try{if(remaining<=0)throw Error('Inspection deadline');return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Inspection deadline')),remaining);}),...(monitor?[failed]:[])]);}finally{clearTimeout(timer);}}
  let renewalBusy=false;let renewalSequence=0;let renewalTask:Promise<void>|undefined;const renewal=setInterval(()=>{
    if(renewalBusy)return;renewalBusy=true;
    renewalTask=finite(()=>execution.renewLease(++renewalSequence),Math.min(limits.responseMs,limits.renewalMs),false).catch(signal).finally(()=>{renewalBusy=false;});
  },limits.renewalMs);
  const admissionDeadline=Math.min(input.expiresAt,input.admissionDeadline??Infinity);
  const activeTimer=setTimeout(signal,Math.min(limits.activeMs,input.admittedBudget?.activeMs??Infinity,admissionDeadline-now));
  try {
    transport=new CodexTransport(execution,{metadata:{cwd:input.workspace,clientName:qualificationMetadataClientName(input.owner.actionId),admissionDeadline,now:options.now},timeoutMs:limits.responseMs,maxOutputBytes:input.admittedBudget?.outputBytes});
    offFailure=transport.onFailure(signal);const activeTransport=transport;
    if(!matchesOwnership(await finite(()=>execution.describe(),limits.responseMs),input,(options.now??Date.now)())){result.code='OWNERSHIP_MISMATCH';throw Error('Ownership mismatch');}
    result.ownershipMatched=true;result.phases.push('OWNED_PROCESS');
    await finite(()=>activeTransport.initialize(),limits.activeMs);result.phases.push('INITIALIZED');
    result.account=projectManagedAccount(await finite(()=>activeTransport.request('account/read',{refreshToken:false}),limits.responseMs));
    if(result.account.state!=='authenticated'){result.code='METADATA_CONFLICT';throw Error('Managed account unavailable');}
    const rawConfig=await finite(()=>activeTransport.request('config/read',{includeLayers:false,cwd:input.workspace}),limits.responseMs);result.phases.push('CONFIG_OBSERVED');
    const rawRequirements=await finite(()=>activeTransport.request('configRequirements/read',undefined),limits.responseMs);result.phases.push('REQUIREMENTS_OBSERVED');
    const projection=projectStartupMetadata(rawConfig,rawRequirements,input.profile);if(!projection.ok)throw Error('Projection refused');
    result.observations=projection.value;result.projectionHash=createHash('sha256').update(JSON.stringify(projection.value)).digest('hex');
    if(conflicts(projection.value)||authPresent(object(object(rawConfig).config).model_providers)||authPresent(optionalObject(object(rawRequirements),'requirements').modelProviders)||chatgptEndpointCategory(object(object(rawConfig).config).chatgpt_base_url)==='rejected'||chatgptEndpointCategory(optionalObject(object(rawRequirements),'requirements').chatgptBaseUrl)==='rejected'){result.code='METADATA_CONFLICT';throw Error('Metadata conflict');}
    if(failure)throw Error('Metadata boundary failed');result.status='OBSERVED';result.code='NONE';
  }catch{result.status='BLOCKED';if(result.code==='INVALID_INSPECTION_PLAN')result.code='METADATA_EXCHANGE_FAILED';}
  finally {
    const cleanupAvailable=Math.min(input.admittedBudget?.cleanupMs??Infinity,limits.totalMs-(performance.now()-started));
    cleanupDeadline=performance.now()+Math.max(0,cleanupAvailable);
    const preDrainDeadline=cleanupDeadline-Math.min(limits.drainMs,Math.max(1,cleanupAvailable/2));
    clearTimeout(activeTimer);transport?.fence();result.phases.push('FENCED');let fenced=false;
    // The native helper stops accepting controls on drain. Stop future renewals
    // and settle the one bounded in-flight acknowledgment while it still accepts
    // controls; its genuine failure must remain visible in the final result.
    clearInterval(renewal);let cleanupUnresolved=false;
    if(renewalTask)try{await finite(()=>renewalTask!,limits.renewalMs,false,preDrainDeadline);}catch{cleanupUnresolved=true;}
    try{await finite(()=>execution.fence(),limits.graceMs,false,preDrainDeadline);fenced=true;}catch{cleanupUnresolved=true;}
    try {
      // Dispatch exactly one terminal drain even when a prior control or the
      // scheduler consumed its wait allowance. Observe late rejection without
      // claiming that unresolved renewal/fence controls completed successfully.
      const drainRequest=Promise.resolve(execution.drain('Startup metadata inspection terminal'));void drainRequest.catch(()=>{});
      const drain=WindowsDrainEvidenceSchema.safeParse(await finite(()=>drainRequest,limits.drainMs,false));
      const identity=matchesOwnership(await finite(()=>execution.describe(),limits.responseMs,false),input,(options.now??Date.now)());
      if(!transport)throw Error('Output observation unavailable');transport.finish();
      result.drainComplete=!cleanupUnresolved&&fenced&&identity&&drain.success&&sameOwner(drain.data,input)&&drain.data.rootExited&&drain.data.membershipEmpty&&drain.data.activeProcesses===0&&drain.data.unresolvedExecutions.length===0&&drain.data.outputComplete&&drain.data.unresolvedOutputStreams.length===0&&drain.data.requestedAt>=input.issuedAt&&drain.data.completedAt>=drain.data.requestedAt;
      if(result.drainComplete){result.shutdown='DRAINED';result.phases.push('DRAINED');}
    }catch{/* Missing or invalid output/drain evidence remains DRAINING. */}
    if(transport)result.protocol=transport.metadataEvidence();
    if(!result.drainComplete){result.status='BLOCKED';result.code='DRAIN_INCOMPLETE';}
    else if(failure||result.protocol.boundaryFailed){result.status='BLOCKED';if(result.code==='NONE')result.code='METADATA_EXCHANGE_FAILED';}
    offFailure();transport?.stop();
  }
  return StartupInspectionResultSchema.parse(result);
}
