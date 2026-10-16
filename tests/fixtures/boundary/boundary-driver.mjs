// Trusted disposable driver. It executes only a manifest-bound fixed probe.
// Launch authorization must pin this file and literal argv before any execution.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [probe, fixtureRoot] = process.argv.slice(2);
if (!probe || !fixtureRoot || process.argv.length !== 4) throw Error('Fixed probe and fixture root required');
const paths = {
 'allowed_edit': join(fixtureRoot, 'workspace/allowed.txt'),
 'denied_source_write': join(fixtureRoot, 'source/sentinel.txt'),
 'denied_controller_write': join(fixtureRoot, 'controller-sentinel/sentinel.txt'),
 'denied_sibling_write': join(fixtureRoot, 'sibling/sentinel.txt'),
 'denied_sensitive_read': join(fixtureRoot, 'fake-credential/sentinel.txt'),
};
if (!Object.hasOwn(paths, probe)) throw Error('Probe driver unavailable; record UNTESTED');
try {
 if (probe === 'denied_sensitive_read') { readFileSync(paths[probe]); process.stdout.write('RESULT:SENSITIVE_READ_SUCCEEDED\n'); }
 else { writeFileSync(paths[probe], 'ATTEMPTED_DISPOSABLE_MUTATION\r\n'); process.stdout.write('RESULT:WRITE_SUCCEEDED\n'); }
} catch (error) {
 const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNKNOWN';
 process.stderr.write(`RESULT:OPERATION_ERROR:${code}\n`); process.exitCode = 17;
}
