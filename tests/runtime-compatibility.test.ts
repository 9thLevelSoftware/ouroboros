import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { supportedNodeVersion, nativeDependencyFailure, codexVersionObservation, installedCodexVersion, runtimeCompatibilityDiagnostic } from '../src/runtime/compatibility.ts';

it.each(['24.0.0','24.20.0','25.1.0','v26.0.0'])('uses the Node capability floor for %s',version=>{expect(supportedNodeVersion(version)).toBe(true);});
it.each(['23.99.0','garbage','24','9007199254740993.0.0'])('refuses an unsupported or malformed Node observation %s',version=>{expect(supportedNodeVersion(version)).toBe(false);});
it('keeps safe version observations independent of admission',()=>{
  expect(codexVersionObservation('codex/0.163.0 Windows')).toBe('0.163.0');expect(codexVersionObservation('codex/1.200.0')).toBe('1.200.0');expect(codexVersionObservation('PRIVATE_PAYLOAD')).toBe('unobserved');
});
it('reads passive installed metadata and labels unavailable metadata without a process probe',()=>{
  const root=mkdtempSync(join(tmpdir(),'ouroboros-runtime-metadata-'));const bin=join(root,'vendor','bin');mkdirSync(bin,{recursive:true});writeFileSync(join(root,'package.json'),JSON.stringify({name:'@openai/codex-win32-x64',version:'0.163.0'}));
  expect(installedCodexVersion(join(bin,'codex.exe'))).toBe('0.163.0');writeFileSync(join(root,'package.json'),JSON.stringify({name:'unrelated',version:'0.163.0'}));expect(installedCodexVersion(join(bin,'codex.exe'))).toBe('unobserved');
});
it.each([{code:'ERR_DLOPEN_FAILED',message:'PRIVATE_ABI_PATH'},{message:'compiled against a different Node.js version using NODE_MODULE_VERSION 137'},{message:'Could not locate the bindings file'}])('classifies native ABI/load errors with a rebuild action',error=>{
  const result=nativeDependencyFailure(error);expect(result).toMatchObject({code:'DEPENDENCY_REBUILD_REQUIRED'});expect(result?.message).toContain('npm rebuild better-sqlite3');expect(result?.message).not.toContain('PRIVATE');expect(nativeDependencyFailure(Error('unrelated database error'))).toBeUndefined();
});

it('compatibility diagnostics distinguish capabilities, executable changes, and policy drift',()=>{expect(runtimeCompatibilityDiagnostic('NODE_CAPABILITY_UNSUPPORTED')).toContain('Node 24');expect(runtimeCompatibilityDiagnostic('EXECUTABLE_CHANGED_DURING_RUN')).toContain('SHA-256');expect(runtimeCompatibilityDiagnostic('POLICY_CONTROLS_CHANGED')).toContain('review the changed controls');});
