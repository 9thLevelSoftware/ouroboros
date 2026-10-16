import { defineConfig } from 'vitest/config';
// Files that need win32 paths, Job Objects or the built Windows helper. On Linux they fail and some write
// backslash-named fixture files into the repo root, so non-Windows runs exclude them. Windows CI runs everything.
export const WINDOWS_ONLY = [
 'tests/qualification-ledger.test.ts', 'tests/qualification-verifier.test.ts', 'tests/supervisor-native.integration.test.ts',
 'tests/supervisor-protocol.test.ts', 'tests/task1-doctor-regressions.test.ts', 'tests/task7-stage1-review-regressions.test.ts',
];
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['tests/live/**', ...WINDOWS_ONLY] } });
