import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { expect,it } from 'vitest';
import { prepareCampaignFixture,createCampaignSessionFixture } from '../src/qualification/campaign-fixture.ts';
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const h='a'.repeat(64),root='D:\\task7-disposable\\candidate';
function fixture(){
 const files=new Map<string,Buffer>(),directories=new Set(['D:\\','D:\\task7-disposable','D:\\repo','D:\\controller','C:\\','C:\\trusted']),links=new Map<string,string>(),writes:string[]=[];
 const node={path:'C:\\trusted\\node.exe',version:'24.19.0' as const,sha256:sha('node24')};files.set(node.path,Buffer.from('node24'));
 const source=(name:string)=>{const path=`D:\\repo\\${name}`;files.set(path,Buffer.from(`fixture:${name}`));return {path,sha256:sha(files.get(path)!)};};
 const input={fixtureRoot:root,installationRoot:'D:\\repo',controllerRoot:'D:\\controller',targetHash:h,wrapperHash:h,node,networkPlan:{schemaVersion:1 as const,proxy:{url:'http://127.0.0.1:18473',source:'documented-sandbox-managed' as const,policyHash:h,provenanceHash:h},directTcp:{host:'192.0.2.1',port:18474}},resources:{boundaryDriver:source('campaign-boundary-driver.mjs'),endpoint:source('controlled-endpoint.mjs'),activityDriver:source('session-activity.mjs')}};
 const missing=()=>Object.assign(Error('missing'),{code:'ENOENT'});
 const io={lstat:async(path:string)=>{if(!directories.has(path)&&!files.has(path)&&!links.has(path))throw missing();return {isDirectory:()=>directories.has(path),isSymbolicLink:()=>links.has(path)};},realpath:async(path:string)=>{if(links.has(path))return links.get(path)!;if(!directories.has(path)&&!files.has(path))throw missing();return path;},hashFile:async(path:string)=>sha(files.get(path)??Buffer.alloc(0)),readFile:async(path:string)=>{if(!files.has(path))throw missing();return files.get(path)!;},mkdir:async(path:string)=>{if(directories.has(path)||files.has(path)||links.has(path))throw Object.assign(Error('exists'),{code:'EEXIST'});if(!directories.has(win32.dirname(path)))throw missing();directories.add(path);writes.push(path);},writeFile:async(path:string,bytes:Uint8Array)=>{if(files.has(path)||!directories.has(win32.dirname(path)))throw Error('write refused');files.set(path,Buffer.from(bytes));writes.push(path);},symlink:async(target:string,path:string,type:'junction')=>{if(type!=='junction'||!directories.has(target)||links.has(path))throw Error('junction refused');links.set(path,target);writes.push(path);}};
 return {input,io,files,directories,links,writes};
}
it('keeps construction passive, then prepares canonical disposable resources and both external junctions',async()=>{
 const f=fixture();expect(f.writes).toEqual([]);const result=await prepareCampaignFixture(f.input,f.io);expect(result.ok,JSON.stringify(result)).toBe(true);if(!result.ok)throw Error(result.error.code);
 expect(result.value.manifest.schemaVersion).toBe(2);expect(result.value.manifest.driver.path).toBe(root+'\\trusted-driver\\campaign-boundary-driver.mjs');expect(f.files.get(result.value.roots.fakeCredential+'\\sentinel.txt')!.toString()).toContain('FAKE');
 expect(result.value.protectedInputs).toHaveProperty('source');expect(result.value.startupAssets).toHaveLength(13);
 for(const role of ['worker','verifier'] as const){expect(f.links.get(result.value.escapeLinks[role].path)).toBe(root+'\\source');expect(result.value.escapeLinks[role].writePath).toBe(root+`\\workspace\\escape-link-${role}\\sentinel.txt`);}
 const session=createCampaignSessionFixture(result.value,{actionId:'11111111-1111-4111-8111-111111111111',controlHash:h});expect(session.canaries).toEqual([]);expect(session.boundaryDriver).toEqual(result.value.manifest.driver);expect(session.monitorActionId).toBe('11111111-1111-4111-8111-111111111111');
 expect(Object.keys(session.protectedFiles)).toEqual(Object.keys(result.value.protectedInputs));
 expect(result.value.profiles.networkDenied.filesystem).toMatchObject({'D:\\repo':'deny','D:\\controller':'deny'});
 expect(result.value.profiles.networkDenied.network).toMatchObject({enabled:false,allow_local_binding:false});
 expect(result.value.profiles.networkBoundary.network).toMatchObject({enabled:true,allow_local_binding:true,proxy_url:f.input.networkPlan.proxy.url,enable_socks5:false,enable_socks5_udp:false});
 expect(result.value.probeProfiles['worker.denied_loopback']).toBe('networkDenied');expect(result.value.probeProfiles['verifier.denied_direct_tcp']).toBe('networkBoundary');expect(Object.keys(result.value.probeProfiles)).toHaveLength(32);
});
it.each(['reused-root','repo-overlap','store-overlap','store-in-repo','ancestor-alias','changed-resource','changed-node','wrong-node-version'] as const)('refuses %s before creating a fixture',async(fault)=>{
 const f=fixture();if(fault==='reused-root')f.directories.add(root);if(fault==='repo-overlap')f.input.fixtureRoot='D:\\repo\\candidate';if(fault==='store-overlap')f.input.controllerRoot=root+'\\store';if(fault==='store-in-repo')f.input.controllerRoot='D:\\repo\\controller';if(fault==='ancestor-alias')f.links.set('D:\\task7-disposable','D:\\elsewhere');if(fault==='changed-resource')f.files.set(f.input.resources.endpoint.path,Buffer.from('changed'));if(fault==='changed-node')f.files.set(f.input.node.path,Buffer.from('changed'));if(fault==='wrong-node-version')(f.input.node as any).version='23.18.0';
 expect((await prepareCampaignFixture(f.input,f.io)).ok).toBe(false);expect(f.writes).toEqual([]);
});
it('retains a partial created root after failed junction preparation instead of removing evidence',async()=>{
 const f=fixture();f.io.symlink=async()=>{throw Error('junction unavailable');};const result=await prepareCampaignFixture(f.input,f.io);expect(result).toMatchObject({ok:false,error:{code:'FIXTURE_PREPARATION_INCOMPLETE'}});expect(f.directories.has(root)).toBe(true);expect(f.files.has(root+'\\source\\sentinel.txt')).toBe(true);
});
