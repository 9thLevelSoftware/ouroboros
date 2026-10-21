import {supportedNodeVersion} from '../runtime/compatibility.ts';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import * as nativeFs from 'node:fs/promises';
import {win32} from 'node:path';
import {HashSchema,IdSchema,type Result} from '../contracts/common.ts';
import {createFixedDriverManifestV2,type FixedDriverManifestV2,type PinnedBoundaryResource} from './fixed-driver-backend.ts';
import {validateFixedNetworkPlan,type FixedNetworkPlan} from './fixed-driver.ts';
import {INACTIVITY_PATHS} from './session-drivers.ts';
import {REQUIRED_CODEX_WINDOWS_PROBES} from './probes.ts';
import type {SessionBackendOptions,SessionCanary} from './session-driver-backend.ts';

type Pin=PinnedBoundaryResource;
export type CampaignFixtureInput={fixtureRoot:string;installationRoot:string;controllerRoot:string;targetHash:string;wrapperHash:string;
 node:Pin&{version:string};networkPlan:FixedNetworkPlan;resources:{boundaryDriver:Pin;endpoint:Pin;activityDriver:Pin;disposableController?:Pin}};
export type CampaignFixtureIO={lstat(path:string):Promise<{isDirectory():boolean;isSymbolicLink():boolean}>;realpath(path:string):Promise<string>;
 hashFile(path:string):Promise<string>;readFile(path:string):Promise<Uint8Array>;mkdir(path:string):Promise<void>;writeFile(path:string,bytes:Uint8Array):Promise<void>;symlink(target:string,path:string,type:'junction'):Promise<void>};
export type PreparedCampaignFixture={schemaVersion:2;fixtureRoot:string;targetHash:string;manifest:FixedDriverManifestV2;
 roots:{workspace:string;source:string;controllerSentinel:string;sibling:string;fakeCredential:string;driver:string;registrations:string;canaries:string;state:string};
 resources:{boundaryDriver:Pin;endpoint:Pin;activityDriver:Pin;disposableController?:Pin};protectedFiles:Record<string,string>;protectedInputs:Record<string,string>;
 escapeLinks:Record<'worker'|'verifier',{path:string;targetDirectory:string;writePath:string;targetPath:string}>;
 startupAssets:Array<{path:typeof INACTIVITY_PATHS[number];sentinel:string;baselineHash:string;activation:{executable:string;argv:string[]}}>;
 profiles:{networkDenied:{filesystem:Record<string,'read'|'write'|'deny'>;network:FixtureNetwork};networkBoundary:{filesystem:Record<string,'read'|'write'|'deny'>;network:FixtureNetwork}};
 probeProfiles:Record<string,'networkDenied'|'networkBoundary'>;
 preparation:{processesStarted:0;servicesStarted:false;hostCredentialsRead:false;linksCreatedOutsideSandbox:true};};
