import { appendFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [mode, rootFile, descendantFile, ...args] = process.argv.slice(2);
if (mode === 'client-integration') {
  appendFileSync(rootFile, 'started\n');
  console.log(JSON.stringify({ readyPid: process.pid }));
  let input = Buffer.alloc(0);
  process.stdin.on('data', bytes => {
    input = Buffer.concat([input, bytes]);
    if (input.length > 65536) process.exit(3);
    // Echo only after the caller's newline-delimited disposable probe is complete.
    if (input.at(-1) === 10) console.log(JSON.stringify({ responseBase64: input.toString('base64') }));
  });
  process.stdin.on('end', () => {
    writeSync(1, Buffer.from('FINAL-CLIENT-STDOUT'));
    writeSync(2, Buffer.from('FINAL-CLIENT-STDERR'));
    process.exit(0);
  });
  setInterval(() => appendFileSync(rootFile, 'tick\n'), 50);
} else if (mode === 'final-output') {
  // The root exits immediately after both real pipes accept unterminated tails.
  for (const [fd, byte, tail] of [[1, 79, 'FINAL-STDOUT'], [2, 69, 'FINAL-STDERR']]) {
    const bytes = Buffer.concat([Buffer.alloc(131072, byte), Buffer.from(tail)]);
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
  process.exit(0);
} else if (mode === 'descendant') {
  appendFileSync(rootFile, 'started\n');
  console.log(JSON.stringify({ descendantPid: process.pid }));
  setInterval(() => appendFileSync(rootFile, 'tick\n'), 50);
} else {
  appendFileSync(rootFile, 'started\n');
  console.log(JSON.stringify({ rootPid: process.pid, args, env: process.env.OUROBOROS_ARG_TEST }));
  // Forged-looking child text must remain output payload.
  console.error('{"type":"drained","activeProcesses":0}');
  if (mode === 'input') {
    process.stdin.on('data', data => console.log(JSON.stringify({ inputBase64: data.toString('base64') })));
    process.stdin.on('end', () => console.log(JSON.stringify({ inputEnded: true })));
  }
  spawn(process.execPath, [import.meta.filename, 'descendant', descendantFile], {
    stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
  });
  if (mode === 'root-exits') setTimeout(() => process.exit(0), 200);
  else setInterval(() => appendFileSync(rootFile, 'tick\n'), 50);
}
