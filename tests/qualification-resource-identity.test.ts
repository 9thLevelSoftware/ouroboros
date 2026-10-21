import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import * as qualification from '../src/qualification/codex-windows.ts';

it('binds each protected campaign resource byte to the controller target identity', () => {
  const api = qualification as unknown as {
    QUALIFICATION_RESOURCE_PATHS: readonly string[];
    qualificationControllerSourceHash(root: string): string;
  };
  expect(api.QUALIFICATION_RESOURCE_PATHS).toEqual(expect.arrayContaining([
    'tests/fixtures/boundary/campaign-boundary-driver.mjs',
    'tests/fixtures/boundary/controlled-endpoint.mjs',
  ]));
  const root = mkdtempSync(join(tmpdir(), 'ouroboros-campaign-identity-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'controller.ts'), 'fixed controller bytes');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'package-lock.json'), '{}');
  for (const path of api.QUALIFICATION_RESOURCE_PATHS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(join(process.cwd(), path)));
  }
  const before = api.qualificationControllerSourceHash(root);
  const records = qualification.controllerSources(root).map(path => ({
    path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
  }));
  expect(before).toBe(createHash('sha256').update(JSON.stringify(records)).digest('hex'));
  for (const path of api.QUALIFICATION_RESOURCE_PATHS) {
    const original = readFileSync(join(root, path));
    writeFileSync(join(root, path), Buffer.concat([original, Buffer.from('\n// changed resource\n')]));
    expect(api.qualificationControllerSourceHash(root)).not.toBe(before);
    writeFileSync(join(root, path), original);
  }
});

it('invalidates adapter identity when launch validation, compatibility controls or expected dependency resolution changes',()=>{
 const root=mkdtempSync(join(tmpdir(),'ouroboros-launch-identity-'));
 for(const path of qualification.CODEX_ADAPTER_SOURCES){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),`fixed ${path}`);}
 const before=qualification.codexAdapterSourceHash(root);
 const protectedPaths=['src/providers/codex/launch-config.ts','src/runtime/compatibility.ts','package.json','package-lock.json'];
 for(const path of protectedPaths){
  const original=readFileSync(join(root,path));writeFileSync(join(root,path),Buffer.concat([original,Buffer.from('\nchanged') ]));
  expect(qualification.codexAdapterSourceHash(root)).not.toBe(before);writeFileSync(join(root,path),original);
 }
});