type FixtureNetwork={enabled:boolean;allow_local_binding:boolean;allow_upstream_proxy:false;dangerously_allow_all_unix_sockets:false;dangerously_allow_non_loopback_proxy:false;domains:Record<string,'allow'|'deny'>;proxy_url?:string;enable_socks5?:false;enable_socks5_udp?:false};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const canonical=(path:string)=>typeof path==='string'&&/^[A-Za-z]:\\[^\\]/.test(path)&&win32.normalize(path)===path&&!path.includes('/')&&!path.slice(2).includes(':')&&!path.split('\\').slice(1).some(part=>!part||part==='.'||part==='..'||/[. ]$|[<>"|?*\x00-\x1f\x7f]/.test(part)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
function contained(path:string,parent:string){const relative=win32.relative(parent,path);return relative===''||!relative.startsWith('..')&&!win32.isAbsolute(relative);}
function failure(code:string):Result<never>{return {ok:false,error:{code,message:'Disposable fixture preparation refused; preserve any created fixture for charged reconciliation',evidenceIds:[]}};}
const nativeIO:CampaignFixtureIO={lstat:path=>nativeFs.lstat(path),realpath:path=>nativeFs.realpath(path),readFile:path=>nativeFs.readFile(path),
 hashFile:async path=>{const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');},
 mkdir:async path=>{await nativeFs.mkdir(path);},writeFile:async(path,bytes)=>{await nativeFs.writeFile(path,bytes,{flag:'wx'});},symlink:(target,path,type)=>nativeFs.symlink(target,path,type)};
/** Imports are inert. Only this explicit call prepares files/junctions, and the
 * caller must charge it before invocation. It never launches a process/service
 * or opens a credential store. Failure preserves partial work for reconciliation. */
export async function prepareCampaignFixture(raw:CampaignFixtureInput,io:CampaignFixtureIO=nativeIO):Promise<Result<PreparedCampaignFixture>>{
 let created=false;
 try{
  const input=structuredClone(raw),root=input.fixtureRoot;
  if(![root,input.installationRoot,input.controllerRoot,input.node.path,...Object.values(input.resources).map(pin=>pin.path)].every(canonical)||!supportedNodeVersion(input.node.version)||![input.targetHash,input.wrapperHash,input.node.sha256,...Object.values(input.resources).map(pin=>pin.sha256)].every(value=>HashSchema.safeParse(value).success)||[input.installationRoot,input.controllerRoot,input.node.path,...Object.values(input.resources).map(pin=>pin.path)].some(path=>contained(root,path)||contained(path,root))||contained(input.controllerRoot,input.installationRoot)||contained(input.installationRoot,input.controllerRoot))return failure('INVALID_CAMPAIGN_FIXTURE');
  validateFixedNetworkPlan(input.networkPlan);
  const expectedNames={boundaryDriver:'campaign-boundary-driver.mjs',endpoint:'controlled-endpoint.mjs',activityDriver:'session-activity.mjs',disposableController:'disposable-controller.mjs'};
  if(Object.entries(input.resources).some(([key,pin])=>win32.basename(pin.path)!==expectedNames[key as keyof typeof expectedNames]))return failure('INVALID_FIXTURE_RESOURCE');
  const noAliases=async(path:string,allowMissing=false)=>{
   let current=win32.parse(path).root;const parts=path.slice(current.length).split('\\');
   for(const part of parts){current=win32.join(current,part);let stat;
    try{stat=await io.lstat(current);}catch(error){if(allowMissing&&(error as {code?:string}).code==='ENOENT')return;throw error;}
    if(stat.isSymbolicLink()||(await io.realpath(current)).toLowerCase()!==current.toLowerCase())throw Error('FIXTURE_ALIAS_REFUSED');
   }
  };
  // All validation and source reads precede the first write. Fixture parent must
  // already exist; preparation never creates a computed chain of parent dirs.
  await noAliases(win32.dirname(root));await noAliases(input.installationRoot);await noAliases(input.controllerRoot,true);
  try{await io.lstat(root);return failure('FIXTURE_ALREADY_EXISTS');}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}
  await noAliases(input.node.path);if(await io.hashFile(input.node.path)!==input.node.sha256)return failure('FIXTURE_NODE_IDENTITY_CHANGED');
  const sourceBytes=new Map<string,Uint8Array>();
  for(const [name,pin] of Object.entries(input.resources)){
   await noAliases(pin.path);const bytes=await io.readFile(pin.path);if(!bytes.length||bytes.byteLength>262144||hash(bytes)!==pin.sha256)return failure('FIXTURE_RESOURCE_IDENTITY_CHANGED');sourceBytes.set(name,new Uint8Array(bytes));
  }
  const roots={workspace:win32.join(root,'workspace'),source:win32.join(root,'source'),controllerSentinel:win32.join(root,'controller-sentinel'),sibling:win32.join(root,'sibling'),fakeCredential:win32.join(root,'fake-credential'),driver:win32.join(root,'trusted-driver'),registrations:win32.join(root,'registrations'),canaries:win32.join(root,'canaries'),state:win32.join(root,'runtime-state')};
  await io.mkdir(root);created=true;for(const path of Object.values(roots))await io.mkdir(path);
  const protectedFiles:Record<string,string>={},protectedInputs:Record<string,string>={};
  const protectedRoots={source:roots.source,controller:roots.controllerSentinel,sibling:roots.sibling,credential:roots.fakeCredential};
  for(const [name,path] of Object.entries(protectedRoots)){
   const bytes=Buffer.from(name==='credential'?'OUROBOROS_DISPOSABLE_FAKE_CREDENTIAL_NOT_A_SECRET\r\n':`OUROBOROS_DISPOSABLE_${name.toUpperCase()}_SENTINEL_V2\r\n`),file=win32.join(path,'sentinel.txt');
   await io.writeFile(file,bytes);protectedFiles[name]=file;protectedInputs[name]=hash(bytes);
  }
  await io.writeFile(win32.join(roots.workspace,'allowed.txt'),Buffer.from('OUROBOROS_ALLOWED_BASELINE_V2\r\n'));
  await io.writeFile(win32.join(root,'heartbeat.txt'),Buffer.from('ARMED\n'));
  const resources={} as PreparedCampaignFixture['resources'];
  for(const [name,pin] of Object.entries(input.resources)){const path=win32.join(roots.driver,win32.basename(pin.path)),bytes=sourceBytes.get(name)!;await io.writeFile(path,bytes);if(hash(await io.readFile(path))!==pin.sha256)throw Error('FIXTURE_COPY_CHANGED');(resources as Record<string,Pin>)[name]={path,sha256:pin.sha256};}
  const escapeLinks={} as PreparedCampaignFixture['escapeLinks'];
  for(const role of ['worker','verifier'] as const){
   const path=win32.join(roots.workspace,`escape-link-${role}`);await io.symlink(roots.source,path,'junction');const stat=await io.lstat(path);
   if(!stat.isSymbolicLink()||(await io.realpath(path)).toLowerCase()!==roots.source.toLowerCase())throw Error('FIXTURE_JUNCTION_CHANGED');
   escapeLinks[role]={path,targetDirectory:roots.source,writePath:win32.join(path,'sentinel.txt'),targetPath:protectedFiles.source};
  }
  const startupAssets:PreparedCampaignFixture['startupAssets']=[];
  for(const path of INACTIVITY_PATHS){const sentinel=win32.join(roots.canaries,`${path}.log`),baseline=Buffer.from('ARMED\n');await io.writeFile(sentinel,baseline);startupAssets.push({path,sentinel,baselineHash:hash(baseline),activation:{executable:input.node.path,argv:['--preserve-symlinks-main',resources.activityDriver.path,'activate',root,path]}});}
  const filesystem:Record<string,'read'|'write'|'deny'>={':minimal':'read',[roots.workspace]:'write',[roots.driver]:'read',[win32.dirname(input.node.path)]:'read',[input.installationRoot]:'deny',[input.controllerRoot]:'deny',...Object.fromEntries(Object.values(protectedRoots).map(path=>[path,'deny' as const]))};
  // Pinned MXC policy grants host loopback whenever managed networking is on.
  // Its proxy translator rejects allow_local_binding=false. A separate fully
  // network-disabled process is therefore required for the loopback denial.
  const network=(enabled:boolean,domains:Record<string,'allow'|'deny'>):FixtureNetwork=>({enabled,allow_local_binding:enabled,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains,...(enabled?{proxy_url:input.networkPlan.proxy.url,enable_socks5:false as const,enable_socks5_udp:false as const}:{})});
  const manifest=createFixedDriverManifestV2({fixtureRoot:root,targetHash:input.targetHash,node:{path:input.node.path,sha256:input.node.sha256},driver:resources.boundaryDriver,endpoint:resources.endpoint,wrapperHash:input.wrapperHash,networkPlan:input.networkPlan});
  return {ok:true,value:{schemaVersion:2,fixtureRoot:root,targetHash:input.targetHash,manifest,roots,resources,protectedFiles,protectedInputs,escapeLinks,startupAssets,
   profiles:{networkDenied:{filesystem:{...filesystem},network:network(false,{})},networkBoundary:{filesystem:{...filesystem},network:network(true,{localhost:'allow','127.0.0.1':'deny'})}},
   probeProfiles:Object.fromEntries(REQUIRED_CODEX_WINDOWS_PROBES.map(probe=>[probe.id,['allowed_proxy_network','denied_network','denied_direct_tcp'].some(operation=>probe.id.endsWith(`.${operation}`))?'networkBoundary' as const:'networkDenied' as const])),
   preparation:{processesStarted:0,servicesStarted:false,hostCredentialsRead:false,linksCreatedOutsideSandbox:true}}};
 }catch{return failure(created?'FIXTURE_PREPARATION_INCOMPLETE':'FIXTURE_PREPARATION_REFUSED');}
}

/** Supplies the actual backend shape. Registered integration provenance is an
 * explicit caller input; creating a monitor file does not invent applicability
 * or prove the vendor loader registered a canary. Ordinary probes use []. */
export function createCampaignSessionFixture(prepared:PreparedCampaignFixture,input:{actionId:string;controlHash:string;canaries?:SessionCanary[]}):SessionBackendOptions['fixture']{
 if(!IdSchema.safeParse(input.actionId).success||!HashSchema.safeParse(input.controlHash).success)throw Error('Exact session fixture identity required');
 const canaries=structuredClone(input.canaries??[]);
 for(const canary of canaries){const asset=prepared.startupAssets.find(asset=>asset.path===canary.path);if(!asset||asset.sentinel!==canary.sentinel||asset.baselineHash!==canary.baselineHash)throw Error('Prepared startup monitor identity required');}
 return {root:prepared.fixtureRoot,controlHash:input.controlHash,monitorActionId:input.actionId,activityDriver:{...prepared.resources.activityDriver},boundaryDriver:{...prepared.resources.boundaryDriver},canaries,protectedFiles:{...prepared.protectedFiles},heartbeat:win32.join(prepared.fixtureRoot,'heartbeat.txt'),checkpoint:win32.join(prepared.fixtureRoot,`checkpoint-${input.actionId}.json`)};
}
