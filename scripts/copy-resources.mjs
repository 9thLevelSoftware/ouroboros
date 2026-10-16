import { copyFile, mkdir } from 'node:fs/promises';

const destination = new URL('../dist/store/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL('../src/store/schema.sql', import.meta.url), new URL('schema.sql', destination));
