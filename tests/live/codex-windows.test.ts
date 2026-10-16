import { expect, it } from 'vitest';
import { startupBlockers, REQUIRED_CODEX_WINDOWS_PROBES } from '../../src/qualification/probes.ts';

// Excluded by the default project. This gate has no provider/process/network
// action: enabling Vitest cannot bypass the concrete CLI manifest review.
it('native_live_batch_requires_reviewed_startup_authority', () => {
 expect(startupBlockers()).toEqual([]);
 expect(REQUIRED_CODEX_WINDOWS_PROBES.every(probe => !!probe.id)).toBe(true);
});
