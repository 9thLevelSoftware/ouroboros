// Fixed qualification operations. Importing the resource performs no effects.
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

const surfaces=['plugins','plugin-contributions','browser-native','browser-cdp','computer','mcp-ordinary','mcp-managed-cloud','mcp-plugin','remote-control','hooks','legacy-notify','apps','web'];
const envKeys=['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'];
function rootChecked(root){if(typeof root!=='string'||!/^\w:\\/.test(root)||root.includes('/')||root.slice(2).includes(':')||win32.normalize(root)!==root||root.split('\\').slice(1).some(part=>!part||/[. ]$|[<>"|?*\x00-\x1f]/.test(part)))throw Error('Fixed disposable root required');return root;}
export async function runActivity(argv,io){
 if(!Array.isArray(argv)||argv.length<2||argv.length>3)throw Error('Fixed activity arguments required');
 const[mode,rawRoot,surface]=argv,root=rootChecked(rawRoot);
 if(mode==='allowed_edit'&&argv.length===2){await io.fs.writeFile(win32.join(root,'workspace','qualification-edit.txt'),'QUALIFIED_EDIT\r\n');io.emit({kind:'session-activity',operation:mode,completed:true});return;}
 if(['subscription','lifecycle'].includes(mode)&&argv.length===2){io.emit({kind:'session-activity',operation:mode,completed:true});return;}
 if(mode==='activate'&&argv.length===3&&surfaces.includes(surface)){await io.fs.appendFile(win32.join(root,'canaries',surface+'.log'),'ACTIVATED\n');io.emit({kind:'session-canary',surface});return;}
 if(mode==='detached'&&argv.length===2){
  const child=io.spawn(io.execPath,['--preserve-symlinks-main',io.resourcePath,'descendant',root],{detached:true,stdio:'ignore',windowsHide:true,shell:false,env:{...io.env}});
  if(!Number.isSafeInteger(child.pid)||child.pid<=0)throw Error('Descendant creation unavailable');child.unref();io.emit({kind:'session-activity',operation:mode,descendantPid:child.pid});return;
 }
 if(['foreground','descendant'].includes(mode)&&argv.length===2){
  if(!Number.isSafeInteger(io.pid)||io.pid<=0)throw Error('Process identity unavailable');let sequence=0,stopped=false;
  const pulse=async()=>{if(!stopped)await io.fs.appendFile(win32.join(root,'heartbeat.txt'),`${io.pid}:${mode}:${++sequence}\n`);};
  // The initial actual write precedes readiness. Subsequent writes independently
  // establish activity; the controller never trusts this readiness record alone.
  await pulse();io.emit({kind:'session-activity',operation:mode,phase:'ready',pid:io.pid});
  const timer=io.setInterval(()=>pulse().catch(()=>{stopped=true;io.clearInterval(timer);}),100);
  io.setTimeout(()=>{stopped=true;io.clearInterval(timer);},30000);return;
 }
 throw Error('Unknown fixed activity operation');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const env=Object.fromEntries(envKeys.filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
 runActivity(process.argv.slice(2),{fs,spawn,pid:process.pid,execPath:process.execPath,resourcePath:process.argv[1],env,setInterval,clearInterval,setTimeout,emit:value=>process.stdout.write(JSON.stringify(value)+'\n')}).catch(()=>{process.stderr.write('SESSION_ACTIVITY_FAILED\n');process.exitCode=17;});
}
