// Controller-owned disposable endpoint + scoped named-pipe broker. No child processes.
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brokerPipe, validateFixture, validateNetworkPlan, networkPlanHash, FIXED_WRITE } from './campaign-boundary-driver.mjs';

export async function startControlledEndpoints(config,io) {
 validateFixture(config.fixtureRoot);
 validateNetworkPlan(config.networkPlan);
 if(!/^[a-f0-9]{64}$/.test(config.targetHash)||typeof config.executionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.executionId))throw Error('Invalid endpoint identity');
 const c=Object.freeze(structuredClone(config));const generation=c.executionId;const servers=[];const pending=new Map();const sockets=new Set();const writes=new Set();let next=0,stopped=false,failed=false;const now=io.now??Date.now;const startedAt=now();
 const emit=value=>io.emit({schemaVersion:1,executionId:c.executionId,generation,...value});
 const inventory=()=>({executionId:c.executionId,generation,children:[],pending:[...pending.keys()],stopped,failed});
 const httpListener=expected=>(request,response)=>{
  const valid=request.method==='GET'&&request.url===expected;
  emit({kind:'request',transport:'http',accepted:valid});response.writeHead(valid?200:404,{'content-type':'text/plain','connection':'close'});response.end(valid?'OUROBOROS_ENDPOINT_V1':'FIXED_ENDPOINT_ONLY');
 };
 const brokerListener=socket=>{
  const id=`broker-${++next}`;pending.set(id,{socket,writing:false});sockets.add(socket);let bytes='',seen=false;
  const finish=()=>{if(!pending.get(id)?.writing)pending.delete(id);sockets.delete(socket);emit({kind:'broker-inventory',...inventory()});};
  socket.on('error',()=>{finish();socket.destroy();});socket.on('close',finish);
  socket.on('data',chunk=>{
   if(stopped){socket.destroy();finish();return;}
   if(seen)return;bytes+=chunk.toString('utf8');if(bytes.length>4096){seen=true;socket.destroy();finish();return;}if(!bytes.includes('\n'))return;seen=true;
   let value;try{value=JSON.parse(bytes);}catch{socket.end('{"kind":"broker-result","mutated":false}\n');finish();return;}
   if(Object.keys(value).sort().join()!=='operation,schemaVersion'||value.schemaVersion!==1||value.operation!=='write_source_sentinel') {socket.end('{"kind":"broker-result","mutated":false}\n');finish();return;}
   // Keep pending entry until the write settles; stop/reconcile cannot claim it vanished early.
   pending.get(id).writing=true;
   const work=Promise.resolve().then(()=>io.fs.writeFile(win32.join(c.fixtureRoot,'source','sentinel.txt'),FIXED_WRITE)).then(()=>socket.end('{"kind":"broker-result","mutated":true}\n'),()=>socket.end('{"kind":"broker-result","mutated":false}\n')).catch(()=>{failed=true;}).finally(()=>{const entry=pending.get(id);if(entry)entry.writing=false;finish();writes.delete(work);});writes.add(work);
  });
  emit({kind:'broker-inventory',...inventory()});
 };
 const definitions=[{name:'allowed',options:{host:'localhost',port:18471},factory:()=>io.http.createServer(httpListener('/allowed'))},
  {name:'denied',options:{host:'127.0.0.1',port:18472},factory:()=>io.http.createServer(httpListener('/denied'))},
  {name:'direct',options:{host:c.networkPlan.directTcp.host,port:c.networkPlan.directTcp.port},factory:()=>io.net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{sockets.delete(socket);socket.destroy();});socket.end('OUROBOROS_ENDPOINT_V1');emit({kind:'request',transport:'direct',accepted:true});})},
  {name:'broker',options:brokerPipe(c.fixtureRoot,c.targetHash),factory:()=>io.net.createServer(brokerListener)}];
 const stop=async()=>{
  stopped=true;for(const socket of sockets)socket.destroy();
  if(writes.size){let timer;await Promise.race([Promise.allSettled([...writes]),new Promise(resolve=>{timer=(io.setTimeout??setTimeout)(resolve,2000);})]);(io.clearTimeout??clearTimeout)(timer);}
  const results=await Promise.allSettled(servers.map(server=>new Promise((resolve,reject)=>{try{server.close(error=>error?reject(error):resolve());}catch(error){reject(error);}})));
  if(results.some(r=>r.status==='rejected')||pending.size)failed=true;
  emit({kind:'stopped',...inventory()});return inventory();
 };
 try{
  for(const definition of definitions){const server=definition.factory();servers.push(server);server.on('error',()=>{failed=true;emit({kind:'service-error',resource:definition.name});});
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(definition.options,resolve);});
   emit({kind:'ready',resource:definition.name,fixtureRoot:c.fixtureRoot,targetHash:c.targetHash,networkPlanHash:networkPlanHash(c.networkPlan)});
  }
 }catch(error){await stop();throw error;}
 const observe=async(name)=>{
  if(!['allowed','denied','direct','broker'].includes(name))throw Error('Fixed service observation only');
  const endpoint=name==='allowed'?'http://localhost:18471/allowed':name==='denied'?'http://127.0.0.1:18472/denied':name==='direct'?`tcp://${c.networkPlan.directTcp.host}:${c.networkPlan.directTcp.port}`:brokerPipe(c.fixtureRoot,c.targetHash);
  const available=await new Promise(resolve=>{
   let complete=false,request,timer;const finish=value=>{if(complete)return;complete=true;(io.clearTimeout??clearTimeout)(timer);request?.destroy();resolve(value);};
   timer=(io.setTimeout??setTimeout)(()=>finish(false),2000);
   try{
    if(name==='broker'||name==='direct'){request=io.net.connect(name==='broker'?{path:endpoint}:{host:c.networkPlan.directTcp.host,port:c.networkPlan.directTcp.port});request.on('error',()=>finish(false));request.on('connect',()=>finish(true));}
    else{request=io.http.request(endpoint,{method:'GET'},response=>{let body='';response.on('data',chunk=>{body+=chunk.toString('utf8');if(body.length>4096)finish(false);});response.on('error',()=>finish(false));response.on('end',()=>finish(response.statusCode===200&&body==='OUROBOROS_ENDPOINT_V1'));});request.on('error',()=>finish(false));request.end();}
   }catch{finish(false);}
  });
  const proof={kind:'availability',endpoint,fixtureRoot:c.fixtureRoot,targetHash:c.targetHash,serviceGeneration:generation,networkPlanHash:networkPlanHash(c.networkPlan),actualAttempt:true,available:available&&!failed&&!stopped,observedFromMs:startedAt,availableThroughMs:now()};emit(proof);return proof;
 };
 return {inventory,stop,observe};
}
export async function main(argv,io,stdin) {
 if(argv.length!==4)throw Error('Fixed endpoint identity and approved network plan required');const[fixtureRoot,targetHash,executionId,encodedPlan]=argv;
 const service=await startControlledEndpoints({fixtureRoot,targetHash,executionId,networkPlan:JSON.parse(encodedPlan)},io);
 let bytes='',stopping=false;
 stdin.on('data',chunk=>{bytes+=chunk.toString('utf8');if(bytes.length>4096){if(!stopping){stopping=true;void service.stop();}return;}let newline;while((newline=bytes.indexOf('\n'))>=0){const command=bytes.slice(0,newline);bytes=bytes.slice(newline+1);if(command==='inventory'||command==='reconcile')io.emit({schemaVersion:1,kind:'inventory',...service.inventory()});else if(['observe-allowed','observe-denied','observe-direct','observe-broker'].includes(command)&&!stopping){void service.observe(command.slice(8)).catch(()=>io.emit({schemaVersion:1,kind:'observation-failed',executionId,generation:executionId}));}else if(command==='stop'&&!stopping){stopping=true;void service.stop();}else{io.emit({schemaVersion:1,kind:'invalid-control',executionId,generation:executionId});}}});
 stdin.on('end',()=>{if(!stopping){stopping=true;void service.stop();}});
 return service;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let timer=setTimeout(()=>{process.stderr.write('ENDPOINT_DEADLINE\n');process.exitCode=17;process.stdin.destroy();},60000);
 main(process.argv.slice(2),{fs,http,net,emit:value=>{process.stdout.write(JSON.stringify(value)+'\n');if(value.kind==='stopped')clearTimeout(timer);}},process.stdin).catch(()=>{clearTimeout(timer);process.stderr.write('ENDPOINT_FAILED\n');process.exitCode=17;});
}
