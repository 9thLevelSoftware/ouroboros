// Additive fixed canary executable. Importing this module never performs IO.
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXED_WRITE = 'OUROBOROS_FIXED_WRITE_V1\r\n';
const operations = ['allowed_edit','denied_source_write','denied_controller_write','denied_sibling_write','denied_sensitive_read','allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback','link_escape','broker_escape'];
export function validateFixture(root) {
 if (typeof root !== 'string' || !/^[A-Za-z]:\\[^\\]/.test(root) || root.includes('/') || root.slice(2).includes(':') ||
  root.split('\\').slice(1).some(p => !p || p === '.' || p === '..' || /[. ]$|[<>"|?*\x00-\x1f]/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw Error('Invalid disposable fixture');
}
export function brokerPipe(root, targetHash) { validateFixture(root); if (!/^[a-f0-9]{64}$/.test(targetHash)) throw Error('Invalid target'); return `\\\\.\\pipe\\ouroboros-boundary-${createHash('sha256').update(`${root}\n${targetHash}`).digest('hex').slice(0,24)}`; }
export function validateNetworkPlan(p){
 if(!p||p.schemaVersion!==1||Object.keys(p).sort().join()!=='directTcp,proxy,schemaVersion'||!p.proxy||!p.directTcp||Object.keys(p.proxy).sort().join()!=='policyHash,provenanceHash,source,url'||Object.keys(p.directTcp).sort().join()!=='host,port'||p.proxy.source!=='documented-sandbox-managed'||!/^[a-f0-9]{64}$/.test(p.proxy.policyHash)||!/^[a-f0-9]{64}$/.test(p.proxy.provenanceHash))throw Error('Approved network plan required');
 const u=new URL(p.proxy.url),o=p.directTcp.host?.split('.');
 if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!o||o.length!==4||o.some(v=>!/^\d{1,3}$/.test(v)||String(Number(v))!==v||Number(v)>255)||Number(o[0])===0||Number(o[0])===127||Number(o[0])>=224||(o[0]==='169'&&o[1]==='254')||!Number.isInteger(p.directTcp.port)||p.directTcp.port<1||p.directTcp.port>65535)throw Error('Distinct approved network endpoints required');
}
export function networkPlanHash(plan){const canonical=v=>v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,canonical(value)])):v;return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');}
function validate(r) {
 validateFixture(r.fixtureRoot);
 if (!['worker','verifier'].includes(r.role) || typeof r.executionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.executionId) ||
  !operations.includes(r.operation) || !/^[a-f0-9]{64}$/.test(r.targetHash) ||
  r.operationId !== `${r.role}.${r.operation === 'allowed_edit' && r.role === 'verifier' ? 'allowed_command' : r.operation}`) throw Error('Invalid fixed operation identity');
 if(['allowed_proxy_network','denied_network','denied_direct_tcp','denied_loopback'].includes(r.operation))validateNetworkPlan(r.networkPlan);
 else if(r.networkPlan)validateNetworkPlan(r.networkPlan);
}
const codeOf = e => typeof e?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code) ? e.code : 'UNKNOWN';
function outcome(r, origin, effect, extra = {}) { return { role:r.role,executionId:r.executionId,operationId:r.operationId,attempted:true,effect,origin,...extra }; }
function failure(r, origin, error, enforce = true) { const code = codeOf(error); return outcome(r,origin,enforce && ['EACCES','EPERM'].includes(code) ? 'blocked':'error',{code,...(r.operation === 'denied_sensitive_read' ? {sensitiveBytesRead:false}: {})}); }
async function socketAttempt(r, io, broker) {
 return new Promise(resolve => {
  let settled=false, connected=false, captured=''; let socket; let timer;
  const finish = result => { if(settled)return;settled=true;io.clearTimeout(timer);socket?.destroy();resolve(result); };
  timer=io.setTimeout(()=>finish(failure(r,broker?'broker':r.operation==='denied_direct_tcp'?'network-tcp':'network-loopback',{code:'ETIMEDOUT'},false)),2000);
  const origin=broker?'broker':r.operation==='denied_direct_tcp'?'network-tcp':'network-loopback';
  try {
   socket=io.net.connect(broker?{path:brokerPipe(r.fixtureRoot,r.targetHash)}:r.operation==='denied_direct_tcp'?{host:r.networkPlan.directTcp.host,port:r.networkPlan.directTcp.port}:{host:'127.0.0.1',port:18472});
   socket.on('error',error=>finish(failure(r,origin,error,!connected)));
   socket.on('connect',()=>{connected=true;if(!broker)finish(outcome(r,origin,'allowed'));else socket.write('{"schemaVersion":1,"operation":"write_source_sentinel"}\n');});
   socket.on('data',data=>{captured+=data.toString('utf8');if(captured.length>4096)finish(failure(r,origin,{code:'OUTPUT_LIMIT'},false));});
   socket.on('end',()=>{if(settled)return;try{const value=JSON.parse(captured);finish(value.kind==='broker-result'&&value.mutated===true?outcome(r,origin,'allowed'):failure(r,'tool',{code:'BROKER_NO_MUTATION'},false));}catch{finish(failure(r,'tool',{code:'BROKER_INVALID_RESPONSE'},false));}});
  }catch(error){finish(failure(r,origin,error,!connected));}
 });
}
async function proxyAttempt(r,io) {
 let matched=false;try{matched=typeof io.proxyEnvironment==='string'&&new URL(io.proxyEnvironment).href===new URL(r.networkPlan.proxy.url).href;}catch{}
 if(!matched)return {...outcome(r,'tool','refused',{code:'RUNTIME_PROXY_MISMATCH'}),attempted:false};
 const provenance={runtimeProxyMatched:true,proxyProvenanceHash:r.networkPlan.proxy.provenanceHash,proxyPolicyHash:r.networkPlan.proxy.policyHash};
 return new Promise(resolve=>{
  let settled=false,request,timer;
  const finish=result=>{if(settled)return;settled=true;io.clearTimeout(timer);request?.destroy();resolve(result);};
  timer=io.setTimeout(()=>finish(failure(r,'network-proxy',{code:'ETIMEDOUT'},false)),2000);
  try {
   const target=r.operation==='allowed_proxy_network'?'http://localhost:18471/allowed':'http://127.0.0.1:18472/denied';
   const proxy=new URL(r.networkPlan.proxy.url);
   request=io.http.request({hostname:proxy.hostname.replace(/^\[|\]$/g,''),port:Number(proxy.port),path:target,method:'GET',headers:{host:new URL(target).host},agent:false},response=>{
    let bytes='';response.on('error',error=>finish(failure(r,'network-proxy',error,false)));
    response.on('data',chunk=>{bytes+=chunk.toString('utf8');if(bytes.length>4096)finish(failure(r,'network-proxy',{code:'OUTPUT_LIMIT'},false));});
    response.on('end',()=>{const proxyError=response.headers?.['x-proxy-error'];const documented=response.statusCode===403&&['blocked-by-allowlist','blocked-by-denylist','blocked-by-method-policy','blocked-by-policy'].includes(proxyError);
     finish(documented?outcome(r,'network-proxy','blocked',{...provenance,code:'HTTP_PROXY_DENIED',proxyError}):response.statusCode===200&&bytes==='OUROBOROS_ENDPOINT_V1'?outcome(r,'network-proxy','allowed',{...provenance,data:bytes}):failure(r,'network-proxy',{code:'HTTP_RESPONSE_UNPROVEN'},false));});
   });
   request.on('error',error=>finish(failure(r,'network-proxy',error)));request.end();
  }catch(error){finish(failure(r,'network-proxy',error));}
 });
}
export async function runCampaignBoundaryOperation(request, io) {
 validate(request);const r=Object.freeze(structuredClone(request));
 if (r.operation==='allowed_proxy_network'||r.operation==='denied_network') return proxyAttempt(r,io);
 if (r.operation==='denied_direct_tcp'||r.operation==='denied_loopback'||r.operation==='broker_escape') return socketAttempt(r,io,r.operation==='broker_escape');
 const root=r.operation==='denied_source_write'?'source':r.operation==='denied_controller_write'?'controller-sentinel':r.operation==='denied_sibling_write'?'sibling':r.operation==='denied_sensitive_read'?'fake-credential':'workspace';
 const path=win32.join(r.fixtureRoot,root,root==='workspace'?'allowed.txt':'sentinel.txt');
 if(r.operation==='link_escape') {
  const link=win32.join(r.fixtureRoot,'workspace',`escape-link-${r.role}`);
  // The trusted, separately charged preparer created this directory junction.
  // This operation tests traversal enforcement, not link-creation privileges.
  try{await io.fs.writeFile(win32.join(link,'sentinel.txt'),FIXED_WRITE);return outcome(r,'filesystem','allowed');}catch(error){return failure(r,'filesystem',error);}
 }
 try {
  if(r.operation==='denied_sensitive_read'){await io.fs.readFile(path);return outcome(r,'filesystem','allowed',{sensitiveBytesRead:true});}
  await io.fs.writeFile(path,FIXED_WRITE);
  if(r.operation==='allowed_edit') {
   let readback;
   try{const bytes=await io.fs.readFile(path);readback={...outcome(r,'filesystem','allowed',{data:bytes.toString()===FIXED_WRITE?FIXED_WRITE:'MISMATCH'}),operationId:`${r.operationId}.readback`};}
   catch(error){readback={...failure(r,'filesystem',error),operationId:`${r.operationId}.readback`};}
   return {...outcome(r,'filesystem','allowed'),readback};
  }
  return outcome(r,'filesystem','allowed');
 }catch(error){return failure(r,'filesystem',error);}
}
export async function main(argv,io,emit,stdin) {
 if(![6,7,8,9].includes(argv.length))throw Error('Exactly fixed driver arguments required');
 const [role,executionId,operationId,operation,fixtureRoot,targetHash]=argv;
 const hasPlan=argv.length===7||argv.length===9;const request={role,executionId,operationId,operation,fixtureRoot,targetHash,...(hasPlan?{networkPlan:JSON.parse(argv[6])}:{})};validate(request);
 if(argv.length===8||argv.length===9) {
  const offset=hasPlan?7:6;if(argv[offset]!=='--channel'||!/^[a-f0-9]{64}$/.test(argv[offset+1])||!stdin)throw Error('Invalid fixed channel');
  emit(JSON.stringify({kind:'fixed-resource-ready',schemaVersion:1,executionId,resourceHash:argv[offset+1]})+'\n');
  await new Promise((resolve,reject)=>{let text='';let done=false;stdin.on('data',chunk=>{if(done)return;text+=chunk.toString('utf8');if(text.length>32){done=true;reject(Error('Channel command limit'));}else if(text.includes('\n')){done=true;text==='execute\n'?resolve():reject(Error('Fixed execute only'));}});stdin.on('end',()=>{if(!done){done=true;reject(Error('Channel closed before execution'));}});stdin.on('error',reject);});
 }
 const result=await runCampaignBoundaryOperation(request,io);
 emit(JSON.stringify({kind:'boundary-operation',schemaVersion:1,...result})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 main(process.argv.slice(2),{fs,http,net,setTimeout,clearTimeout,proxyEnvironment:process.env.HTTP_PROXY},line=>process.stdout.write(line),process.stdin).catch(()=>{process.stderr.write('FIXED_DRIVER_INVALID\n');process.exitCode=17;});
}
