import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { codexAdapterSourceHash, CODEX_ADAPTER_SOURCES } from '../src/qualification/codex-windows.ts';

it('adapter target identity changes when admission or metadata implementation bytes change',()=>{
  const root=mkdtempSync(join(tmpdir(),'ouroboros-adapter-identity-'));
  for(const path of CODEX_ADAPTER_SOURCES){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),readFileSync(join(process.cwd(),path)));}
  const before=codexAdapterSourceHash(root);
  for(const path of ['src/qualification/codex-startup-authority.ts','src/providers/codex/startup-metadata.ts']){
    writeFileSync(join(root,path),`simulated changed module ${path}`);expect(codexAdapterSourceHash(root)).not.toBe(before);
    writeFileSync(join(root,path),readFileSync(join(process.cwd(),path)));
  }
  // Independently derive the expected digest from the full declared source record.
  const records=CODEX_ADAPTER_SOURCES.map(path=>({path,sha256:createHash('sha256').update(readFileSync(join(root,path))).digest('hex')}));
  expect(before).toBe(createHash('sha256').update(JSON.stringify(records)).digest('hex'));
});
