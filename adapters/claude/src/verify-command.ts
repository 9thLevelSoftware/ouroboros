import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';

export type SrtPolicy = { readRoots:string[]; writeRoots:string[]; deniedSensitiveRoots:string[];
  allowedDomains:string[]; deniedDomains:string[]; seccompPath:string };
/** Generated settings are explicit and controller-owned. SRT home defaults and raw -c mode are never selected. */
export function controllerSettings(policy:SrtPolicy) {
  for(const path of [...policy.readRoots,...policy.writeRoots,...policy.deniedSensitiveRoots,policy.seccompPath]) {
    if(!posix.isAbsolute(path)||path.includes('\0')||path.split('/').includes('..'))throw Error('Absolute fixed Linux policy paths required');
  }
  const contains=(path:string,root:string)=>{
    const relative=posix.relative(root,path);
    return relative===''||(!relative.startsWith('../')&&relative!=='..'&&!posix.isAbsolute(relative));
  };
  if(policy.readRoots.some(read=>policy.deniedSensitiveRoots.some(denied=>contains(read,denied)||contains(denied,read)))) {
    throw Error('Read grants overlap denied sensitive roots');
  }
  if(!policy.deniedSensitiveRoots.includes('/sys/fs/cgroup')||!policy.deniedSensitiveRoots.some(path=>path==='/run'||path.startsWith('/run/')))throw Error('Cgroups and broker socket paths must be denied');
  return {network:{allowedDomains:policy.allowedDomains,deniedDomains:policy.deniedDomains,strictAllowlist:true,
      allowLocalBinding:false,allowAllUnixSockets:false},
    filesystem:{denyRead:[{path:'/',literal:true}],allowRead:policy.readRoots.map(path=>({path,literal:true})),
      allowWrite:policy.writeRoots.map(path=>({path,literal:true})),denyWrite:policy.deniedSensitiveRoots.map(path=>({path,literal:true})),disabled:false},
    bwrapPath:'/usr/bin/bwrap',socatPath:'/usr/bin/socat',seccomp:{applyPath:policy.seccompPath}};
}
/** Fail closed independently of SRT's missing-seccomp warning/fallback. Resolver must bind actual bytes before dispatch. */
export async function verifyControllerSettings(file:string,expectedHash:string,policy:SrtPolicy):Promise<boolean> {
  if(!posix.isAbsolute(file)||!/^([a-f0-9]{64})$/.test(expectedHash))return false;
  try {
    const bytes=await readFile(file);if(bytes.length>65536||createHash('sha256').update(bytes).digest('hex')!==expectedHash)return false;
    const expected=controllerSettings(policy);if(JSON.stringify(JSON.parse(bytes.toString('utf8')))!==JSON.stringify(expected))return false;
    await Promise.all(['/usr/bin/bwrap','/usr/bin/socat','/usr/bin/rg',policy.seccompPath].map(path=>access(path,constants.X_OK)));
    return true;
  }catch{return false;}
}
