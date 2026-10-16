// Finite heartbeat for an explicitly owned foreground or descendant case.
import { appendFileSync } from 'node:fs';
const [path, mode] = process.argv.slice(2);
if (!path || !['foreground', 'descendant', 'unrelated'].includes(mode) || process.argv.length !== 4) throw Error('Fixed owned heartbeat arguments required');
const timer = setInterval(() => { appendFileSync(path, `${process.pid}:${mode}\n`); process.stdout.write('HEARTBEAT\n'); }, 100);
setTimeout(() => { clearInterval(timer); }, 30000);
