// Protected entry point: import is passive; production execution verifies the
// actual controller/source dependency pins before loading its control client.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadControllerResource(argv, io) {
 if(argv.length!==1)throw Error('FIXED_CONTROLLER_CONFIGURATION_REQUIRED');
 const config=JSON.parse(argv[0]);
 if(config.controllerVersion!==1||!Array.isArray(config.dependencies)||config.dependencies.length>64||!config.module||!config.helper)throw Error('INVALID_CONTROLLER_CONFIGURATION');
 const root=win32.resolve(win32.dirname(config.module.path),'../..');
 if(win32.normalize(config.module.path).toLowerCase()!==win32.join(root,'src','qualification','disposable-controller.ts').toLowerCase())throw Error('FIXED_CONTROLLER_MODULE_REQUIRED');
 const required=['src/runtime/supervisor.ts','src/runtime/qualification-observer.ts','src/contracts/execution.ts','src/contracts/qualification-observation.ts','src/contracts/common.ts','package.json','package-lock.json'].map(path=>win32.join(root,path).toLowerCase()).sort();
 if(JSON.stringify(config.dependencies.map(pin=>win32.normalize(pin.path).toLowerCase()).sort())!==JSON.stringify(required))throw Error('CONTROLLER_DEPENDENCY_PINS_REQUIRED');
 for(const pin of [config.module,config.helper,...config.dependencies]){
  if(typeof pin.path!=='string'||!win32.isAbsolute(pin.path)||pin.path.includes('\0')||typeof pin.sha256!=='string'||!/^[a-f0-9]{64}$/.test(pin.sha256)||createHash('sha256').update(io.readFile(pin.path)).digest('hex')!==pin.sha256)throw Error('CONTROLLER_RESOURCE_CHANGED');
 }
 const module=await io.importModule(pathToFileURL(config.module.path).href);
 return module.serveDisposableController(config,io.channel,{env:io.env});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const channel={write:bytes=>{if(!process.stdout.write(bytes))throw Error('CONTROLLER_OUTPUT_BACKPRESSURE');},onData:fn=>{process.stdin.on('data',fn);return()=>process.stdin.off('data',fn);},onEnd:fn=>{process.stdin.on('end',fn);return()=>process.stdin.off('end',fn);}};
 loadControllerResource(process.argv.slice(2),{readFile:readFileSync,importModule:url=>import(url),channel,env:process.env}).catch(()=>{process.stderr.write('DISPOSABLE_CONTROLLER_FAILED\n');process.exitCode=17;process.stdin.destroy();});
}
